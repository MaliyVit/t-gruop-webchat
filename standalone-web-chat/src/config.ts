// All runtime configuration comes from environment variables (see .env.example).
// Read once at start-up; invalid values stop the process instead of being guessed.

function int(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return def;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function str(name: string, def: string, maxLen: number): string {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? def : raw.trim();
  if (value.length > maxLen) throw new Error(`${name} is too long (max ${maxLen})`);
  return value;
}

// Origins allowed to embed the widget (CSP frame-ancestors). Empty = any site.
function origins(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  return raw.split(",").map((item) => {
    const value = item.trim();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name}: '${value}' is not a valid origin (example: https://www.example.com)`);
    }
    if (!/^https?:$/.test(url.protocol) || url.origin !== value) {
      throw new Error(`${name}: '${value}' must be an origin like https://www.example.com (no path)`);
    }
    return url.origin;
  });
}

const accent = str("WIDGET_ACCENT", "#2563eb", 7);
if (!/^#[0-9a-fA-F]{6}$/.test(accent)) throw new Error("WIDGET_ACCENT must be a #rrggbb colour");
const locale = str("WIDGET_LOCALE", "en", 5);
if (!["en", "uk"].includes(locale)) throw new Error("WIDGET_LOCALE must be 'en' or 'uk'");

const publicUrl = process.env.PUBLIC_URL?.trim() || "";
if (publicUrl) {
  try {
    const u = new URL(publicUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
  } catch {
    throw new Error("PUBLIC_URL must be a full URL such as https://chat.example.com");
  }
}

export const config = {
  port: int("PORT", 8080, 1, 65535),
  // Number of reverse proxies in front of the app. 0 = none: the TCP peer is the
  // client. Wrongly raising this lets clients spoof X-Forwarded-For.
  trustProxyHops: int("TRUST_PROXY_HOPS", 0, 0, 5),
  publicUrl,
  cookieSecure: bool("COOKIE_SECURE", false),
  sessionTtlHours: int("SESSION_TTL_HOURS", 12, 1, 24 * 30),
  integrationToken: process.env.INTEGRATION_API_TOKEN?.trim() || "",
  allowedEmbedOrigins: origins("ALLOWED_EMBED_ORIGINS"),
  ws: {
    maxConnections: int("WS_MAX_CONNECTIONS", 5000, 1, 1000000),
    heartbeatSeconds: int("WS_HEARTBEAT_SECONDS", 30, 1, 600),
  },
  rateLimit: {
    writePerMinute: int("RATE_LIMIT_WRITE_PER_MINUTE", 60, 1, 100000),
    readPerMinute: int("RATE_LIMIT_READ_PER_MINUTE", 600, 1, 1000000),
    loginPerMinute: int("RATE_LIMIT_LOGIN_PER_MINUTE", 10, 1, 1000),
  },
  widget: {
    title: str("WIDGET_TITLE", "Chat with us", 60),
    greeting: str("WIDGET_GREETING", "Hi! Ask us anything.", 200),
    accent,
    locale,
  },
  spam: {
    enabled: bool("SPAM_PROTECTION", true),
    minFirstMessageChars: int("SPAM_MIN_FIRST_MESSAGE_CHARS", 2, 1, 50),
    createMaxPerWindow: int("SPAM_CREATE_MAX_PER_WINDOW", 10, 1, 1000),
    createWindowSeconds: int("SPAM_CREATE_WINDOW_SECONDS", 600, 30, 86400),
    duplicateWindowSeconds: int("SPAM_DUPLICATE_WINDOW_SECONDS", 3600, 0, 86400),
    // Loopback / private addresses skip the IP based rules (development, tests).
    // Behind a proxy that is not trusted every client looks private, so keep the
    // proxy settings right before relying on the IP rules.
    exemptLocal: bool("SPAM_EXEMPT_LOCAL", true),
  },
  bootstrap: {
    email: process.env.BOOTSTRAP_OPERATOR_EMAIL?.trim() || "",
    password: process.env.BOOTSTRAP_OPERATOR_PASSWORD || "",
    name: process.env.BOOTSTRAP_OPERATOR_NAME?.trim() || "",
  },
};

export type Config = typeof config;
