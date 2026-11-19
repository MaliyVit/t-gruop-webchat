// WebSocket realtime endpoint: GET /ws.
//
// The server pushes thin "poke" frames; clients react by re-fetching over REST,
// which is where authorization is enforced. Polling stays as the fallback, so
// realtime is a latency win and never a correctness dependency.
//
//   visitor  -> {"action":"subscribe","conversation":<id>,"visitor_id":"<token>"}
//   operator -> {"action":"subscribe","inbox":true}  (session cookie required)
//               {"action":"subscribe","conversation":<id>}
//   server   -> {"type":"ready"} | {"type":"subscribed","conversationId":n}
//               {"type":"message"|"meta"|"inbox","conversationId":n} | {"type":"error",...}
//
// Subscriptions are authorized: a visitor must prove ownership of the
// conversation, so pokes do not reveal activity of other people's conversations.
import type { FastifyInstance } from "fastify";
import { subscribe, type ChatEvent } from "./events.js";
import { operatorFromRequest } from "./auth.js";
import { visitorOwns } from "./service.js";
import { isVisitorId, parseId } from "./validate.js";
import { config } from "./config.js";

const HEARTBEAT_MS = config.ws.heartbeatSeconds * 1000;
let openSockets = 0;
const MAX_SUBSCRIPTIONS = 20;

// Browsers always send Origin on WebSocket handshakes. Only the chat origin
// itself (the widget iframe and the operator page) may connect; this stops a
// third-party page from riding an operator's cookie (cross-site WS hijacking).
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // non-browser client (tests, curl): no ambient cookie to abuse
  try {
    const o = new URL(origin);
    if (host && o.host === host) return true;
    if (config.publicUrl && o.host === new URL(config.publicUrl).host) return true;
  } catch {
    /* fall through */
  }
  return false;
}

export async function registerRealtime(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (socket, req) => {
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      socket.close(1008, "origin not allowed");
      return;
    }

    // Global cap: a flood of idle sockets must not exhaust the process.
    if (openSockets >= config.ws.maxConnections) {
      socket.close(1013, "too many connections");
      return;
    }
    openSockets++;

    const conversations = new Set<number>();
    let inbox = false;
    let alive = true;

    let isOperator = false;
    const authReady = operatorFromRequest(req)
      .then((op) => {
        isOperator = op != null;
      })
      .catch(() => {
        isOperator = false;
      });

    const send = (payload: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };

    const unsubscribe = subscribe((event: ChatEvent) => {
      if (conversations.has(event.conversationId)) send({ type: event.type, conversationId: event.conversationId });
      if (inbox) send({ type: "inbox", conversationId: event.conversationId });
    });

    socket.on("message", async (raw: Buffer) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame === null || typeof frame !== "object") return;
      try {
        if (frame.action === "subscribe" && frame.inbox === true) {
          await authReady;
          if (isOperator) inbox = true;
          else send({ type: "error", error: "unauthorized" });
        } else if (frame.action === "subscribe" && "conversation" in frame) {
          const id = parseId(frame.conversation);
          if (!id) return;
          if (conversations.size >= MAX_SUBSCRIPTIONS) return send({ type: "error", error: "too many subscriptions" });
          await authReady;
          const allowed =
            isOperator || (isVisitorId(frame.visitor_id) && (await visitorOwns(id, frame.visitor_id as string)));
          if (!allowed) return send({ type: "error", error: "not found", conversationId: id });
          conversations.add(id);
          send({ type: "subscribed", conversationId: id });
        } else if (frame.action === "unsubscribe" && "conversation" in frame) {
          const id = parseId(frame.conversation);
          if (id) conversations.delete(id);
        }
      } catch {
        /* a failed lookup must not take the socket down; the client re-subscribes */
      }
    });

    socket.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      try {
        socket.ping();
      } catch {
        /* closing socket: the close handler cleans up */
      }
      // An operator socket must not outlive its session (logout, expiry, deactivation).
      if (isOperator) {
        operatorFromRequest(req)
          .then((op) => {
            if (!op) {
              isOperator = false;
              inbox = false;
              socket.close(4401, "session ended");
            }
          })
          .catch(() => {});
      }
    }, HEARTBEAT_MS);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      openSockets--;
      clearInterval(heartbeat);
      unsubscribe();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);

    send({ type: "ready" });
  });
}
