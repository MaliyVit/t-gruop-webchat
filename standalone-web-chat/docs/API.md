# API reference

All endpoints are served by the app itself (same origin as the widget and the operator console). Bodies
are JSON. Errors are `{"error": "<message>"}`. State-changing requests that carry an `Origin` header must
come from the chat's own origin (`403` otherwise); server-to-server calls without `Origin` are fine.

Examples use `$CHAT` for the base URL, `$V` for a visitor token and `$COOKIE` for an operator session.

## Conventions

- **Ids.** Conversations and messages have numeric ids (message ids define the thread order). Integration
  endpoints use the conversation's public UUID instead.
- **Rate limits.** Public endpoints answer `429` (with `Retry-After`) when a client address exceeds
  `RATE_LIMIT_*`. Limits are per address and per route.
- **Limits.** Message text ≤ 4000 characters, request body ≤ 32 KiB, idempotency key ≤ 128 characters,
  CRM reference ≤ 200 characters. NUL and other control characters (except tab/CR/LF) are rejected.
- **Idempotency.** `idempotency_key` makes a retry safe: repeating a request with the same key returns the
  original message (`200` instead of `201`) and stores nothing new.

## Public

### `GET /healthz`
`{"status":"ok","db":"ok"}`, or `503` when the database is unreachable.

### `GET /api/widget-config`
`{title, greeting, accent, locale, max_message_length}` — presentation only, no secrets.

## Visitor API (the widget)

Credential: header `X-Chat-Visitor-Id: <token>` — 16–128 characters of `[A-Za-z0-9_-]`. Generate it with a
CSPRNG (the widget uses 192 random bits) and keep it private: it is the only thing proving ownership of
the visitor's conversations. Every refusal on a conversation route is the same
`404 {"error":"conversation not found"}`.

### `POST /api/visitor/conversations`
Start a conversation, or **continue the visitor's active one** (statuses `new`/`open`/`waiting`).

```json
{ "first_message": "Hi, I have a question about your page.", "source_page": "https://www.example.com/page/1?utm=x",
  "start_new": false, "idempotency_key": "b1c2…" }
```

- `source_page` is optional; only origin + path are kept.
- `start_new: true` forces a new conversation.
- `201 {id, status, continued:false}` for a new conversation, `200 {…, continued:true}` when an existing
  one received the message.
- `400 {code:"message_too_short", min_chars}` when the first message is below the configured minimum.
- A conversation created while over the flood limits is still created (and returned normally) but flagged
  `suspected_spam` and hidden from the operators' default list.

### `GET /api/visitor/conversation`
`{"conversation": {id, status} | null}` — the visitor's active conversation (used to resume after a reload).

### `GET /api/visitor/conversations/:id`
`{id, status, operator_name, lifecycle}` where `lifecycle` is `active` or `closed`
(`resolved`/`closed`); `operator_name` is the last operator who replied.

### `GET /api/visitor/conversations/:id/messages?after=<messageId>`
Messages with id greater than `after` (default 0), ascending, at most 500 per call — page with the last id.
Each message: `{id, conversation_id, sender_type: "visitor"|"operator", sender_name, body, created_at}`.

### `POST /api/visitor/conversations/:id/messages`
`{ "body": "text", "idempotency_key": "…" }` → `201`/`200` with the stored message. A visitor message
reopens a `waiting`, `resolved` or `closed` conversation.

## Operator API (cookie session)

### `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`
Login body `{email, password}` → `200 {operator}` and a `chat_session` cookie (`HttpOnly`, `SameSite=Lax`,
`Secure` when `COOKIE_SECURE=true`). Wrong e-mail and wrong password give the same `401`. Logout deletes
the session server-side (`204`). Login is limited to `RATE_LIMIT_LOGIN_PER_MINUTE` per address.

All endpoints below return `401` without a valid session.

### `GET /api/conversations?status=<s>&spam=<exclude|include|only>`
`{conversations: [...], counts_by_status: {...}, suspected_spam_count}` — freshest activity first, at most
200. Each item has `id, public_id, status, source_page, external_ref, suspected_spam, spam_reason,
last_message, last_sender_type, last_activity_at, unread_count, created_at, updated_at`.

### `GET /api/conversations/:id`
The conversation plus all its `messages`.

### `GET /api/conversations/:id/messages?after=<id>`
Incremental messages (same shape and paging as the visitor endpoint).

### `POST /api/conversations/:id/messages`
`{body, idempotency_key?}` → the stored message, attributed to the logged-in operator (the client cannot
choose the sender name). `409` if the conversation is `resolved`/`closed`.

### `POST /api/conversations/:id/seen`
`{last_message_id}` — marks the thread read for the shared inbox (does not count as activity).

### `PATCH /api/conversations/:id`
Any of `{status, suspected_spam, external_ref}`. Unknown fields are rejected (`400`). `status` is one of
`new, open, waiting, resolved, closed`; `external_ref` is a string or `null`.

## Realtime: `GET /ws` (WebSocket)

Send JSON frames after connecting; the server answers with `{"type":"ready"}` first.

| Client frame | Who | Effect |
|---|---|---|
| `{"action":"subscribe","conversation":<id>,"visitor_id":"<token>"}` | visitor | Subscribe to a conversation the token owns |
| `{"action":"subscribe","conversation":<id>}` | operator (cookie) | Subscribe to any conversation |
| `{"action":"subscribe","inbox":true}` | operator (cookie) | Subscribe to changes across all conversations |
| `{"action":"unsubscribe","conversation":<id>}` | both | |

Server frames: `{"type":"subscribed","conversationId"}`, `{"type":"message","conversationId"}` (new
message), `{"type":"meta","conversationId"}` (status/flags changed), `{"type":"inbox","conversationId"}`
(inbox feed), `{"type":"error","error"}`. Pokes carry **no content** — re-fetch over REST, which is where
authorization is enforced. Browsers must connect from the chat's own origin (`1008` otherwise); an
operator socket is closed (`4401`) when its session ends. Frames are limited to 4 KiB.

## Integration API (CRM)

Authentication: `Authorization: Bearer <INTEGRATION_API_TOKEN>` (disabled when the variable is empty) **or**
an operator session. Conversations are addressed by public UUID; internal ids and the visitor token are
never returned. See [CRM_INTEGRATION.md](CRM_INTEGRATION.md) for usage patterns.

### `GET /api/integration/conversations?updated_since=<ISO time>&limit=<1..500>`
```json
{ "conversations": [ { "id": "6f1c…-uuid", "status": "open", "source_page": "https://www.example.com/page/1",
    "external_ref": "crm-42", "suspected_spam": false, "message_count": 4,
    "last_message_at": "2026-01-01T10:00:00Z", "created_at": "…", "updated_at": "…" } ],
  "count": 1, "next_cursor": "2026-01-01T10:00:00.123Z" }
```
Ordered by `updated_at` ascending. Pass `next_cursor` back as `updated_since`; the boundary row can be
delivered twice, so upsert by `id`.

### `GET /api/integration/conversations/:uuid`
One conversation (same shape). `400` for a malformed UUID, `404` if unknown.

### `GET /api/integration/conversations/:uuid/messages?after=<messageId>`
`[{id, sender_type, sender_name, body, created_at}]`, ascending, at most 500 per call.

### `PATCH /api/integration/conversations/:uuid`
`{external_ref?, status?}` — link the conversation to a CRM record and/or change its status. Returns the
updated conversation.
