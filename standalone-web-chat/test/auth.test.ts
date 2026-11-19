import { test } from "node:test";
import assert from "node:assert/strict";
import { scryptSync, randomBytes } from "node:crypto";

// db.ts needs a URL at import time; a Pool does not connect until first use.
process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";
const { hashPassword, verifyPassword, parseCookies } = await import("../src/auth.js");

test("hash and verify round-trip; wrong password and garbage are rejected", async () => {
  const hash = await hashPassword("correct horse battery");
  assert.match(hash, /^scrypt\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword("correct horse battery", hash), true);
  assert.equal(await verifyPassword("correct horse batterz", hash), false);
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
  assert.equal(await verifyPassword("x", "scrypt$1$2$3"), false);
});

test("two hashes of the same password differ (random salt)", async () => {
  assert.notEqual(await hashPassword("same-password-1"), await hashPassword("same-password-1"));
});

test("hashes made with older, cheaper parameters still verify (parameters live in the hash)", async () => {
  const salt = randomBytes(16);
  const key = scryptSync("legacy-password-1", salt, 64, { N: 16384, r: 8, p: 1 });
  const legacy = `scrypt$16384$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
  assert.equal(await verifyPassword("legacy-password-1", legacy), true);
  assert.equal(await verifyPassword("legacy-password-2", legacy), false);
});

test("a crafted hash with absurd cost parameters is refused instead of exhausting memory", async () => {
  const salt = randomBytes(16).toString("hex");
  const key = randomBytes(64).toString("hex");
  assert.equal(await verifyPassword("x", `scrypt$1073741824$8$1$${salt}$${key}`), false);
  assert.equal(await verifyPassword("x", `scrypt$16383$8$1$${salt}$${key}`), false); // not a power of two
  assert.equal(await verifyPassword("x", `scrypt$16384$8$9999$${salt}$${key}`), false);
});

test("cookie parsing tolerates malformed values", () => {
  assert.deepEqual(parseCookies("a=1; chat_session=abc; bad=%E0%A4%A"), { a: "1", chat_session: "abc" });
  assert.deepEqual(parseCookies(undefined), {});
});
