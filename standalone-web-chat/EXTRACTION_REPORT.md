# Design report

This project is a self-contained website chat that can be added to any website and later connected to any
CRM. It has no runtime dependency on any other system.

## Scope

**Included**

| Area | What |
|---|---|
| Visitor widget | Embeddable loader (`embed.js`), isolated iframe, responsive UI, conversation start/resume, send/receive, history after reload, reconnection and error states, sound toggle, `en`/`uk` strings |
| Backend | Fastify API, WebSocket realtime, PostgreSQL storage, ordered + idempotent messages, validation, rate limiting, flood guard |
| Operator inbox | Login, conversation list with unread counts and filters, thread, replies, status management, CRM reference, spam flag |
| Deployment | Docker Compose (app + PostgreSQL), environment-based configuration, `.env.example`, README, demo page |
| Integration seam | A small read/link API for a future CRM (`/api/integration/*`), documented in `docs/` |

**Not included**

Anything beyond a website chat: other messaging channels and bots, analytics and tracking, visitor
profiling, identity matching, reporting dashboards, and any CRM integration (only the documented seam).

## Approach

1. Identify what a working website chat needs: its runtime contracts (HTTP, WebSocket, database) and
   the minimum set of modules behind them.
2. Implement it in a clean directory on a conventional stack (Node, Fastify, PostgreSQL, a vanilla JS widget).
3. Validate with synthetic data only (unit, API end-to-end and real-browser tests; see
   [TEST_RESULTS.md](TEST_RESULTS.md)).
4. Review the whole project for security and privacy ([SECURITY_REVIEW.md](SECURITY_REVIEW.md)).

## Main decisions

| Decision | Reason |
|---|---|
| Node 22 + Fastify 5 + PostgreSQL 17 + dependency-free vanilla JS widget in an iframe | Small, proven stack; no framework needed in the page |
| One migration (`0001_init.sql`), four tables (`operators`, `operator_sessions`, `conversations`, `messages`) plus the runner's `schema_migrations` ledger | Smallest schema that supports conversations, messages, operators and sessions |
| Visitor token credential, create-or-continue under a per-visitor advisory lock, idempotency keys, message-driven status transitions | These make resume, retries and reloads behave correctly |
| Visitor API under `/api/visitor/*`; operator API under `/api/conversations*`; CRM API under `/api/integration/*` | Each audience has exactly one credential type |
| Visitor credential travels in a header (never a URL), must be ≥ 16 random characters, and is also required to subscribe to a conversation over WebSocket | A bearer credential must not appear in URLs/logs; realtime must not reveal other people's activity |
| Operator statuses `new/open/waiting/resolved/closed`, no classification workflow | A CRM can add its own |
| `external_ref` column + integration API instead of contact tables | Lets a CRM link records later without guessing its data model |
| Realtime is an in-process bus with REST re-fetch; polling remains the fallback | Single-process is enough; the socket is a latency optimisation, never a correctness dependency |
| No third-party requests from the widget or console (system fonts, no CDN, no analytics); scripts are external files so a strict CSP (`script-src 'self'`) applies | Privacy and independence |
| Configuration only through environment variables, validated at start-up; no hard-coded domains | The chat domain comes from the embed script's own `src` and from `PUBLIC_URL` |
| Operator passwords use scrypt and sessions use hashed tokens in PostgreSQL | No extra dependency; modern cost parameters |
| Logs carry method and path only (no client address, no headers) | Data minimisation |
| Neutral defaults: blue accent, system fonts, English text, generic demo page | No brand material |

## Layout

```
src/            server, routes, service (domain), realtime, auth, spam-guard, validate, config, migrate, CLI
migrations/     0001_init.sql
public/         embed.js, widget.{html,css,js}, operator.{html,css,js}, demo.{html,css}
test/           unit tests            scripts/  end-to-end (API + real browser)
docs/           API.md, CRM_INTEGRATION.md
```

## Known gaps

See "Limitations" in the README and "Residual risks" in [SECURITY_REVIEW.md](SECURITY_REVIEW.md).
