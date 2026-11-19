# Security and privacy review

Scope: the whole publication candidate — every tracked file (35 text files at review time: source, SQL,
HTML/CSS/JS, scripts, tests, configuration, documentation, lockfile), plus the built Docker image and the git
metadata. Method: manual reading of every file, automated scans, dynamic tests, and inspection of build
output. Scans were used to find leads, not as proof; the conclusions below come from reading the files.

## Confidentiality and sanitisation

| Check | Result |
|---|---|
| File inventory | Plain text only; no binaries, symlinks, executable bits, images, fonts, source maps or generated files tracked. Hidden files: `.dockerignore`, `.env.example`, `.gitignore` |
| Identifiers of the originating project, its organisation, hosts, domains, internal documents and terminology | None found by scan; reviewed manually in code comments, test names, documentation and UI strings (comments were rewritten, not copied) |
| Secrets and credentials | No tokens, keys, private-key blocks, or non-empty credential values. `.env.example` has empty secret fields and a placeholder e-mail; the example operator password is empty, so no default credential exists. Test secrets were generated per run outside the repository |
| E-mails, domains, URLs | Only `example.com` / `example` reserved names, loopback and placeholders (`CHAT_DOMAIN`) |
| IP addresses | Only documentation ranges (`203.0.113.0/24`), loopback and private examples in tests, `0.0.0.0` bind |
| Personal data | None. All fixtures are synthetic strings; no customer data, names or contact details |
| Non-ASCII content | Reviewed: generic Ukrainian UI strings (`uk` locale), typographic symbols, one emoji in a test |
| Lockfile | Public npm registry only; no private registry URLs or tokens |
| Docker image | Contains only `dist/`, `migrations/`, `public/`, `package.json`, production `node_modules`; no `.env`, no source maps of our code; runs as the unprivileged `node` user |
| Git metadata | Fresh repository, no history from any other repository, no remotes; commits use a neutral author identity |
| Third-party assets | No fonts, CDN links, analytics or images; system font stack. Icon geometry follows Lucide (ISC), see `NOTICE.md` |
| Licences | Dependencies: MIT / BSD-3-Clause / ISC / BlueOak (runtime), Apache-2.0 / MIT (dev). **Open item: this repository has no licence file** (see below) |

## Application security

Controls verified by tests (see `TEST_RESULTS.md`) and code review:

- **Authentication.** scrypt (N=2^15, r=8, p=3) with per-hash parameters; unknown e-mail and wrong password
  cost the same and return the same response; login rate-limited; sessions are random 256-bit tokens stored
  only as SHA-256, `HttpOnly`, `SameSite=Lax`, optional `Secure`; logout deletes server-side; changing a
  password ends the operator's sessions; operator WebSockets close when the session ends; absurd stored hash
  parameters are refused.
- **Authorization.** Visitor credential (≥ 16 random characters) in a header, never a URL; uniform 404 for
  every refusal; ownership checked under the conversation row lock; WebSocket subscriptions require the same
  proof; operator attribution comes from the session; integration API needs a bearer token (constant-time
  digest comparison) or a session and returns public UUIDs only.
- **Injection / XSS.** All SQL parameterised (the only interpolated fragments are constants). Visitor-controlled
  text is rendered with `textContent` in both UIs; CSP `script-src 'self'` with no inline script, `default-src 'none'`;
  `nosniff`. Verified with an HTML/script payload in a real browser.
- **CSRF / cross-site.** `SameSite=Lax` cookie, JSON-only bodies, plus an Origin/Host check on every state-changing
  request and on WebSocket handshakes; the operator console sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`;
  the widget's embedders can be restricted with `ALLOWED_EMBED_ORIGINS`.
- **Abuse.** Per-address limits on public routes and login, body ≤ 32 KiB, field length limits, control/NUL
  characters rejected, flood guard (duplicates / bursts flagged and hidden, not dropped), WebSocket frame size
  and global connection caps, bounded in-memory structures.
- **Privacy.** No IP addresses, user agents or headers stored or logged; the page URL is stored without query
  string/fragment; no third-party requests (verified in a browser run).
- **Supply chain.** Lockfile committed; `npm audit` clean. A high-severity advisory in `@fastify/static` (≤ 10.1.8)
  was found during this review and fixed by upgrading to 10.1.12.

## Findings during review (all fixed before this commit)

1. High: `@fastify/static` advisory (path handling) → upgraded; audit now clean.
2. Medium: scrypt cost below current guidance → raised; old hashes still verify.
3. Medium: password change did not end existing sessions → now it does.
4. Medium: operator WebSocket stayed authorized after logout → re-validated each heartbeat, closed with 4401.
5. Medium: unlimited WebSocket connections → global cap.
6. Low: all visitors share one rate-limit bucket if a reverse proxy is not declared → startup/first-request warning and documentation.
7. Low: a hung upstream left sends silent → client-side request timeout with a visible retry state.
8. Low: `.env.example` default values would have prevented the demo page from embedding the widget → commented out.

## Residual risks and open items

**Must be resolved by the repository owner before publication**

- **No licence.** The code is derived from proprietary code. The owner must confirm they may publish it and
  choose a licence; until then nobody else has the right to use it.
- **Final human review** of the diff by the owner (provenance, brand, anything this review could not know is confidential).

**Technical / operational**

- Single process: rate limits, flood windows and the realtime bus are in memory and reset on restart.
- No per-account lockout; a distributed attacker is limited only by the strong-password requirement
  (≥ 10 characters) and per-address login limits. Enable network-level protection if exposed to the internet.
- The WebSocket cap is global, not per client; one client could occupy all slots (use proxy-level limits).
- A wrong `TRUST_PROXY_HOPS` either merges all clients into one rate-limit bucket (too low) or lets clients spoof
  their address (too high). The origin check also needs the proxy to pass the original `Host` header.
- The integration token is static, has no scopes, and grants read access to all conversations and message text.
  Treat it like a database credential and use HTTPS.
- The visitor token lives in the widget origin's `localStorage`; anyone with the token can read that visitor's
  conversations. Browsers partition this storage per embedding site, so one person may appear as different
  visitors on different sites (by design).
- Messages are stored unencrypted in PostgreSQL; encryption at rest, backups and access control are the deployer's job.
- No automatic retention or erasure; deployers must handle retention and data-subject requests (README gives SQL).
- Docker base images are referenced by tag, not by digest.
- Only Chromium was tested; no external penetration test.
