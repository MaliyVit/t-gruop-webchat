// Operator authentication.
//
// * Passwords: Node's built-in scrypt, stored as `scrypt$N$r$p$saltHex$hashHex`.
// * Sessions: opaque random tokens; only their SHA-256 is stored in Postgres.
//   The raw token lives in one httpOnly, SameSite=Lax cookie.
// * Integration clients (a CRM backend) may instead present a static bearer
//   token (INTEGRATION_API_TOKEN) on /api/integration/*. Disabled when unset.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, type ScryptOptions } from "node:crypto";
import { pool } from "./db.js";
import { config } from "./config.js";

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export type Operator = { id: number; email: string; display_name: string; role: string };

declare module "fastify" {
  interface FastifyRequest {
    operator?: Operator;
  }
}

// OWASP-equivalent cost (N=2^15, r=8, p=3, ~32 MiB). The parameters are stored in
// each hash, so they can be raised later without invalidating existing hashes.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_KEYLEN = 64;
// scrypt needs ~128*N*r bytes; Node's default limit (32 MiB) is exactly at the edge.
const scryptMaxmem = (n: number, r: number): number => 256 * n * r;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: scryptMaxmem(SCRYPT_N, SCRYPT_R),
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltHex, keyHex] = parts;
  const expected = Buffer.from(keyHex, "hex");
  const N = Number(n), R = Number(r), P = Number(p);
  // Refuse absurd stored parameters instead of exhausting memory on a crafted row.
  if (!Number.isInteger(N) || N < 2 || N > 2 ** 20 || (N & (N - 1)) !== 0 || R < 1 || R > 32 || P < 1 || P > 16) return false;
  const key = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, {
    N,
    r: R,
    p: P,
    maxmem: scryptMaxmem(N, R),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Verified against when the e-mail is unknown, so a wrong e-mail and a wrong
// password take the same time (no account enumeration by timing).
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(12).toString("hex")));

export const MIN_PASSWORD_LENGTH = 10;

export async function upsertOperator(
  email: string,
  displayName: string,
  password: string,
  role = "operator"
): Promise<Operator> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO operators (email, display_name, password_hash, role)
     VALUES (lower($1), $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            password_hash = EXCLUDED.password_hash,
            role = EXCLUDED.role,
            is_active = true
     RETURNING id, email, display_name, role`,
    [email, displayName, passwordHash, role]
  );
  // A changed password must end every session opened with the old one.
  await pool.query(`DELETE FROM operator_sessions WHERE operator_id = $1`, [rows[0].id]);
  return rows[0];
}

// Seeds the first operator from the environment when that e-mail does not exist
// yet. Non-destructive: leaving the variables set never resets a password.
export async function bootstrapOperatorFromEnv(): Promise<void> {
  const { email, password, name } = config.bootstrap;
  if (!email && !password) return;
  if (!email || !password) {
    console.error("bootstrap operator skipped: set both BOOTSTRAP_OPERATOR_EMAIL and BOOTSTRAP_OPERATOR_PASSWORD");
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`bootstrap operator skipped: password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    return;
  }
  const existing = await pool.query(`SELECT 1 FROM operators WHERE email = lower($1)`, [email]);
  if (existing.rowCount) return;
  await upsertOperator(email, name || email, password, "admin");
  console.log(`bootstrap: created operator ${email}`);
}

// --- Sessions ---------------------------------------------------------------

export const SESSION_COOKIE = "chat_session";
const sha256 = (raw: string): string => createHash("sha256").update(raw).digest("hex");

export async function login(
  email: string,
  password: string
): Promise<{ operator: Operator; token: string; expiresAt: Date } | null> {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, role, password_hash, is_active FROM operators WHERE email = lower($1)`,
    [email]
  );
  const row = rows[0];
  const ok = await verifyPassword(password, row ? row.password_hash : await getDummyHash());
  if (!row || !row.is_active || !ok) return null;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  await pool.query(`INSERT INTO operator_sessions (operator_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
    row.id,
    sha256(token),
    expiresAt,
  ]);
  await pool.query(`UPDATE operators SET last_login_at = now() WHERE id = $1`, [row.id]);
  // Opportunistic cleanup of expired sessions.
  await pool.query(`DELETE FROM operator_sessions WHERE expires_at < now()`);
  return {
    operator: { id: row.id, email: row.email, display_name: row.display_name, role: row.role },
    token,
    expiresAt,
  };
}

export async function operatorFromToken(token: string): Promise<Operator | null> {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT s.id AS session_id, s.expires_at, o.id, o.email, o.display_name, o.role, o.is_active
       FROM operator_sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1`,
    [sha256(token)]
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.is_active || new Date(row.expires_at).getTime() <= Date.now()) {
    await pool.query(`DELETE FROM operator_sessions WHERE id = $1`, [row.session_id]);
    return null;
  }
  await pool.query(`UPDATE operator_sessions SET last_seen_at = now() WHERE id = $1`, [row.session_id]);
  return { id: row.id, email: row.email, display_name: row.display_name, role: row.role };
}

export async function logout(token: string): Promise<void> {
  if (token) await pool.query(`DELETE FROM operator_sessions WHERE token_hash = $1`, [sha256(token)]);
}

// --- Cookies ----------------------------------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      /* ignore a malformed cookie value */
    }
  }
  return out;
}

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))}`,
  ];
  if (config.cookieSecure) attrs.push("Secure");
  reply.header("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(reply: FastifyReply): void {
  const attrs = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (config.cookieSecure) attrs.push("Secure");
  reply.header("Set-Cookie", attrs.join("; "));
}

const tokenFromHeaders = (headers: { cookie?: string }): string => parseCookies(headers.cookie)[SESSION_COOKIE] ?? "";

export async function operatorFromRequest(req: { headers: { cookie?: string } }): Promise<Operator | null> {
  return operatorFromToken(tokenFromHeaders(req.headers));
}

// --- Guards (preHandlers) ---------------------------------------------------

export async function requireOperator(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const operator = await operatorFromRequest(req);
  if (!operator) return reply.code(401).send({ error: "authentication required" });
  req.operator = operator;
}

const digestOf = (value: string): Buffer => createHash("sha256").update(value).digest();

// Integration auth: the bearer token (when one is configured) or an operator
// session. With no token configured only operator sessions are accepted.
export async function requireIntegrationAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (config.integrationToken && header?.startsWith("Bearer ")) {
    // Compare fixed-length digests: no length leak, constant time.
    if (timingSafeEqual(digestOf(header.slice(7)), digestOf(config.integrationToken))) return;
  }
  const operator = await operatorFromRequest(req);
  if (operator) {
    req.operator = operator;
    return;
  }
  return reply.code(401).send({ error: "authentication required" });
}

// --- Routes -----------------------------------------------------------------

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email?: unknown; password?: unknown } }>(
    "/api/auth/login",
    { config: { rateLimit: { max: config.rateLimit.loginPerMinute, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { email, password } = req.body ?? {};
      if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
        return reply.code(400).send({ error: "email and password are required" });
      }
      if (email.length > 320 || password.length > 1024) {
        return reply.code(400).send({ error: "email or password is too long" });
      }
      const result = await login(email, password);
      if (!result) return reply.code(401).send({ error: "invalid email or password" });
      setSessionCookie(reply, result.token, result.expiresAt);
      return { operator: result.operator };
    }
  );

  app.post("/api/auth/logout", async (req, reply) => {
    await logout(tokenFromHeaders(req.headers));
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (req, reply) => {
    const operator = await operatorFromRequest(req);
    if (!operator) return reply.code(401).send({ error: "not authenticated" });
    return { operator };
  });
}
