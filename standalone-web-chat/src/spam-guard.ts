// Flood protection for starting conversations.
//
// decideCreate() is a pure function (settings + recent history + candidate
// message -> reject / flag / allow) so the rules can be tested without a server,
// a database or a clock. assessConversationCreate() feeds it from a
// process-local sliding window keyed by a salted hash of the client IP.
//
// The window lives in memory only: no IP address, and no key derived from one,
// is written to the database, to logs or to responses.
import { createHash, randomBytes } from "node:crypto";

export type SpamSettings = {
  enabled: boolean;
  minFirstMessageChars: number;
  createMaxPerWindow: number;
  createWindowSeconds: number;
  duplicateWindowSeconds: number;
  exemptLocal: boolean;
};

export type CreateDecision =
  | { decision: "allow"; reason: null }
  | { decision: "reject"; reason: "short_message"; minChars: number }
  | { decision: "flag"; reason: "duplicate" | "rate" };

export type ClientHistory = {
  recentCreates: number[]; // epoch ms of every creation, flagged or not
  lastSameMessageAt: number | null;
};

const ALLOW: CreateDecision = { decision: "allow", reason: null };

// Order matters: a too-short message is answered honestly; repetition is a
// stronger signal than volume, so it wins over the rate rule.
export function decideCreate(
  settings: SpamSettings,
  history: ClientHistory,
  firstMessage: string | null | undefined,
  now: number
): CreateDecision {
  if (!settings.enabled) return ALLOW;
  const text = typeof firstMessage === "string" ? firstMessage.trim() : "";
  const chars = [...text].length; // code points: one emoji counts as one
  if (chars > 0 && chars < settings.minFirstMessageChars) {
    return { decision: "reject", reason: "short_message", minChars: settings.minFirstMessageChars };
  }
  if (
    settings.duplicateWindowSeconds > 0 &&
    history.lastSameMessageAt != null &&
    now - history.lastSameMessageAt <= settings.duplicateWindowSeconds * 1000
  ) {
    return { decision: "flag", reason: "duplicate" };
  }
  const windowStart = now - settings.createWindowSeconds * 1000;
  const inWindow = history.recentCreates.filter((t) => t >= windowStart).length;
  if (inWindow >= settings.createMaxPerWindow) return { decision: "flag", reason: "rate" };
  return ALLOW;
}

// Loopback, link-local and private ranges.
export function isLocalAddress(ip: string | null | undefined): boolean {
  if (!ip) return true;
  const addr = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (addr === "::1" || addr.startsWith("127.")) return true;
  if (addr.startsWith("10.") || addr.startsWith("192.168.") || addr.startsWith("169.254.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(addr) || /^fe80:/i.test(addr)) return true;
  return false;
}

// Per-process salt: the in-memory keys cannot be reversed into addresses.
const SALT = randomBytes(16);
const digest = (value: string): string =>
  createHash("sha256").update(SALT).update(value).digest("base64").slice(0, 22);

export const clientKey = (ip: string | null | undefined): string => digest(`ip:${ip ?? "unknown"}`);
export const messageKey = (body: string | null | undefined): string =>
  digest(`msg:${(body ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`);

type ClientEntry = { creates: number[]; messages: Map<string, number[]>; touched: number };

// Bounded so a hostile spread of addresses cannot grow the process without limit.
const MAX_CLIENTS = 5000;
const clients = new Map<string, ClientEntry>();

export function resetSpamMemory(): void {
  clients.clear();
}

function prune(entry: ClientEntry, now: number, settings: SpamSettings): void {
  const horizon = Math.max(settings.createWindowSeconds, settings.duplicateWindowSeconds) * 1000;
  const cutoff = now - horizon;
  entry.creates = entry.creates.filter((t) => t >= cutoff);
  for (const [key, times] of entry.messages) {
    const kept = times.filter((t) => t >= cutoff);
    if (kept.length) entry.messages.set(key, kept);
    else entry.messages.delete(key);
  }
}

function evictIfNeeded(): void {
  if (clients.size <= MAX_CLIENTS) return;
  const oldest = [...clients.entries()].sort((a, b) => a[1].touched - b[1].touched);
  for (const [key] of oldest.slice(0, clients.size - MAX_CLIENTS)) clients.delete(key);
}

export type UndoRecord = () => void;
const NOOP: UndoRecord = () => {};

// Decides and records in one step. A rejected message is not recorded (it never
// became a conversation). `undo` takes the record back if the conversation was
// not persisted after all, so a customer's retry is not mistaken for a duplicate.
export function assessConversationCreate(
  settings: SpamSettings,
  ip: string | null | undefined,
  firstMessage: unknown,
  now: number = Date.now()
): CreateDecision & { undo: UndoRecord } {
  if (!settings.enabled) return { ...ALLOW, undo: NOOP };
  const text = typeof firstMessage === "string" ? firstMessage : null;
  const local = settings.exemptLocal && isLocalAddress(ip);

  // The content rule applies to everyone; IP based rules skip exempt clients.
  if (local) {
    return { ...decideCreate(settings, { recentCreates: [], lastSameMessageAt: null }, text, now), undo: NOOP };
  }

  const key = clientKey(ip);
  const entry: ClientEntry = clients.get(key) ?? { creates: [], messages: new Map(), touched: now };
  entry.touched = now;
  prune(entry, now, settings);

  const msgKey = messageKey(text);
  const hasText = Boolean((text ?? "").trim());
  const sameTimes = hasText ? entry.messages.get(msgKey) ?? [] : [];
  const history: ClientHistory = {
    recentCreates: entry.creates,
    lastSameMessageAt: sameTimes.length ? Math.max(...sameTimes) : null,
  };
  const decision = decideCreate(settings, history, text, now);
  if (decision.decision === "reject") return { ...decision, undo: NOOP };

  entry.creates.push(now);
  if (hasText) entry.messages.set(msgKey, [...sameTimes, now]);
  clients.set(key, entry);
  evictIfNeeded();

  let undone = false;
  const undo: UndoRecord = () => {
    if (undone) return;
    undone = true;
    const i = entry.creates.lastIndexOf(now);
    if (i >= 0) entry.creates.splice(i, 1);
    if (!hasText) return;
    const times = entry.messages.get(msgKey);
    const j = times ? times.lastIndexOf(now) : -1;
    if (times && j >= 0) {
      times.splice(j, 1);
      if (!times.length) entry.messages.delete(msgKey);
    }
  };
  return { ...decision, undo };
}
