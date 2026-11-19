import Fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import fastifyRateLimit from "@fastify/rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { pool } from "./db.js";
import { runMigrations } from "./migrate.js";
import { registerRoutes } from "./routes.js";
import { registerRealtime, originAllowed } from "./realtime.js";
import { registerAuthRoutes, bootstrapOperatorFromEnv } from "./auth.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// Content-Security-Policy per page. Scripts are external files only (no inline
// script), so an injected <script> cannot run even if escaping ever failed.
function cspFor(pathname: string, host: string | undefined): string | null {
  const safeHost = host && /^[A-Za-z0-9.\-:[\]]+$/.test(host) ? host : "";
  const connect = ["'self'", ...(safeHost ? [`ws://${safeHost}`, `wss://${safeHost}`] : [])].join(" ");
  const base = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connect}; base-uri 'none'; form-action 'none'`;
  if (pathname === "/widget" || pathname === "/widget.html") {
    const ancestors = config.allowedEmbedOrigins.length ? config.allowedEmbedOrigins.join(" ") : "*";
    return `${base}; frame-ancestors ${ancestors}`;
  }
  if (pathname === "/operator" || pathname === "/operator.html") return `${base}; frame-ancestors 'none'`;
  if (pathname === "/demo" || pathname === "/demo.html") return `${base}; frame-src 'self'; frame-ancestors 'self'`;
  return null;
}

async function main(): Promise<void> {
  await runMigrations();
  await bootstrapOperatorFromEnv();

  const app = Fastify({
    // Access logs carry method and URL only: no client address, no headers
    // (the visitor credential travels in a header and must never be logged).
    logger: {
      serializers: {
        req: (req: { method?: string; url?: string }) => ({ method: req.method, url: String(req.url).split("?")[0] }),
      },
    },
    // A hop count is supported at runtime; the bundled typings only list boolean.
    trustProxy: (config.trustProxyHops > 0 ? config.trustProxyHops : false) as unknown as boolean,
    bodyLimit: 32 * 1024,
  });

  // Baseline response headers on every reply.
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    const pathname = req.url.split("?")[0];
    if (pathname.startsWith("/api/") || pathname === "/healthz") reply.header("Cache-Control", "no-store");
    const csp = cspFor(pathname, req.headers.host);
    if (csp) reply.header("Content-Security-Policy", csp);
    // The operator console must never be framed; the widget must be embeddable.
    if (pathname === "/operator" || pathname === "/operator.html") reply.header("X-Frame-Options", "DENY");
    return payload;
  });

  // Behind a reverse proxy that is not trusted, every visitor appears to come from
  // the proxy's address and shares one rate-limit budget. Say so once, loudly.
  let warnedProxy = false;
  app.addHook("onRequest", async (req) => {
    if (!warnedProxy && config.trustProxyHops === 0 && req.headers["x-forwarded-for"]) {
      warnedProxy = true;
      req.log.warn("X-Forwarded-For received but TRUST_PROXY_HOPS=0: all clients share one address for rate limiting. Set TRUST_PROXY_HOPS=1 if a reverse proxy is in front of this app.");
    }
  });

  // CSRF defence in depth next to SameSite=Lax cookies: a state-changing request
  // that carries an Origin must come from this chat's own origin.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      return reply.code(403).send({ error: "cross-origin request rejected" });
    }
  });

  // Unexpected errors never leak internals.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: { name: err.name, message: err.message } }, "request failed");
      return reply.code(500).send({ error: "internal server error" });
    }
    return reply.code(status).send({ error: err.message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found" }));

  await app.register(fastifyRateLimit, { global: false, max: 120, timeWindow: "1 minute" });
  await app.register(fastifyWebsocket, { options: { maxPayload: 4096 } });
  await app.register(fastifyStatic, { root: publicDir, index: false, maxAge: "5m" });

  app.get("/", (_req, reply) => reply.redirect("/demo"));
  app.get("/widget", (_req, reply) => reply.sendFile("widget.html"));
  app.get("/operator", (_req, reply) => reply.sendFile("operator.html"));
  app.get("/demo", (_req, reply) => reply.sendFile("demo.html"));

  await registerAuthRoutes(app);
  await registerRoutes(app);
  await registerRealtime(app);

  await app.listen({ port: config.port, host: "0.0.0.0" });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
      await pool.end();
    } catch (err) {
      app.log.error(err);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
