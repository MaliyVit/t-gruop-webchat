// Real-browser end-to-end test (Chromium via playwright-core), synthetic data only.
// The widget is embedded from a *different origin* than the chat server, exactly
// like on a third-party website.
//
//   BASE_URL=http://127.0.0.1:8080 OPERATOR_EMAIL=... OPERATOR_PASSWORD=... \
//   CHROMIUM=/path/to/chrome \
//   OUTAGE_STOP_CMD="docker compose stop app" OUTAGE_START_CMD="docker compose start app" \
//   SHOT_DIR=./shots node scripts/browser-e2e.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const EMAIL = process.env.OPERATOR_EMAIL, PASSWORD = process.env.OPERATOR_PASSWORD;
const HOST_PORT = Number(process.env.HOST_PAGE_PORT ?? 18081);
const SHOTS = process.env.SHOT_DIR;
if (!EMAIL || !PASSWORD) throw new Error("set OPERATOR_EMAIL and OPERATOR_PASSWORD");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const run = randomBytes(3).toString("hex");

// A stand-in for an embedding website, served from another origin.
const hostPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Host site</title></head><body style="font-family:sans-serif"><h1>Host website</h1><p>Some page content.</p>
<script src="${BASE}/embed.js" defer></script></body></html>`;
const hostServer = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(hostPage); });
await new Promise((r) => hostServer.listen(HOST_PORT, "127.0.0.1", r));
const HOST_URL = `http://127.0.0.1:${HOST_PORT}/pages/sample?utm=campaign-x#frag`;

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").slice(0, 6).join("\n        ")}`); }
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ["--no-sandbox"] });
const visitorCtx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
const operatorCtx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
const visitor = await visitorCtx.newPage();
const operator = await operatorCtx.newPage();
const consoleErrors = [];
for (const [n, p] of [["visitor", visitor], ["operator", operator]]) {
  p.on("pageerror", (e) => consoleErrors.push(`${n}: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_|WebSocket connection/.test(m.text())) consoleErrors.push(`${n}: ${m.text()}`); });
}
const wsLog = []; // every WebSocket the visitor page opens, with the frames it received
visitor.on("websocket", (ws) => {
  const rec = { url: ws.url(), frames: [], closed: false }; wsLog.push(rec);
  ws.on("framereceived", (f) => rec.frames.push(String(f.payload)));
  ws.on("close", () => { rec.closed = true; });
});

const widget = () => visitor.frameLocator("iframe[title=Chat]");
const external = [];
visitor.on("request", (r) => { const u = new URL(r.url()); if (!["127.0.0.1"].includes(u.hostname) && u.protocol.startsWith("http")) external.push(r.url()); });
operator.on("request", (r) => { const u = new URL(r.url()); if (!["127.0.0.1"].includes(u.hostname) && u.protocol.startsWith("http")) external.push(r.url()); });

console.log(`Browser E2E: chat ${BASE}, host site http://127.0.0.1:${HOST_PORT}`);

await step("operator signs in through the UI; wrong password is refused", async () => {
  await operator.goto(`${BASE}/operator`);
  await operator.fill("#email", EMAIL); await operator.fill("#password", "wrong-password-xx");
  await operator.click("#login button[type=submit]");
  await operator.waitForSelector("#loginError:not([hidden])");
  await operator.fill("#password", PASSWORD);
  await operator.click("#login button[type=submit]");
  await operator.waitForSelector("#app:not([hidden])");
  assert.equal(await operator.locator("#who").textContent(), "Test Operator");
  await shot(operator, "01-operator-empty");
});

await step("the embed script on a foreign site shows a launcher; clicking it opens the chat", async () => {
  await visitor.goto(HOST_URL);
  const iframe = visitor.locator("iframe[title=Chat]");
  await iframe.waitFor();
  const small = await iframe.boundingBox();
  assert.ok(small.width <= 110 && small.height <= 110, `closed iframe is launcher-sized (${small.width}x${small.height})`);
  await widget().locator("#fab").click();
  await widget().locator("#start").waitFor({ state: "visible" });
  const open = await iframe.boundingBox();
  assert.ok(open.width >= 390 && open.height >= 500, `open iframe is panel-sized (${open.width}x${open.height})`);
  await shot(visitor, "02-widget-open");
});

const xss = `<img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> ${run}`;
await step("visitor sends the first message (HTML in the text stays text); it appears in the widget", async () => {
  await widget().locator("#first").fill(xss);
  await widget().locator("#startBtn").click();
  await widget().locator(".msg.visitor").first().waitFor();
  assert.equal(await widget().locator(".msg.visitor").first().textContent(), xss);
  assert.equal(await widget().locator("#messages img, #messages script").count(), 0);
  assert.equal(await visitor.frames().at(-1).evaluate(() => window.__xss), undefined);
});

await step("the operator inbox receives it in realtime (no reload); content is rendered inertly", async () => {
  // The database may hold earlier conversations: find ours by its unique marker.
  const mine = operator.locator(".conv", { hasText: run }).first();
  await mine.waitFor({ timeout: 10000 });
  assert.match(await mine.locator(".preview").textContent(), /<img src=x/);
  await mine.click();
  await operator.locator("#thread .msg.visitor").first().waitFor();
  assert.equal(await operator.locator("#thread .msg.visitor span").first().textContent(), xss);
  assert.equal(await operator.locator("#thread img, #thread script").count(), 0);
  assert.equal(await operator.evaluate(() => window.__xss), undefined, "no script ran in the operator console");
  const sub = await operator.locator("#threadSub").textContent();
  assert.ok(sub.includes("127.0.0.1") && sub.includes("/pages/sample") && !sub.includes("utm") && !sub.includes("campaign-x"), `source page shows path only: ${sub}`);
  await shot(operator, "03-operator-thread");
});

const reply1 = `Hello! How can we help? ${run}`;
await step("operator replies; the visitor receives it and the header shows the operator", async () => {
  await operator.fill("#reply", reply1);
  await operator.press("#reply", "Enter");
  await widget().locator(".msg.operator", { hasText: reply1 }).waitFor({ timeout: 10000 });
  assert.equal(await widget().locator("#hdrTitle").textContent(), "Test Operator");
  assert.equal(await widget().locator("#hdrAvatar").textContent(), "TO");
  await shot(visitor, "04-widget-conversation");
});

await step("after a page refresh the conversation, its history and the open panel are restored", async () => {
  await visitor.reload();
  await widget().locator(".msg.operator", { hasText: reply1 }).waitFor({ timeout: 10000 });
  assert.equal(await widget().locator(".msg.visitor").count(), 1);
  assert.ok(await widget().locator("#chat").isVisible(), "chat view, not the start form");
});

await step("realtime over WebSocket: the socket is connected and subscribed after refresh", async () => {
  await visitor.waitForTimeout(500);
  const live = wsLog.filter((w) => !w.closed && w.frames.some((f) => f.includes('"subscribed"')));
  assert.ok(live.length >= 1, `a live, subscribed socket exists (${JSON.stringify(wsLog.map((w) => [w.closed, w.frames.length]))})`);
});

const reply2 = `Realtime check ${run}`;
await step("a reply arrives within a couple of seconds while the socket is live (push, not the 20 s fallback poll)", async () => {
  const t0 = Date.now();
  await operator.fill("#reply", reply2); await operator.press("#reply", "Enter");
  await widget().locator(".msg.operator", { hasText: reply2 }).waitFor({ timeout: 8000 });
  assert.ok(Date.now() - t0 < 5000, `delivered in ${Date.now() - t0} ms`);
});

await step("minimized widget shows an unread badge for a reply and clears it on open", async () => {
  await widget().locator("#minimize").click();
  await widget().locator("#fab").waitFor({ state: "visible" });
  const box = await visitor.locator("iframe[title=Chat]").boundingBox();
  assert.ok(box.width <= 110, "iframe shrinks to launcher size");
  const reply3 = `While minimized ${run}`;
  await operator.fill("#reply", reply3); await operator.press("#reply", "Enter");
  await widget().locator("#badge:not([hidden])").waitFor({ timeout: 10000 });
  assert.equal(await widget().locator("#badge").textContent(), "1");
  await widget().locator("#fab").click();
  await widget().locator("#badge").waitFor({ state: "hidden" });
  await widget().locator(".msg.operator", { hasText: reply3 }).waitFor();
});

await step("status management in the console: resolve → operator reply disabled → visitor message reopens", async () => {
  await operator.selectOption("#statusSelect", "resolved");
  await operator.locator("#closedNote").waitFor({ state: "visible" });
  assert.ok(await operator.locator("#composer").isHidden());
  await widget().locator("#hdrSub").filter({ hasText: /closed/i }).waitFor({ timeout: 10000 });
  await widget().locator("#input").fill(`One more thing ${run}`); await widget().locator("#send").click();
  await operator.locator("#composer").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await operator.locator("#statusSelect").inputValue(), "open");
});

await step("outage and reconnection: send fails visibly, text is kept, socket reconnects, message goes through", async () => {
  if (!process.env.OUTAGE_STOP_CMD) throw new Error("OUTAGE_STOP_CMD not set");
  const wsBefore = wsLog.length;
  execSync(process.env.OUTAGE_STOP_CMD, { stdio: "ignore" });
  let restarted = false;
  const restart = () => { if (!restarted) { restarted = true; execSync(process.env.OUTAGE_START_CMD, { stdio: "ignore" }); } };
  try {
  const outageText = `sent during outage ${run}`;
  await widget().locator("#input").fill(outageText); await widget().locator("#send").click();
  await widget().locator("#notice:not([hidden])").waitFor({ timeout: 10000 });
  assert.equal(await widget().locator("#input").inputValue(), outageText, "draft restored for retry");
  await shot(visitor, "05-widget-outage");
  restart();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/healthz")).ok) break; } catch { /* still down */ } await visitor.waitForTimeout(500); }
  // The widget reconnects on its own (exponential backoff), without a page reload.
  await visitor.waitForFunction(() => true);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !wsLog.slice(wsBefore).some((w) => !w.closed && w.frames.some((f) => f.includes('"subscribed"')))) await visitor.waitForTimeout(500);
  assert.ok(wsLog.slice(wsBefore).some((w) => !w.closed && w.frames.some((f) => f.includes('"subscribed"'))), "a new subscribed socket was opened after the outage");
  await widget().locator("#send").click(); // retry with the kept draft
  await widget().locator(".msg.visitor", { hasText: outageText }).waitFor({ timeout: 10000 });
  await widget().locator("#notice").waitFor({ state: "hidden", timeout: 10000 });
  // The operator console recovered too: sign-in is required again? (sessions live in the DB, so it must not be)
  await operator.waitForFunction(() => document.querySelector("#thread")?.textContent?.includes("sent during outage"), null, { timeout: 30000 });
  const reply4 = `after outage ${run}`;
  await operator.fill("#reply", reply4); await operator.press("#reply", "Enter");
  await widget().locator(".msg.operator", { hasText: reply4 }).waitFor({ timeout: 10000 });
  } finally { restart(); } // never leave the instance stopped, even when an assertion fails
});

await step("mobile: the widget goes full-screen, fits the viewport and has no horizontal scroll", async () => {
  const phone = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const page = await phone.newPage();
  await page.goto(HOST_URL);
  const iframe = page.locator("iframe[title=Chat]"); await iframe.waitFor();
  const frame = page.frameLocator("iframe[title=Chat]");
  await frame.locator("#fab").click();
  await frame.locator("#start").waitFor({ state: "visible" });
  const box = await iframe.boundingBox();
  assert.ok(box.width >= 374 && box.height >= 666, `iframe covers the viewport (${box.width}x${box.height})`);
  await frame.locator("#first").fill(`mobile visitor ${run}`);
  await frame.locator("#startBtn").click();
  await frame.locator(".msg.visitor").first().waitFor();
  assert.ok(await frame.locator("#input").isVisible() && await frame.locator("#send").isVisible());
  const overflow = await page.frames().at(-1).evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "no horizontal overflow inside the widget");
  await page.screenshot({ path: SHOTS ? `${SHOTS}/06-mobile.png` : undefined });
  await phone.close();
});

await step("operator console on a phone: list and thread switch, no horizontal overflow", async () => {
  const phone = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const page = await phone.newPage();
  await page.goto(`${BASE}/operator`);
  await page.fill("#email", EMAIL); await page.fill("#password", PASSWORD);
  await page.click("#login button[type=submit]");
  await page.locator(".conv").first().waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.locator(".conv").first().click();
  await page.locator("#thread").waitFor({ state: "visible" });
  assert.ok(await page.locator("#listPane").isHidden());
  await page.click("#back");
  assert.ok(await page.locator("#listPane").isVisible());
  await page.screenshot({ path: SHOTS ? `${SHOTS}/07-operator-mobile.png` : undefined });
  await phone.close();
});

await step("operator sign-out returns to the login form and the session is gone", async () => {
  await operator.click("#logout");
  await operator.locator("#login").waitFor({ state: "visible" });
  const me = await operator.evaluate(async () => (await fetch("/api/auth/me")).status);
  assert.equal(me, 401);
});

await step("no request left the machine: no third-party hosts contacted by widget or console", async () => {
  assert.deepEqual([...new Set(external)], []);
});
await step("no uncaught JavaScript errors in the widget or console", async () => {
  assert.deepEqual(consoleErrors, []);
});

await browser.close(); hostServer.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
