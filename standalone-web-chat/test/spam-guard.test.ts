import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideCreate,
  assessConversationCreate,
  isLocalAddress,
  resetSpamMemory,
  type SpamSettings,
} from "../src/spam-guard.js";

const settings: SpamSettings = {
  enabled: true,
  minFirstMessageChars: 2,
  createMaxPerWindow: 3,
  createWindowSeconds: 60,
  duplicateWindowSeconds: 600,
  exemptLocal: false,
};
const empty = { recentCreates: [], lastSameMessageAt: null };

test("a non-empty message below the minimum is rejected, an emoji counts as one character", () => {
  assert.equal(decideCreate(settings, empty, "a", 0).decision, "reject");
  assert.equal(decideCreate(settings, empty, "👍", 0).decision, "reject");
  assert.equal(decideCreate(settings, empty, "hi", 0).decision, "allow");
});

test("a repeated text inside the window is flagged as duplicate, outside it is allowed", () => {
  const now = 1_000_000;
  assert.deepEqual(decideCreate(settings, { recentCreates: [], lastSameMessageAt: now - 1000 }, "hello", now), {
    decision: "flag",
    reason: "duplicate",
  });
  assert.equal(decideCreate(settings, { recentCreates: [], lastSameMessageAt: now - 601_000 }, "hello", now).decision, "allow");
});

test("exceeding the creation rate flags the conversation", () => {
  const now = 1_000_000;
  const recent = [now - 3000, now - 2000, now - 1000];
  assert.deepEqual(decideCreate(settings, { recentCreates: recent, lastSameMessageAt: null }, "hello", now), {
    decision: "flag",
    reason: "rate",
  });
});

test("disabled protection allows everything", () => {
  assert.equal(decideCreate({ ...settings, enabled: false }, empty, "a", 0).decision, "allow");
});

test("sliding window per client: 4th distinct start from one address is flagged, another address is not", () => {
  resetSpamMemory();
  const t = 5_000_000;
  const ip = "203.0.113.7";
  for (let i = 0; i < 3; i++) {
    assert.equal(assessConversationCreate(settings, ip, `question number ${i}`, t + i).decision, "allow");
  }
  assert.equal(assessConversationCreate(settings, ip, "question number 99", t + 10).decision, "flag");
  assert.equal(assessConversationCreate(settings, "203.0.113.8", "question number 0", t + 11).decision, "allow");
});

test("undo takes an attempt back so a retry is not a duplicate", () => {
  resetSpamMemory();
  const t = 9_000_000;
  const first = assessConversationCreate(settings, "203.0.113.9", "same text", t);
  assert.equal(first.decision, "allow");
  first.undo();
  assert.equal(assessConversationCreate(settings, "203.0.113.9", "same text", t + 1).decision, "allow");
});

test("local addresses are exempt from IP rules when configured, content rule still applies", () => {
  resetSpamMemory();
  const local = { ...settings, exemptLocal: true };
  for (let i = 0; i < 10; i++) assert.equal(assessConversationCreate(local, "127.0.0.1", "same text", i).decision, "allow");
  assert.equal(assessConversationCreate(local, "10.0.0.5", "x", 1).decision, "reject");
  assert.equal(isLocalAddress("172.20.0.1"), true);
  assert.equal(isLocalAddress("::ffff:192.168.1.5"), true);
  assert.equal(isLocalAddress("203.0.113.7"), false);
});
