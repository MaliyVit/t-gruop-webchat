import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db.js";
import { config } from "./config.js";
import { requireOperator, requireIntegrationAuth } from "./auth.js";
import {
  STATUSES,
  MESSAGE_COLUMNS,
  toPublicMessage,
  startOrContinue,
  postVisitorMessage,
  postOperatorMessage,
  updateConversation,
  visitorOwns,
  visitorState,
  activeConversationFor,
  type Patch,
  type Status,
} from "./service.js";
import {
  MAX,
  checkText,
  checkOptionalKey,
  isVisitorId,
  normalizeSourcePage,
  parseId,
} from "./validate.js";

// Public endpoints are rate limited per client address (opt-in per route; the
// plugin is registered with global:false so operator traffic is never throttled).
const WRITE_LIMIT = { config: { rateLimit: { max: config.rateLimit.writePerMinute, timeWindow: "1 minute" } } };
const READ_LIMIT = { config: { rateLimit: { max: config.rateLimit.readPerMinute, timeWindow: "1 minute" } } };

const PAGE_SIZE = 500; // messages per fetch; clients keep paging with ?after=

// The visitor credential: the X-Chat-Visitor-Id header. Every refusal on a
// conversation route is the same 404, so sequential ids reveal nothing.
function visitorCredential(req: FastifyRequest): string | null {
  const value = req.headers["x-chat-visitor-id"];
  return isVisitorId(value) ? value : null;
}

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "conversation not found" });

function parseAfter(value: unknown): number | null {
  if (value === undefined) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok", db: "ok" };
    } catch {
      return reply.code(503).send({ status: "degraded", db: "unreachable" });
    }
  });

  // Public, non-secret widget presentation settings.
  app.get("/api/widget-config", READ_LIMIT, async () => ({
    title: config.widget.title,
    greeting: config.widget.greeting,
    accent: config.widget.accent,
    locale: config.widget.locale,
    max_message_length: MAX.message,
  }));

  // ===== Visitor API (widget) — credential: X-Chat-Visitor-Id =====================

  // Start a conversation, or continue the visitor's active one (see service.ts).
  app.post<{
    Body: { first_message?: unknown; source_page?: unknown; start_new?: unknown; idempotency_key?: unknown };
  }>("/api/visitor/conversations", WRITE_LIMIT, async (req, reply) => {
    const visitorId = visitorCredential(req);
    if (!visitorId) return reply.code(400).send({ error: "a valid X-Chat-Visitor-Id header is required" });
    const body = req.body ?? {};
    const first = checkText("first_message", body.first_message, MAX.message);
    if (!first.ok) return reply.code(400).send({ error: first.error });
    const key = checkOptionalKey("idempotency_key", body.idempotency_key, MAX.idempotencyKey);
    if (key && !key.ok) return reply.code(400).send({ error: key.error });
    if (body.start_new !== undefined && typeof body.start_new !== "boolean") {
      return reply.code(400).send({ error: "start_new must be a boolean" });
    }
    const result = await startOrContinue({
      visitorId,
      firstMessage: first.value,
      sourcePage: normalizeSourcePage(body.source_page),
      startNew: body.start_new === true,
      idempotencyKey: key?.ok ? key.value : null,
      ip: req.ip,
    });
    if (result.kind === "rejected") {
      return reply.code(400).send({
        error: `first_message must be at least ${result.minChars} characters`,
        code: "message_too_short",
        min_chars: result.minChars,
      });
    }
    // Only the fields the widget needs; flags and CRM references stay private.
    const { id, status } = result.conversation;
    return reply.code(result.kind === "created" ? 201 : 200).send({ id, status, continued: result.kind === "continued" });
  });

  // The visitor's current active conversation (used to resume after a reload).
  app.get("/api/visitor/conversation", READ_LIMIT, async (req, reply) => {
    const visitorId = visitorCredential(req);
    if (!visitorId) return reply.code(400).send({ error: "a valid X-Chat-Visitor-Id header is required" });
    return { conversation: await activeConversationFor(visitorId) };
  });

  app.get<{ Params: { id: string } }>("/api/visitor/conversations/:id", READ_LIMIT, async (req, reply) => {
    const id = parseId(req.params.id);
    const visitorId = visitorCredential(req);
    if (!id || !visitorId) return notFound(reply);
    const state = await visitorState(id, visitorId);
    return state ?? notFound(reply);
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/visitor/conversations/:id/messages",
    READ_LIMIT,
    async (req, reply) => {
      const id = parseId(req.params.id);
      const visitorId = visitorCredential(req);
      const after = parseAfter(req.query.after);
      if (!id || !visitorId) return notFound(reply);
      if (after === null) return reply.code(400).send({ error: "after must be a non-negative integer" });
      if (!(await visitorOwns(id, visitorId))) return notFound(reply);
      const { rows } = await pool.query(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id LIMIT ${PAGE_SIZE}`,
        [id, after]
      );
      return rows;
    }
  );

  app.post<{ Params: { id: string }; Body: { body?: unknown; idempotency_key?: unknown } }>(
    "/api/visitor/conversations/:id/messages",
    WRITE_LIMIT,
    async (req, reply) => {
      const id = parseId(req.params.id);
      const visitorId = visitorCredential(req);
      if (!id || !visitorId) return notFound(reply);
      const text = checkText("body", req.body?.body, MAX.message);
      if (!text.ok) return reply.code(400).send({ error: text.error });
      const key = checkOptionalKey("idempotency_key", req.body?.idempotency_key, MAX.idempotencyKey);
      if (key && !key.ok) return reply.code(400).send({ error: key.error });
      const result = await postVisitorMessage(id, visitorId, text.value, key?.ok ? key.value : null);
      if (result.kind === "not_found" || result.kind === "closed") return notFound(reply);
      return reply.code(result.kind === "created" ? 201 : 200).send(toPublicMessage(result.message));
    }
  );

  // ===== Operator API (inbox) — credential: session cookie ========================

  // Inbox, freshest first. `spam`: exclude (default) | include | only.
  app.get<{ Querystring: { status?: string; spam?: string } }>(
    "/api/conversations",
    { preHandler: requireOperator },
    async (req, reply) => {
      const { status } = req.query;
      if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
        return reply.code(400).send({ error: `unknown status '${status}'` });
      }
      const spam = req.query.spam ?? "exclude";
      if (!["exclude", "include", "only"].includes(spam)) {
        return reply.code(400).send({ error: `unknown spam filter '${spam}'` });
      }
      const [list, counts, flagged] = await Promise.all([
        pool.query(
          `SELECT c.id, c.public_id, c.status, c.source_page, c.external_ref, c.suspected_spam, c.spam_reason,
                  c.created_at, c.updated_at,
                  left(last.body, 160) AS last_message,
                  last.sender_type AS last_sender_type,
                  last.created_at AS last_message_at,
                  COALESCE(last.created_at, c.created_at) AS last_activity_at,
                  (SELECT COUNT(*)::int FROM messages m
                    WHERE m.conversation_id = c.id AND m.sender_type = 'visitor'
                      AND m.id > c.operator_seen_message_id) AS unread_count
             FROM conversations c
             LEFT JOIN LATERAL (
               SELECT m.body, m.sender_type, m.created_at FROM messages m
                WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1
             ) last ON true
            WHERE ($1::text IS NULL OR c.status = $1)
              AND ($2 = 'include' OR ($2 = 'only') = c.suspected_spam)
            ORDER BY COALESCE(last.created_at, c.created_at) DESC, c.id DESC
            LIMIT 200`,
          [status ?? null, spam]
        ),
        pool.query(
          `SELECT status AS value, COUNT(*)::int AS count FROM conversations
            WHERE ($1 = 'include' OR ($1 = 'only') = suspected_spam) GROUP BY 1`,
          [spam]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS count FROM conversations
            WHERE suspected_spam AND status IN ('new', 'open', 'waiting')`
        ),
      ]);
      return {
        conversations: list.rows,
        counts_by_status: Object.fromEntries(counts.rows.map((r: { value: string; count: number }) => [r.value, r.count])),
        suspected_spam_count: flagged.rows[0].count as number,
      };
    }
  );

  app.get<{ Params: { id: string } }>("/api/conversations/:id", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(reply);
    const conv = await pool.query(
      `SELECT id, public_id, status, source_page, external_ref, suspected_spam, spam_reason,
              operator_seen_message_id, created_at, updated_at
         FROM conversations WHERE id = $1`,
      [id]
    );
    if (!conv.rowCount) return notFound(reply);
    const messages = await pool.query(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY id`,
      [id]
    );
    return { ...conv.rows[0], messages: messages.rows };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/conversations/:id/messages",
    { preHandler: requireOperator },
    async (req, reply) => {
      const id = parseId(req.params.id);
      const after = parseAfter(req.query.after);
      if (!id) return notFound(reply);
      if (after === null) return reply.code(400).send({ error: "after must be a non-negative integer" });
      const { rows } = await pool.query(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id LIMIT ${PAGE_SIZE}`,
        [id, after]
      );
      if (rows.length === 0) {
        const exists = await pool.query(`SELECT 1 FROM conversations WHERE id = $1`, [id]);
        if (!exists.rowCount) return notFound(reply);
      }
      return rows;
    }
  );

  // Operator reply. Attribution comes from the session, never from the client.
  app.post<{ Params: { id: string }; Body: { body?: unknown; idempotency_key?: unknown } }>(
    "/api/conversations/:id/messages",
    { preHandler: requireOperator, ...WRITE_LIMIT },
    async (req, reply) => {
      const id = parseId(req.params.id);
      if (!id) return notFound(reply);
      const text = checkText("body", req.body?.body, MAX.message);
      if (!text.ok) return reply.code(400).send({ error: text.error });
      const key = checkOptionalKey("idempotency_key", req.body?.idempotency_key, MAX.idempotencyKey);
      if (key && !key.ok) return reply.code(400).send({ error: key.error });
      const result = await postOperatorMessage(id, req.operator!, text.value, key?.ok ? key.value : null);
      if (result.kind === "not_found") return notFound(reply);
      if (result.kind === "closed") {
        return reply.code(409).send({ error: "conversation is closed; reopen it first", status: result.status });
      }
      return reply.code(result.kind === "created" ? 201 : 200).send(toPublicMessage(result.message));
    }
  );

  // Mark read for the shared inbox, up to a message id. Not queue activity.
  app.post<{ Params: { id: string }; Body: { last_message_id?: unknown } }>(
    "/api/conversations/:id/seen",
    { preHandler: requireOperator },
    async (req, reply) => {
      const id = parseId(req.params.id);
      const last = Number(req.body?.last_message_id);
      if (!id) return notFound(reply);
      if (!Number.isSafeInteger(last) || last < 0) {
        return reply.code(400).send({ error: "last_message_id must be a non-negative integer" });
      }
      const { rows } = await pool.query(
        `UPDATE conversations SET operator_seen_message_id = GREATEST(operator_seen_message_id, $2)
          WHERE id = $1 RETURNING id, operator_seen_message_id`,
        [id, last]
      );
      return rows[0] ?? notFound(reply);
    }
  );

  // Status / spam flag / CRM reference. Unknown fields are rejected.
  const parsePatch = (raw: unknown): { patch: Patch } | { error: string } => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "body must be an object" };
    const body = raw as Record<string, unknown>;
    const allowed = ["status", "suspected_spam", "external_ref"];
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unknown.length) return { error: `unknown field '${unknown[0]}'` };
    const patch: Patch = {};
    if ("status" in body) {
      if (typeof body.status !== "string" || !(STATUSES as readonly string[]).includes(body.status)) {
        return { error: `status must be one of ${STATUSES.join(", ")}` };
      }
      patch.status = body.status as Status;
    }
    if ("suspected_spam" in body) {
      if (typeof body.suspected_spam !== "boolean") return { error: "suspected_spam must be a boolean" };
      patch.suspected_spam = body.suspected_spam;
    }
    if ("external_ref" in body) {
      if (body.external_ref === null) patch.external_ref = null;
      else {
        const ref = checkText("external_ref", body.external_ref, MAX.externalRef);
        if (!ref.ok) return { error: ref.error };
        patch.external_ref = ref.value;
      }
    }
    if (Object.keys(patch).length === 0) return { error: "nothing to update" };
    return { patch };
  };

  app.patch<{ Params: { id: string } }>("/api/conversations/:id", { preHandler: requireOperator }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(reply);
    const parsed = parsePatch(req.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const updated = await updateConversation(id, parsed.patch);
    return updated ?? notFound(reply);
  });

  // ===== Integration API (CRM) — bearer INTEGRATION_API_TOKEN or operator session ===
  // Conversations are addressed by their public UUID; internal ids never leave.

  const ENVELOPE_SELECT = `
    SELECT c.public_id AS id, c.status, c.source_page, c.external_ref, c.suspected_spam,
           c.created_at, c.updated_at,
           (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
           (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at
      FROM conversations c`;

  app.get<{ Querystring: { updated_since?: string; limit?: string } }>(
    "/api/integration/conversations",
    { preHandler: requireIntegrationAuth },
    async (req, reply) => {
      const { updated_since } = req.query;
      if (updated_since !== undefined && Number.isNaN(Date.parse(updated_since))) {
        return reply.code(400).send({ error: "updated_since must be an ISO timestamp" });
      }
      const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
      const { rows } = await pool.query(
        `${ENVELOPE_SELECT}
          WHERE ($1::timestamptz IS NULL OR c.updated_at >= $1::timestamptz)
          ORDER BY c.updated_at ASC, c.id ASC LIMIT $2`,
        [updated_since ?? null, limit]
      );
      return {
        conversations: rows,
        count: rows.length,
        next_cursor: rows.length ? rows[rows.length - 1].updated_at : null,
      };
    }
  );

  app.get<{ Params: { publicId: string } }>(
    "/api/integration/conversations/:publicId",
    { preHandler: requireIntegrationAuth },
    async (req, reply) => {
      if (!UUID_RE.test(req.params.publicId)) return reply.code(400).send({ error: "id must be a UUID" });
      const { rows } = await pool.query(`${ENVELOPE_SELECT} WHERE c.public_id = $1`, [req.params.publicId]);
      return rows[0] ?? notFound(reply);
    }
  );

  app.get<{ Params: { publicId: string }; Querystring: { after?: string } }>(
    "/api/integration/conversations/:publicId/messages",
    { preHandler: requireIntegrationAuth },
    async (req, reply) => {
      if (!UUID_RE.test(req.params.publicId)) return reply.code(400).send({ error: "id must be a UUID" });
      const after = parseAfter(req.query.after);
      if (after === null) return reply.code(400).send({ error: "after must be a non-negative integer" });
      const conv = await pool.query(`SELECT id FROM conversations WHERE public_id = $1`, [req.params.publicId]);
      if (!conv.rowCount) return notFound(reply);
      const { rows } = await pool.query(
        `SELECT id, sender_type, sender_name, body, created_at FROM messages
          WHERE conversation_id = $1 AND id > $2 ORDER BY id LIMIT ${PAGE_SIZE}`,
        [conv.rows[0].id, after]
      );
      return rows;
    }
  );

  // Link a conversation to a CRM record and/or change its status.
  app.patch<{ Params: { publicId: string } }>(
    "/api/integration/conversations/:publicId",
    { preHandler: requireIntegrationAuth },
    async (req, reply) => {
      if (!UUID_RE.test(req.params.publicId)) return reply.code(400).send({ error: "id must be a UUID" });
      const parsed = parsePatch(req.body);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      if ("suspected_spam" in parsed.patch) return reply.code(400).send({ error: "unknown field 'suspected_spam'" });
      const conv = await pool.query(`SELECT id FROM conversations WHERE public_id = $1`, [req.params.publicId]);
      if (!conv.rowCount) return notFound(reply);
      await updateConversation(Number(conv.rows[0].id), parsed.patch);
      const { rows } = await pool.query(`${ENVELOPE_SELECT} WHERE c.public_id = $1`, [req.params.publicId]);
      return rows[0];
    }
  );
}
