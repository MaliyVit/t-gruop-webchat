# Standalone Web Chat

A self-hosted website chat you can run next to any site or CRM:

- **Embeddable widget** — one `<script>` tag, runs in an isolated iframe, works on desktop and mobile.
- **Realtime API** — REST + WebSocket, PostgreSQL storage, ordered and idempotent message delivery.
- **Operator inbox** — a small web console to read conversations, reply, and manage status.
- **Self-contained** — one `docker compose up` (app + PostgreSQL). No external services, no third-party
  requests from the widget or the console, no analytics.

CRM integration is **not** included, but a small documented API is ready for it
([docs/CRM_INTEGRATION.md](docs/CRM_INTEGRATION.md)).

```
 customer's website                 your server (docker compose)
┌───────────────────┐            ┌──────────────────────────────────────────┐
│ <script embed.js> │            │  app (Node 22 + Fastify)      db         │
│   └─ iframe ──────┼── HTTPS ──▶│  /widget  /operator  /api/*  ─▶ PostgreSQL│
│      widget       │◀── WSS ────│  /ws (realtime pokes)                    │
└───────────────────┘            └──────────────────────────────────────────┘
                                          ▲  operator browser (cookie session)
                                          ▲  your CRM backend (bearer token, optional)
```

## Quick start

Requirements: Docker with the Compose plugin.

```bash
cp .env.example .env

# fill in the two secrets (hex is safe inside a connection URL)
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s/^BOOTSTRAP_OPERATOR_PASSWORD=.*/BOOTSTRAP_OPERATOR_PASSWORD=$(openssl rand -hex 12)/" .env
grep BOOTSTRAP_OPERATOR .env        # note the operator e-mail and password

docker compose up -d --build
```

Then open (the app listens on `127.0.0.1:8080` by default):

| URL | What |
|---|---|
| <http://127.0.0.1:8080/demo> | Demo page with the widget embedded |
| <http://127.0.0.1:8080/operator> | Operator inbox (sign in with the bootstrap operator) |
| <http://127.0.0.1:8080/widget> | The widget on its own |
| <http://127.0.0.1:8080/healthz> | Health check |

Try it: send a message from the demo page, answer it in the operator inbox in another window.

A fresh database is created and migrated automatically on first start. The first operator is created
from `BOOTSTRAP_OPERATOR_*` only if that e-mail does not exist yet (restarts never reset a password).

## Embedding the widget

Add one line before `</body>` on every page that should show the chat:

```html
<script src="https://CHAT_DOMAIN/embed.js" defer></script>
```

Replace `CHAT_DOMAIN` with the domain you serve this app on. The loader takes the chat origin from its
own `src`, so nothing is hard-coded. It injects an iframe (bottom-right launcher, full-screen panel on
phones). The host page and the widget cannot touch each other's CSS or JavaScript.

Things to know:

- The page URL **without query string or fragment** is stored with each conversation, so operators see
  where the visitor was. Nothing else about the host page is read.
- If your site sets a Content-Security-Policy, allow the chat origin in `script-src` and `frame-src`.
- To restrict which sites may embed the widget, set `ALLOWED_EMBED_ORIGINS` (comma-separated origins).
  The server then sends `frame-ancestors` and browsers refuse to render the widget elsewhere.
- Look and language: `WIDGET_TITLE`, `WIDGET_GREETING`, `WIDGET_ACCENT` (`#rrggbb`), `WIDGET_LOCALE`
  (`en` or `uk`). Strings live in `public/widget.js` if you want to add a language.

## Configuration

All configuration is environment variables; invalid values stop the app at start-up with a clear message.
`.env.example` lists every variable. The important ones:

| Variable | Default | Purpose |
|---|---|---|
| `POSTGRES_PASSWORD` | — (required) | Database password (compose refuses to start without it) |
| `BOOTSTRAP_OPERATOR_EMAIL` / `_PASSWORD` / `_NAME` | — | First operator; password ≥ 10 characters |
| `HTTP_PORT`, `BIND_ADDRESS` | `8080`, `127.0.0.1` | Host port/interface. Keep localhost and use a TLS reverse proxy |
| `PUBLIC_URL` | — | Public URL of the chat; also accepted as a request/WebSocket origin |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the app. **Set `1` behind nginx/Caddy** (see below) |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `ALLOWED_EMBED_ORIGINS` | any | Sites allowed to embed the widget |
| `INTEGRATION_API_TOKEN` | disabled | Bearer token for `/api/integration/*` (CRM) |
| `RATE_LIMIT_WRITE_PER_MINUTE` | `60` | Public writes per address (start chat, send message) |
| `RATE_LIMIT_READ_PER_MINUTE` | `600` | Public reads per address (the widget polls as a fallback) |
| `RATE_LIMIT_LOGIN_PER_MINUTE` | `10` | Operator login attempts per address |
| `SPAM_*` | see `.env.example` | Flood rules for starting conversations |

### Production: TLS reverse proxy

The app speaks plain HTTP and WebSocket. Put a TLS-terminating proxy in front, keep the app bound to
localhost, and set `TRUST_PROXY_HOPS=1`, `COOKIE_SECURE=true` and `PUBLIC_URL=https://chat.example.com`.

> If `TRUST_PROXY_HOPS` is left at `0` behind a proxy, every visitor looks like the proxy's address and
> they all share one rate-limit budget. The app logs a warning when it sees this.

Caddy (handles WebSocket and forwarding headers automatically):

```
chat.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    server_name chat.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;                       # the app checks Origin against Host
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 75s;
    }
}
```

## Operators

```bash
# create or update an operator (password is read from the environment, never from argv)
docker compose exec -e OPERATOR_PASSWORD='a-long-random-password' app \
  node dist/create-operator.js alice@example.com "Alice" operator
```

Passwords are stored as scrypt hashes; sessions are random tokens stored hashed in the database and sent
in an `HttpOnly; SameSite=Lax` cookie. Changing an operator's password ends their open sessions.

The operator console lists conversations (freshest first, unread counts), shows the thread, lets you
reply (Enter to send), set the status (`new`, `open`, `waiting`, `resolved`, `closed`), store a free
"CRM reference", and clear the spam flag. Replying to a `new` conversation makes it `open`; a visitor
message reopens a `waiting`/`resolved`/`closed` conversation; operators cannot reply into a closed
conversation until it is reopened.

## How it works

- **Visitor identity.** The widget creates a random 192-bit token in its own `localStorage` and sends it as
  `X-Chat-Visitor-Id`. It is the only credential a visitor has, so it is never put in a URL and never
  logged. Every visitor endpoint answers *every* refusal (wrong visitor, missing credential, unknown id)
  with the same `404`, so conversation ids cannot be probed.
- **Resume.** After a reload the widget asks for the visitor's active conversation and reloads its
  history; the open/closed panel state survives in the tab.
- **Delivery.** Messages are stored first, ordered by a database sequence, and de-duplicated with
  client-generated idempotency keys so a retry after a lost response never duplicates a message.
- **Realtime.** The server pushes tiny "something changed" pokes over `/ws`; clients re-fetch over REST.
  If the socket drops, the widget reconnects with exponential backoff and keeps polling meanwhile.
- **Abuse protection.** Per-address rate limits on public endpoints, input validation and size limits,
  a flood guard on starting conversations (duplicates and bursts are flagged and hidden from the default
  inbox view, not dropped), and a global WebSocket connection cap.

Code map: `src/` (`server`, `routes`, `service`, `realtime`, `auth`, `spam-guard`, `validate`, `config`,
`migrate`), `migrations/`, `public/` (widget, operator console, loader, demo), `test/`, `scripts/`.

## API and CRM integration

- [docs/API.md](docs/API.md) — visitor, operator, WebSocket and integration endpoints.
- [docs/CRM_INTEGRATION.md](docs/CRM_INTEGRATION.md) — how to connect a CRM later.

## Tests

```bash
npm ci
npm test                     # unit tests (spam rules, validation, password hashing)

# end-to-end, against a running stack (synthetic data only; see the header of each script)
BASE_URL=http://127.0.0.1:8080 OPERATOR_EMAIL=... OPERATOR_PASSWORD=... npm run e2e
# real browser (Chromium via playwright-core), widget embedded from a different origin:
CHROMIUM=/path/to/chrome BASE_URL=... OPERATOR_EMAIL=... OPERATOR_PASSWORD=... npm run e2e:browser
```

Run the end-to-end scripts against a **throwaway** stack, not a deployment you care about: they create
conversations and exhaust rate limits on purpose. See [TEST_RESULTS.md](TEST_RESULTS.md).

## Privacy and data retention

Stored: message text, the visitor token, timestamps, the page URL without query/fragment, operator
accounts (e-mail, name, password hash). **Not stored:** IP addresses, user agents, cookies of the host
site. The flood guard keeps salted hashes of addresses in process memory only; access logs contain the
method and path only.

There is no automatic retention job. You are responsible for deleting data you no longer need, e.g.:

```bash
# delete one conversation and its messages
docker compose exec db psql -U chat -d chat -c "DELETE FROM conversations WHERE id = 123;"
# delete everything older than 12 months
docker compose exec db psql -U chat -d chat -c "DELETE FROM conversations WHERE updated_at < now() - interval '12 months';"
```

Tell your visitors that the chat stores their messages (privacy policy / consent as required where you operate).

Backups: `docker compose exec db pg_dump -U chat chat > backup.sql`.

## Limitations

- Single app process (in-memory realtime bus and rate limits). Scaling out needs a shared bus and store.
- Text only: no attachments, typing indicators or read receipts to visitors.
- No automatic data retention, no operator roles/permissions beyond `operator`/`admin` markers, no
  conversation assignment, no account lockout beyond per-address login rate limiting.
- The operator console is English only; the widget has `en` and `uk`.

## License

No license file is included yet. The repository owner must choose one before the code is published or
reused. Third-party dependencies are permissively licensed — see [NOTICE.md](NOTICE.md).
