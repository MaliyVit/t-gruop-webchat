# Test results

Run on 2026-11-19 against the tree in this repository (final revision). Every run used a **clean-room copy**: the committed tree
exported with `git archive` into an empty directory, configured by following the README quick start
(`cp .env.example .env`, generate two secrets, `docker compose up -d --build`) with only test overrides
(a free port, `SPAM_EXEMPT_LOCAL=false`, a 2-second socket heartbeat, a known operator name, an integration
token). Synthetic data only.

Environment: Linux x86-64, Docker 29.1 / Compose 2.37, Node 22.22, PostgreSQL 17, Chromium (Playwright
`chromium-1255`, headless), nginx (alpine) for the reverse-proxy run.

## Summary

| Suite | Result |
|---|---|
| Unit tests (`npm test`): spam rules, validation, password hashing, cookies | **16 / 16** pass |
| API end-to-end (`npm run e2e`) against the Docker stack | **19 / 19** pass |
| Real-browser end-to-end (`npm run e2e:browser`), widget embedded from a different origin, direct | **16 / 16** pass |
| Same browser suite through the README's nginx reverse-proxy configuration (`TRUST_PROXY_HOPS=1`) | **16 / 16** pass (run on the previous revision; later changes only renamed the visitor sender type and replaced demo/example text) |
| `npm audit` (runtime + dev) | 0 vulnerabilities |

The end-to-end scripts also fail when they should: with a wrong operator password the dependent checks fail.

## Required checks

| # | Check | Evidence |
|---|---|---|
| 1 | Application builds | `docker compose build` (`npm ci`, `tsc`, `npm prune`) and `npm test` (type-checks) |
| 2 | Compose starts a fresh installation | Clean room, no pre-existing volume; `db` healthy, then `app` healthy; `/healthz` ok; database not published on the host |
| 3 | Migrations run from an empty database | App log `migrated: 0001_init.sql`; upgrade path (older password-hash parameters) also verified once |
| 4 | Operator can authenticate | API e2e (login/logout/me, cookie flags, indistinguishable failures) and browser e2e (UI login, wrong password refused, sign-out) |
| 5 | Visitor can open the chat | Browser: script embedded on a foreign origin shows a launcher; click opens the panel; iframe resizes |
| 6 | Visitor can send a message | Browser and API |
| 7 | Operator receives it | Browser: appears in the inbox without reload (WebSocket push) |
| 8 | Operator can reply | Browser (Enter to send) and API (idempotent replay) |
| 9 | Visitor receives the reply | Browser: appears with the operator name in the header, < 5 s with the socket live; unread badge while minimized |
| 10 | History persists after refresh | Browser: reload restores thread and open panel; API: new session with the same token resumes the same thread |
| 11 | Realtime reconnection works | Browser: app stopped, send fails visibly and the draft is kept, app started, the widget opens a new subscribed socket on its own, the retry goes through, and the operator console recovers too. Also: operator sockets are closed when their session ends |
| 12 | Authentication and access controls | API e2e: every operator endpoint refuses anonymous callers and visitor tokens; another visitor / no token / bad id all get the same 404; WebSocket subscriptions are authorized (an intruder gets an error and no pokes); cross-origin writes and foreign-origin WebSockets are refused; closed conversations block operator replies |
| 13 | Rate limiting and validation | API e2e: login and public writes return 429 (a forged `X-Forwarded-For` does not help); empty / non-string / NUL-byte / oversized / malformed / unknown-field inputs return 400/413; flood guard flags duplicates and hides them from the default inbox |
| 14 | No runtime dependency on any external system | Compiled server imports only relative modules, Node built-ins, Fastify packages and `pg`; no outbound-HTTP code in the server; the app container's only established connections are to the database; the browser run records zero requests to any third-party host; the container environment contains only this project's settings |

Also checked: XSS probe text renders inertly in the widget and the console and no script runs; the page URL
is stored without query string or fragment; `ALLOWED_EMBED_ORIGINS` makes a browser refuse to render the
widget on a non-listed site; `COOKIE_SECURE=true` adds `Secure`; the standalone `/widget` view works;
mobile viewport (375 px): widget goes full-screen with no horizontal overflow, console switches between list
and thread.

## Not tested

- Browsers other than Chromium (Firefox, Safari), real phones, assistive technology.
- Load, soak and multi-instance behaviour (the design is single-process).
- TLS termination with a real certificate and the Caddy snippet (nginx was exercised over plain HTTP).
- Penetration testing or fuzzing beyond the inputs listed above.
