// End-to-end API test against a running instance (synthetic data only).
//   BASE_URL=http://127.0.0.1:8080 OPERATOR_EMAIL=... OPERATOR_PASSWORD=... \
//   INTEGRATION_TOKEN=... SPAM_IP_RULES=true node scripts/e2e.mjs
// SPAM_IP_RULES=true requires the instance to run with SPAM_EXEMPT_LOCAL=false.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const EMAIL = process.env.OPERATOR_EMAIL;
const PASSWORD = process.env.OPERATOR_PASSWORD;
const TOKEN = process.env.INTEGRATION_TOKEN ?? "";
const SPAM_IP_RULES = process.env.SPAM_IP_RULES === "true";
if (!EMAIL || !PASSWORD) throw new Error("set OPERATOR_EMAIL and OPERATOR_PASSWORD");

const run = randomBytes(4).toString("hex");
const newVisitor = () => randomBytes(24).toString("hex");
let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").join("\n        ")}`); }
}

async function call(method, path, { visitor, cookie, body, headers = {}, raw, bearer } = {}) {
  const h = { ...headers };
  if (visitor) h["x-chat-visitor-id"] = visitor;
  if (cookie) h.cookie = cookie;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (body !== undefined && !raw) h["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  let json = null; const text = await res.text();
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(email = EMAIL, password = PASSWORD) {
  const r = await call("POST", "/api/auth/login", { body: { email, password } });
  const setCookie = r.headers.get("set-cookie") ?? "";
  return { r, cookie: setCookie.split(";")[0] };
}

console.log(`E2E against ${BASE}`);
let op; // operator cookie
const A = newVisitor(), B = newVisitor();
let convA, msgA1;

await test("health and public widget config", async () => {
  assert.equal((await call("GET", "/healthz")).json.status, "ok");
  const cfg = (await call("GET", "/api/widget-config")).json;
  assert.ok(cfg.title && cfg.greeting && /^#[0-9a-f]{6}$/i.test(cfg.accent));
});

await test("operator authentication: wrong password / unknown user are indistinguishable, success sets a hardened cookie", async () => {
  const bad = await login(EMAIL, "definitely-wrong-password");
  const unknown = await login(`nobody-${run}@example.com`, "definitely-wrong-password");
  assert.equal(bad.r.status, 401); assert.equal(unknown.r.status, 401);
  assert.deepEqual(bad.r.json, unknown.r.json);
  const ok = await login();
  assert.equal(ok.r.status, 200);
  const sc = ok.r.headers.get("set-cookie");
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/); assert.match(sc, /Path=\//);
  assert.ok(!JSON.stringify(ok.r.json).includes("password"));
  op = ok.cookie;
  const me = await call("GET", "/api/auth/me", { cookie: op });
  assert.equal(me.status, 200); assert.equal(me.json.operator.email, EMAIL.toLowerCase());
  assert.equal((await call("POST", "/api/auth/login", { body: { email: 1, password: 2 } })).status, 400);
});

await test("operator endpoints reject anonymous callers and visitor credentials", async () => {
  for (const [m, p, body] of [
    ["GET", "/api/conversations"], ["GET", "/api/conversations/1"], ["GET", "/api/conversations/1/messages"],
    ["POST", "/api/conversations/1/messages", { body: "x" }], ["PATCH", "/api/conversations/1", { status: "open" }],
    ["POST", "/api/conversations/1/seen", { last_message_id: 1 }],
  ]) {
    assert.equal((await call(m, p, { body })).status, 401, `${m} ${p} anonymous`);
    assert.equal((await call(m, p, { body, visitor: A })).status, 401, `${m} ${p} with visitor header`);
  }
  assert.equal((await call("GET", "/api/auth/me")).status, 401);
  assert.equal((await call("GET", "/api/conversations", { cookie: "chat_session=not-a-real-token" })).status, 401);
});

await test("integration API requires the bearer token or an operator session", async () => {
  assert.equal((await call("GET", "/api/integration/conversations")).status, 401);
  assert.equal((await call("GET", "/api/integration/conversations", { bearer: "wrong-token" })).status, 401);
  assert.equal((await call("GET", "/api/integration/conversations", { bearer: "" })).status, 401);
  assert.equal((await call("GET", "/api/integration/conversations", { cookie: op })).status, 200);
});

await test("visitor starts a conversation; input validation on start", async () => {
  const url = "/api/visitor/conversations";
  assert.equal((await call("POST", url, { body: { first_message: "hello there" } })).status, 400, "no credential");
  assert.equal((await call("POST", url, { visitor: "short", body: { first_message: "hello there" } })).status, 400, "weak credential");
  assert.equal((await call("POST", url, { visitor: A, body: {} })).status, 400, "missing message");
  assert.equal((await call("POST", url, { visitor: A, body: { first_message: 123 } })).status, 400, "non-string");
  assert.equal((await call("POST", url, { visitor: A, body: { first_message: "a\u0000b hello" } })).status, 400, "NUL byte");
  assert.equal((await call("POST", url, { visitor: A, body: { first_message: "x".repeat(4001) } })).status, 400, "too long");
  assert.equal((await call("POST", url, { visitor: A, body: { first_message: "hello", start_new: "yes" } })).status, 400, "start_new type");
  const short = await call("POST", url, { visitor: A, body: { first_message: "h" } });
  assert.equal(short.status, 400); assert.equal(short.json.code, "message_too_short");
  assert.equal((await call("POST", url, { visitor: A, raw: "{not json", headers: { "content-type": "application/json" } })).status, 400, "malformed JSON");
  assert.equal((await call("POST", url, { visitor: A, raw: JSON.stringify({ first_message: "y".repeat(40 * 1024) }), headers: { "content-type": "application/json" } })).status, 413, "oversized body");

  const r = await call("POST", url, {
    visitor: A, body: { first_message: `Hello from visitor A ${run}`, source_page: "https://www.example.com/page/1?email=a@b.c#x", idempotency_key: `start-${run}` },
  });
  assert.equal(r.status, 201); convA = r.json.id; assert.equal(r.json.status, "new");
  assert.deepEqual(Object.keys(r.json).sort(), ["continued", "id", "status"], "response exposes no internal fields");
});

await test("starting again continues the active conversation; idempotent replay stores nothing twice; start_new forks", async () => {
  const again = await call("POST", "/api/visitor/conversations", { visitor: A, body: { first_message: "second line" } });
  assert.equal(again.status, 200); assert.equal(again.json.id, convA); assert.equal(again.json.continued, true);
  const replay = await call("POST", "/api/visitor/conversations", { visitor: A, body: { first_message: `Hello from visitor A ${run}`, idempotency_key: `start-${run}` } });
  assert.equal(replay.json.id, convA);
  const msgs = (await call("GET", `/api/visitor/conversations/${convA}/messages`, { visitor: A })).json;
  assert.equal(msgs.length, 2, "first + second, replay added nothing");
  const fresh = await call("POST", "/api/visitor/conversations", { visitor: A, body: { first_message: "explicitly new thread", start_new: true } });
  assert.equal(fresh.status, 201); assert.notEqual(fresh.json.id, convA);
  // The newest visitor activity wins for resume.
  const active = (await call("GET", "/api/visitor/conversation", { visitor: A })).json.conversation;
  assert.equal(active.id, fresh.json.id);
});

await test("access control: another visitor, a missing credential or a bad id all get the same 404", async () => {
  const same = async (m, p, v, body) => (await call(m, p, { visitor: v, body }));
  for (const v of [B, undefined, "x".repeat(10)]) {
    for (const [m, p, body] of [
      ["GET", `/api/visitor/conversations/${convA}`], ["GET", `/api/visitor/conversations/${convA}/messages`],
      ["POST", `/api/visitor/conversations/${convA}/messages`, { body: "intrusion attempt" }],
    ]) {
      const r = await same(m, p, v, body);
      assert.equal(r.status, 404, `${m} ${p} as ${v ? v.slice(0, 6) : "none"}`);
      assert.deepEqual(r.json, { error: "conversation not found" });
    }
  }
  const missing = await call("GET", "/api/visitor/conversations/999999/messages", { visitor: A });
  assert.deepEqual(missing.json, { error: "conversation not found" });
  assert.equal((await call("GET", "/api/visitor/conversations/abc/messages", { visitor: A })).status, 404);
  assert.equal((await call("GET", `/api/visitor/conversations/${convA}/messages?after=-1`, { visitor: A })).status, 400);
  assert.equal((await call("GET", `/api/visitor/conversations/${convA}/messages`, { visitor: A })).status, 200);
  // The visitor credential is not an operator credential.
  assert.equal((await call("POST", `/api/conversations/${convA}/messages`, { visitor: A, body: { body: "x" } })).status, 401);
});

await test("SQL-injection-shaped input is stored as inert text", async () => {
  const evil = `'); DROP TABLE messages; -- <img src=x onerror=alert(1)> ${run}`;
  const r = await call("POST", `/api/visitor/conversations/${convA}/messages`, { visitor: A, body: { body: evil } });
  assert.equal(r.status, 201); assert.equal(r.json.body, evil);
  assert.equal((await call("GET", `/api/visitor/conversations/${convA}/messages`, { visitor: A })).status, 200);
});

await test("operator sees the message, replies; visitor receives the reply in order with the operator name", async () => {
  const list = (await call("GET", "/api/conversations?spam=include", { cookie: op })).json;
  const item = list.conversations.find((c) => String(c.id) === String(convA));
  assert.ok(item, "conversation listed"); assert.ok(item.unread_count >= 3);
  assert.equal(item.source_page, "https://www.example.com/page/1", "query and fragment stripped");
  const full = (await call("GET", `/api/conversations/${convA}`, { cookie: op })).json;
  assert.equal(full.messages[0].body, `Hello from visitor A ${run}`);
  assert.deepEqual(full.messages.map((m) => Number(m.id)), full.messages.map((m) => Number(m.id)).sort((a, b) => a - b));
  const reply = await call("POST", `/api/conversations/${convA}/messages`, { cookie: op, body: { body: `Hi, operator here ${run}`, idempotency_key: `r-${run}` } });
  assert.equal(reply.status, 201); msgA1 = reply.json;
  assert.equal(reply.json.sender_type, "operator"); assert.equal(reply.json.sender_name, "Test Operator");
  const replay = await call("POST", `/api/conversations/${convA}/messages`, { cookie: op, body: { body: "different text, same key", idempotency_key: `r-${run}` } });
  assert.equal(replay.status, 200); assert.equal(replay.json.id, msgA1.id);
  const seen = await call("POST", `/api/conversations/${convA}/seen`, { cookie: op, body: { last_message_id: Number(msgA1.id) } });
  assert.equal(seen.status, 200);
  const visitorView = (await call("GET", `/api/visitor/conversations/${convA}/messages`, { visitor: A })).json;
  assert.equal(visitorView.at(-1).body, `Hi, operator here ${run}`);
  const after = (await call("GET", `/api/visitor/conversations/${convA}/messages?after=${Number(msgA1.id) - 1}`, { visitor: A })).json;
  assert.equal(after.length, 1);
  assert.ok(!("sender_operator_id" in visitorView.at(-1)) && !("idempotency_key" in visitorView.at(-1)), "no internal fields");
  const state = (await call("GET", `/api/visitor/conversations/${convA}`, { visitor: A })).json;
  assert.equal(state.status, "open"); assert.equal(state.operator_name, "Test Operator"); assert.equal(state.lifecycle, "active");
});

await test("history persists: a new session with the same credential resumes the same thread", async () => {
  // Simulates a page refresh: nothing but the visitor token survives.
  const C = newVisitor();
  const s = await call("POST", "/api/visitor/conversations", { visitor: C, body: { first_message: `persist me ${run}` } });
  await call("POST", `/api/conversations/${s.json.id}/messages`, { cookie: op, body: { body: "stored reply" } });
  const active = (await call("GET", "/api/visitor/conversation", { visitor: C })).json.conversation;
  assert.equal(active.id, s.json.id);
  const msgs = (await call("GET", `/api/visitor/conversations/${active.id}/messages`, { visitor: C })).json;
  assert.deepEqual(msgs.map((m) => m.body), [`persist me ${run}`, "stored reply"]);
});

await test("status management: closed blocks operator replies, a visitor message reopens, validation", async () => {
  assert.equal((await call("PATCH", `/api/conversations/${convA}`, { cookie: op, body: { status: "bogus" } })).status, 400);
  assert.equal((await call("PATCH", `/api/conversations/${convA}`, { cookie: op, body: { nope: 1 } })).status, 400);
  assert.equal((await call("PATCH", `/api/conversations/${convA}`, { cookie: op, body: {} })).status, 400);
  assert.equal((await call("PATCH", `/api/conversations/${convA}`, { cookie: op, body: [1] })).status, 400);
  assert.equal((await call("PATCH", `/api/conversations/999999`, { cookie: op, body: { status: "open" } })).status, 404);
  const closed = await call("PATCH", `/api/conversations/${convA}`, { cookie: op, body: { status: "resolved" } });
  assert.equal(closed.json.status, "resolved");
  assert.equal((await call("GET", `/api/visitor/conversations/${convA}`, { visitor: A })).json.lifecycle, "closed");
  const blocked = await call("POST", `/api/conversations/${convA}/messages`, { cookie: op, body: { body: "too late" } });
  assert.equal(blocked.status, 409);
  const wrote = await call("POST", `/api/visitor/conversations/${convA}/messages`, { visitor: A, body: { body: "actually one more question" } });
  assert.equal(wrote.status, 201);
  assert.equal((await call("GET", `/api/conversations/${convA}`, { cookie: op })).json.status, "open");
  assert.equal((await call("POST", `/api/conversations/${convA}/messages`, { cookie: op, body: { body: "back again" } })).status, 201);
  assert.equal((await call("POST", `/api/conversations/${convA}/messages`, { cookie: op, body: { body: "  " } })).status, 400);
  assert.equal((await call("POST", `/api/conversations/${convA}/messages`, { cookie: op, body: { body: "x".repeat(4001) } })).status, 400);
});

await test("CRM integration interface: list, read, messages, link a reference; no internals exposed", async () => {
  const auth = TOKEN ? { bearer: TOKEN } : { cookie: op };
  const list = (await call("GET", "/api/integration/conversations?limit=500", auth)).json;
  assert.ok(list.count >= 1);
  const mine = (await call("GET", `/api/conversations/${convA}`, { cookie: op })).json;
  const one = await call("GET", `/api/integration/conversations/${mine.public_id}`, auth);
  assert.equal(one.status, 200); assert.equal(one.json.id, mine.public_id);
  assert.ok(!("visitor_id" in one.json), "visitor credential never leaves");
  assert.ok(!JSON.stringify(list).includes(A), "visitor credential absent from list");
  const msgs = await call("GET", `/api/integration/conversations/${mine.public_id}/messages`, auth);
  assert.ok(msgs.json.length >= 4);
  const linked = await call("PATCH", `/api/integration/conversations/${mine.public_id}`, { ...auth, body: { external_ref: `crm-contact-${run}` } });
  assert.equal(linked.json.external_ref, `crm-contact-${run}`);
  assert.equal((await call("PATCH", `/api/integration/conversations/${mine.public_id}`, { ...auth, body: { suspected_spam: true } })).status, 400);
  assert.equal((await call("GET", "/api/integration/conversations/not-a-uuid", auth)).status, 400);
  assert.equal((await call("GET", "/api/integration/conversations/00000000-0000-0000-0000-000000000000", auth)).status, 404);
  assert.equal((await call("GET", "/api/integration/conversations?updated_since=garbage", auth)).status, 400);
  const since = (await call("GET", `/api/integration/conversations?updated_since=${encodeURIComponent(list.next_cursor)}`, auth)).json;
  assert.ok(since.count >= 1);
  const visitorList = (await call("GET", `/api/visitor/conversations/${convA}`, { visitor: A })).text;
  assert.ok(!visitorList.includes("crm-contact"), "visitor never sees the CRM reference");
});

await test("cross-origin state-changing requests are rejected (CSRF defence)", async () => {
  const r = await call("POST", "/api/visitor/conversations", { visitor: newVisitor(), headers: { origin: "https://evil.example" }, body: { first_message: "from another site" } });
  assert.equal(r.status, 403);
  const r2 = await call("PATCH", `/api/conversations/${convA}`, { cookie: op, headers: { origin: "https://evil.example" }, body: { status: "closed" } });
  assert.equal(r2.status, 403);
  const own = await call("POST", "/api/visitor/conversations", { visitor: newVisitor(), headers: { origin: BASE }, body: { first_message: `same origin start ${run}` } });
  assert.equal(own.status, 201);
});

await test("security headers", async () => {
  const w = await call("GET", "/widget");
  assert.match(w.headers.get("content-security-policy"), /frame-ancestors/); assert.match(w.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(w.headers.get("x-content-type-options"), "nosniff");
  const o = await call("GET", "/operator");
  assert.match(o.headers.get("content-security-policy"), /frame-ancestors 'none'/); assert.equal(o.headers.get("x-frame-options"), "DENY");
  assert.equal((await call("GET", "/api/widget-config")).headers.get("cache-control"), "no-store");
  assert.equal((await call("GET", "/embed.js")).status, 200);
  assert.equal((await call("GET", "/nope")).status, 404);
  assert.equal((await call("GET", "/..%2f..%2fetc%2fpasswd")).status, 404);
  assert.equal((await call("GET", "/migrations/0001_init.sql")).status, 404, "source/migrations not served");
  assert.equal((await call("GET", "/package.json")).status, 404);
});

function openWs(headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws", { headers });
    const frames = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    ws.once("open", () => resolve({ ws, frames }));
    ws.once("error", reject);
    ws.once("unexpected-response", (_q, res) => reject(new Error("ws http " + res.statusCode)));
  });
}
await test("realtime: authorized subscriptions get pokes, others get nothing", async () => {
  const D = newVisitor(), E = newVisitor();
  const cd = (await call("POST", "/api/visitor/conversations", { visitor: D, body: { first_message: `ws visitor ${run}` } })).json.id;
  const mine = await openWs(); const intruder = await openWs(); const anon = await openWs(); const oper = await openWs({ cookie: op });
  await sleep(100);
  mine.ws.send(JSON.stringify({ action: "subscribe", conversation: cd, visitor_id: D }));
  intruder.ws.send(JSON.stringify({ action: "subscribe", conversation: cd, visitor_id: E }));
  intruder.ws.send(JSON.stringify({ action: "subscribe", conversation: cd }));
  anon.ws.send(JSON.stringify({ action: "subscribe", inbox: true }));
  oper.ws.send(JSON.stringify({ action: "subscribe", inbox: true }));
  await sleep(300);
  assert.ok(mine.frames.some((f) => f.type === "subscribed"));
  assert.ok(intruder.frames.filter((f) => f.type === "error").length === 2 && !intruder.frames.some((f) => f.type === "subscribed"));
  assert.ok(anon.frames.some((f) => f.type === "error"));
  await call("POST", `/api/conversations/${cd}/messages`, { cookie: op, body: { body: "realtime reply" } });
  await sleep(300);
  assert.ok(mine.frames.some((f) => f.type === "message" && String(f.conversationId) === String(cd)), "owner poked");
  assert.ok(!intruder.frames.some((f) => f.type === "message"), "intruder not poked");
  assert.ok(!anon.frames.some((f) => f.type === "inbox"), "anonymous inbox not poked");
  assert.ok(oper.frames.some((f) => f.type === "inbox"), "operator inbox poked");
  for (const c of [mine, intruder, anon, oper]) c.ws.close();
  // A foreign browser origin is refused even with a valid operator cookie.
  const closeCode = await new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws", { headers: { cookie: op, origin: "https://evil.example" } });
    ws.on("close", (code) => resolve(code)); ws.on("error", () => resolve("error"));
  });
  assert.equal(closeCode, 1008);
});

if (SPAM_IP_RULES) {
  await test("spam protection: repeated text from one address is flagged and hidden by default, operator can clear it", async () => {
    const text = `buy cheap watches now ${run}`;
    const first = await call("POST", "/api/visitor/conversations", { visitor: newVisitor(), body: { first_message: text } });
    const second = await call("POST", "/api/visitor/conversations", { visitor: newVisitor(), body: { first_message: text } });
    assert.equal(second.status, 201, "a flagged conversation is still a real conversation");
    const visible = (await call("GET", "/api/conversations", { cookie: op })).json;
    assert.ok(visible.conversations.some((c) => String(c.id) === String(first.json.id)));
    assert.ok(!visible.conversations.some((c) => String(c.id) === String(second.json.id)), "hidden by default");
    assert.ok(visible.suspected_spam_count >= 1);
    const only = (await call("GET", "/api/conversations?spam=only", { cookie: op })).json;
    assert.ok(only.conversations.some((c) => String(c.id) === String(second.json.id) && c.spam_reason === "duplicate"));
    assert.equal((await call("GET", "/api/conversations?spam=nonsense", { cookie: op })).status, 400);
    const cleared = await call("PATCH", `/api/conversations/${second.json.id}`, { cookie: op, body: { suspected_spam: false } });
    assert.equal(cleared.json.suspected_spam, false); assert.equal(cleared.json.spam_reason, null);
    const after = (await call("GET", "/api/conversations", { cookie: op })).json;
    assert.ok(after.conversations.some((c) => String(c.id) === String(second.json.id)));
  });
}

await test("an operator WebSocket is closed once its session ends (no lingering inbox feed)", async () => {
  const { cookie } = await login();
  const { ws, frames } = await openWs({ cookie });
  ws.send(JSON.stringify({ action: "subscribe", inbox: true }));
  await sleep(300);
  await call("POST", "/api/auth/logout", { cookie });
  const wait = (Number(process.env.WS_HEARTBEAT_SECONDS ?? 30) + 5) * 1000;
  const code = await new Promise((resolve) => { const t = setTimeout(() => resolve("still open"), wait); ws.on("close", (c) => { clearTimeout(t); resolve(c); }); });
  assert.equal(code, 4401);
  assert.ok(frames.length >= 1);
});

await test("logout invalidates the session server-side", async () => {
  const { cookie } = await login();
  assert.equal((await call("GET", "/api/conversations", { cookie })).status, 200);
  assert.equal((await call("POST", "/api/auth/logout", { cookie })).status, 204);
  assert.equal((await call("GET", "/api/conversations", { cookie })).status, 401, "old cookie is dead even though the client still has it");
});

// Rate limits last: they intentionally exhaust the per-address budget.
await test("rate limiting: login attempts and public writes are throttled with 429", async () => {
  let loginLimited = false;
  for (let i = 0; i < 30 && !loginLimited; i++) {
    const r = await call("POST", "/api/auth/login", { body: { email: EMAIL, password: `guess-${i}-xxxxxxxx` } });
    if (r.status === 429) { loginLimited = true; assert.ok(r.headers.get("retry-after")); }
  }
  assert.ok(loginLimited, "login throttled");
  const V = newVisitor();
  const c = (await call("POST", "/api/visitor/conversations", { visitor: V, body: { first_message: `rate test ${run}` } }));
  let limited = false;
  const cid = c.status === 429 ? null : c.json.id;
  for (let i = 0; i < 200 && !limited; i++) {
    // A forged X-Forwarded-For must not buy a fresh budget (proxy headers are not trusted by default).
    const r = await call("POST", `/api/visitor/conversations/${cid ?? 1}/messages`, { visitor: V, headers: { "x-forwarded-for": `198.51.100.${i % 250}` }, body: { body: `m${i}` } });
    if (r.status === 429) limited = true;
  }
  assert.ok(limited, "public writes throttled");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("Failed: " + failures.join("; ")); process.exit(1); }
