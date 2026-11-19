# Extraction report

This project is a self-contained website chat, extracted and decoupled from a larger production chat
implementation so it can be reused with any website and CRM. It is **not** a migration of that system:
nothing here imports from, calls, or depends on it.

## Scope

**Included**

| Area | What |
|---|---|
| Visitor widget | Embeddable loader (`embed.js`), isolated iframe, responsive UI, conversation start/resume, send/receive, history after reload, reconnection and error states, sound toggle, `en`/`uk` strings |
| Backend | Fastify API, WebSocket realtime, PostgreSQL storage, ordered + idempotent messages, validation, rate limiting, flood guard |
| Operator inbox | Login, conversation list with unread counts and filters, thread, replies, status management, CRM reference, spam flag |
| Deployment | Docker Compose (app + PostgreSQL), environment-based configuration, `.env.example`, README, demo page |
| Integration seam | A small read/link API for a future CRM (`/api/integration/*`), documented in `docs/` |

**Intentionally excluded**

Retail-specific branding and assets; retail back-office, ERP and marketing-platform integrations; customer-programme
features; external messaging channels and operator bots; analytics and tracking contracts;
geolocation; visitor presence/journey tracking; customer/identity matching; reporting dashboards;
data-retention and erasure tooling tied to the originating organisation's policies; internal
decision records, strategy and business documentation, CI/CD pipelines and infrastructure scripts.

## Approach

1. **Read-only inspection** of the originating code to identify what a working website chat needs: its
   runtime contracts (HTTP, WebSocket, database), transitive module dependencies and business-specific
   assumptions. The originating repository and infrastructure were not modified, and no running system,
   secret, data set or log was accessed.
2. **Re-implementation of the needed behaviour** in a clean directory, reusing the proven designs and the
   same technology stack rather than introducing new frameworks.
3. **Validation** with synthetic data only (unit, API end-to-end and real-browser tests; see
   [TEST_RESULTS.md](TEST_RESULTS.md)).
4. **Security and privacy review** of the whole publication candidate ([SECURITY_REVIEW.md](SECURITY_REVIEW.md)).

## Main decisions

| Decision | Reason |
|---|---|
| Keep Node 22 + Fastify 5 + PostgreSQL 17 + dependency-free vanilla JS widget in an iframe | Proven stack; no rewrite or new framework needed |
| One migration (`0001_init.sql`), four tables (`operators`, `operator_sessions`, `conversations`, `messages`) plus the runner's `schema_migrations` ledger | Smallest schema that supports conversations, messages, operators and sessions; fresh installs only |
| Conversation core kept: visitor token credential, create-or-continue under a per-visitor advisory lock, idempotency keys, message-driven status transitions | These are what make resume, retries and reloads behave correctly |
| Visitor API moved under `/api/visitor/*`; operator API under `/api/conversations*`; CRM API under `/api/integration/*` | Each audience has exactly one credential type |
| Visitor credential travels in a header (never a URL), must be ≥ 16 random characters, and is also required to subscribe to a conversation over WebSocket | A bearer credential must not appear in URLs/logs; realtime must not reveal other people's activity |
| Operator statuses kept (`new/open/waiting/resolved/closed`); retail classification taxonomy and its "close gate" dropped | Business-specific; a CRM can add its own |
| `external_ref` column + integration API instead of customer tables | Lets a CRM link records later without guessing its data model |
| Realtime stays an in-process bus with REST re-fetch; polling remains the fallback | Single-process is enough; the socket is a latency optimisation, never a correctness dependency |
| No third-party requests from the widget or console (system fonts, no CDN, no analytics); scripts are external files so a strict CSP (`script-src 'self'`) applies | Privacy and independence |
| Configuration only through environment variables, validated at start-up; no hard-coded domains | The chat domain comes from the embed script's own `src` and from `PUBLIC_URL` |
| Operator sessions/passwords keep the dependency-free design (scrypt + hashed session tokens in PostgreSQL), with a higher scrypt cost | No new dependency; modern cost parameters |
| Logs carry method and path only (no client address, no headers) | Data minimisation |
| Neutral defaults: blue accent, system fonts, English text, `Example Shop` demo | No brand material |

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
