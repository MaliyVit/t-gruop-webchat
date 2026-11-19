import { test } from "node:test";
import assert from "node:assert/strict";
import { checkText, isCleanText, isVisitorId, normalizeSourcePage, parseId, MAX } from "../src/validate.js";

test("visitor ids must be long enough to be unguessable and use a safe charset", () => {
  assert.equal(isVisitorId("a".repeat(16)), true);
  assert.equal(isVisitorId("abc"), false);
  assert.equal(isVisitorId("1"), false);
  assert.equal(isVisitorId("a".repeat(129)), false);
  assert.equal(isVisitorId("a".repeat(15) + "'"), false);
  assert.equal(isVisitorId("a".repeat(15) + " "), false);
  assert.equal(isVisitorId(12345678901234567890), false);
  assert.equal(isVisitorId(undefined), false);
});

test("text checks: type, emptiness, length, NUL and control characters", () => {
  assert.deepEqual(checkText("body", "  hello  ", 10), { ok: true, value: "hello" });
  assert.equal(checkText("body", 5, 10).ok, false);
  assert.equal(checkText("body", "   ", 10).ok, false);
  assert.equal(checkText("body", "x".repeat(11), 10).ok, false);
  assert.equal(checkText("body", "a\u0000b", 10).ok, false);
  assert.equal(checkText("body", "a\u0007b", 10).ok, false);
  assert.equal(isCleanText("line1\nline2\ttab\r"), true);
  assert.equal(checkText("body", "x".repeat(MAX.message), MAX.message).ok, true);
});

test("source page keeps origin and path only", () => {
  assert.equal(normalizeSourcePage("https://www.example.com/a/b?email=x@y.z#frag"), "https://www.example.com/a/b");
  assert.equal(normalizeSourcePage("javascript:alert(1)"), null);
  assert.equal(normalizeSourcePage("not a url"), null);
  assert.equal(normalizeSourcePage(""), null);
  assert.equal(normalizeSourcePage("https://example.com/" + "a".repeat(600)), null);
});

test("ids parse only as positive safe integers", () => {
  assert.equal(parseId("12"), 12);
  assert.equal(parseId("0"), null);
  assert.equal(parseId("-3"), null);
  assert.equal(parseId("1.5"), null);
  assert.equal(parseId("abc"), null);
  assert.equal(parseId("9007199254740993"), null);
});
