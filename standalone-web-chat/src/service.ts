// Conversation domain: conversations, messages, ordering and status rules.
// Routes call these functions; they never write the tables directly. Input is
// validated at the edge (routes.ts / validate.ts); results are returned as
// plain objects the caller maps to HTTP.
import { pool } from "./db.js";
import { publish } from "./events.js";
import { config } from "./config.js";
import { assessConversationCreate } from "./spam-guard.js";
import type { Operator } from "./auth.js";

type Row = Record<string, any>;
type PgClient = { query: (sql: string, params?: unknown[]) => Promise<any> };

export const STATUSES = ["new", "open", "waiting", "resolved", "closed"] as const;
export type Status = (typeof STATUSES)[number];

// "closed" lifecycle: operators cannot write into it; a visitor message reopens it.
export const isClosed = (status: string): boolean => status === "resolved" || status === "closed";

// The message fields visitors and the integration API see.
const MESSAGE_FIELDS = ["id", "conversation_id", "sender_type", "sender_name", "body", "created_at"] as const;
export const MESSAGE_COLUMNS = MESSAGE_FIELDS.join(", ");
export const toPublicMessage = (row: Row): Row => Object.fromEntries(MESSAGE_FIELDS.map((f) => [f, row[f]]));

// A visitor message pulls waiting/resolved/closed back to open; an operator
// reply moves a new conversation to open. Caller holds the conversation lock.
async function applyMessageStatus(
  client: PgClient,
  conversationId: number,
  status: string,
  actor: "visitor" | "operator"
): Promise<boolean> {
  let next = status;
  if (actor === "operator" && status === "new") next = "open";
  if (actor === "visitor" && ["waiting", "resolved", "closed"].includes(status)) next = "open";
  await client.query(`UPDATE conversations SET status = $2, updated_at = now() WHERE id = $1`, [conversationId, next]);
  return next !== status;
}

// --- Visitor: start or continue -------------------------------------------------

export type StartInput = {
  visitorId: string;
  firstMessage: string;
  sourcePage: string | null;
  startNew: boolean;
  idempotencyKey: string | null;
  ip: string | undefined;
};

export type StartResult =
  | { kind: "rejected"; minChars: number }
  | { kind: "created" | "continued"; conversation: Row };

const ACTIVE_BASE = `
  SELECT c.id, c.status
    FROM conversations c
    LEFT JOIN LATERAL (
      SELECT m.id AS message_id FROM messages m
       WHERE m.conversation_id = c.id AND m.sender_type = 'visitor'
       ORDER BY m.id DESC LIMIT 1
    ) last_visitor ON true
   WHERE c.visitor_id = $1 AND c.status IN ('new', 'open', 'waiting')
   ORDER BY last_visitor.message_id DESC NULLS LAST, c.id DESC`;
const ACTIVE_SQL = `${ACTIVE_BASE} LIMIT 1`;
const ACTIVE_SQL_LOCKED = `${ACTIVE_BASE} LIMIT 1 FOR UPDATE OF c`;

// Without start_new, the visitor's active conversation is continued instead of
// forking a duplicate on every page reload. Lookup and creation run in one
// transaction behind a per-visitor advisory lock, so racing starts cannot both
// create a row. An idempotency key makes a retried start (lost response) return
// what the first attempt produced.
export async function startOrContinue(input: StartInput): Promise<StartResult> {
  const client = await pool.connect();
  let undoSpam: (() => void) | null = null;
  let events: Array<() => void> = [];
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`chat|${input.visitorId}`]);

    if (input.idempotencyKey) {
      const dupe = await client.query(
        `SELECT c.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.visitor_id = $1 AND m.idempotency_key = $2 ORDER BY m.id LIMIT 1`,
        [input.visitorId, input.idempotencyKey]
      );
      if (dupe.rowCount) {
        await client.query("COMMIT");
        return { kind: "continued", conversation: dupe.rows[0] };
      }
    }

    let conversation: Row | null = null;
    let kind: "created" | "continued" = "created";

    if (!input.startNew) {
      const active = await client.query(ACTIVE_SQL_LOCKED, [input.visitorId]);
      if (active.rowCount) {
        const { id, status } = active.rows[0];
        await client.query(
          `INSERT INTO messages (conversation_id, sender_type, body, idempotency_key)
           VALUES ($1, 'visitor', $2, $3)`,
          [id, input.firstMessage, input.idempotencyKey]
        );
        const changed = await applyMessageStatus(client, Number(id), status, "visitor");
        kind = "continued";
        const convId = Number(id);
        events = [
          ...(changed ? [() => publish({ type: "meta", conversationId: convId })] : []),
          () => publish({ type: "message", conversationId: convId }),
        ];
        conversation = (await client.query(`SELECT * FROM conversations WHERE id = $1`, [id])).rows[0];
      }
    }

    if (!conversation) {
      // Flood protection runs only where a conversation is really created, so
      // continuing a thread or replaying a start is never counted or rejected.
      const verdict = assessConversationCreate(config.spam, input.ip, input.firstMessage, Date.now());
      undoSpam = verdict.undo;
      if (verdict.decision === "reject") {
        await client.query("ROLLBACK");
        return { kind: "rejected", minChars: verdict.minChars };
      }
      const flagged = verdict.decision === "flag";
      const created = await client.query(
        `INSERT INTO conversations (visitor_id, source_page, suspected_spam, spam_reason)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [input.visitorId, input.sourcePage, flagged, flagged ? verdict.reason : null]
      );
      conversation = created.rows[0];
      await client.query(
        `INSERT INTO messages (conversation_id, sender_type, body, idempotency_key)
         VALUES ($1, 'visitor', $2, $3)`,
        [conversation!.id, input.firstMessage, input.idempotencyKey]
      );
      const convId = Number(conversation!.id);
      events = [
        () => publish({ type: "meta", conversationId: convId }),
        () => publish({ type: "message", conversationId: convId }),
      ];
    }

    await client.query("COMMIT");
    undoSpam = null; // persisted: the flood record stands
    events.forEach((fire) => fire());
    return { kind, conversation: conversation! };
  } catch (err) {
    undoSpam?.();
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// --- Messages ---------------------------------------------------------------------

export type PostResult =
  | { kind: "not_found" }
  | { kind: "closed"; status: string }
  | { kind: "created" | "duplicate"; message: Row };

async function persistMessage(
  conversationId: number,
  body: string,
  idempotencyKey: string | null,
  actor: { type: "visitor"; visitorId: string } | { type: "operator"; operator: Operator }
): Promise<PostResult & { statusChanged?: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conv = await client.query(`SELECT id, status, visitor_id FROM conversations WHERE id = $1 FOR UPDATE`, [
      conversationId,
    ]);
    // The visitor credential is checked under the same lock, before the
    // idempotency lookup, so a refused credential cannot read anything back.
    if (!conv.rowCount || (actor.type === "visitor" && conv.rows[0].visitor_id !== actor.visitorId)) {
      await client.query("ROLLBACK");
      return { kind: "not_found" };
    }
    const status: string = conv.rows[0].status;

    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT * FROM messages WHERE conversation_id = $1 AND idempotency_key = $2`,
        [conversationId, idempotencyKey]
      );
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return { kind: "duplicate", message: existing.rows[0] };
      }
    }
    if (actor.type === "operator" && isClosed(status)) {
      await client.query("ROLLBACK");
      return { kind: "closed", status };
    }

    const operator = actor.type === "operator" ? actor.operator : null;
    const msg = await client.query(
      `INSERT INTO messages (conversation_id, sender_type, sender_name, sender_operator_id, body, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [conversationId, actor.type, operator?.display_name ?? null, operator?.id ?? null, body, idempotencyKey]
    );
    const statusChanged = await applyMessageStatus(client, conversationId, status, actor.type);
    await client.query("COMMIT");
    return { kind: "created", message: msg.rows[0], statusChanged };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function postVisitorMessage(
  conversationId: number,
  visitorId: string,
  body: string,
  idempotencyKey: string | null
): Promise<PostResult> {
  const result = await persistMessage(conversationId, body, idempotencyKey, { type: "visitor", visitorId });
  if (result.kind === "created") {
    if (result.statusChanged) publish({ type: "meta", conversationId });
    publish({ type: "message", conversationId });
  }
  return result;
}

export async function postOperatorMessage(
  conversationId: number,
  operator: Operator,
  body: string,
  idempotencyKey: string | null
): Promise<PostResult> {
  const result = await persistMessage(conversationId, body, idempotencyKey, { type: "operator", operator });
  if (result.kind === "created") {
    if (result.statusChanged) publish({ type: "meta", conversationId });
    publish({ type: "message", conversationId });
  }
  return result;
}

// --- Visitor reads ---------------------------------------------------------------

export async function visitorOwns(conversationId: number, visitorId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`SELECT 1 FROM conversations WHERE id = $1 AND visitor_id = $2`, [
    conversationId,
    visitorId,
  ]);
  return (rowCount ?? 0) > 0;
}

// What the widget needs to draw its header: lifecycle and who is answering.
export async function visitorState(conversationId: number, visitorId: string): Promise<Row | null> {
  const { rows } = await pool.query(
    `SELECT c.id, c.status,
            (SELECT m.sender_name FROM messages m
              WHERE m.conversation_id = c.id AND m.sender_type = 'operator'
              ORDER BY m.id DESC LIMIT 1) AS operator_name
       FROM conversations c WHERE c.id = $1 AND c.visitor_id = $2`,
    [conversationId, visitorId]
  );
  if (!rows[0]) return null;
  return { ...rows[0], lifecycle: isClosed(rows[0].status) ? "closed" : "active" };
}

export async function activeConversationFor(visitorId: string): Promise<Row | null> {
  const { rows } = await pool.query(ACTIVE_SQL, [visitorId]);
  return rows[0] ?? null;
}

// --- Operator updates ---------------------------------------------------------------

export type Patch = { status?: Status; suspected_spam?: boolean; external_ref?: string | null };

export async function updateConversation(conversationId: number, patch: Patch): Promise<Row | null> {
  const { rows } = await pool.query(
    `UPDATE conversations SET
        status        = COALESCE($2, status),
        suspected_spam = CASE WHEN $3::boolean IS NULL THEN suspected_spam ELSE $3 END,
        spam_reason   = CASE WHEN $3::boolean IS NULL THEN spam_reason
                             WHEN $3 THEN spam_reason ELSE NULL END,
        external_ref  = CASE WHEN $5 THEN $4 ELSE external_ref END,
        updated_at    = now()
      WHERE id = $1 RETURNING *`,
    [
      conversationId,
      patch.status ?? null,
      patch.suspected_spam ?? null,
      patch.external_ref ?? null,
      "external_ref" in patch,
    ]
  );
  if (rows[0]) publish({ type: "meta", conversationId });
  return rows[0] ?? null;
}
