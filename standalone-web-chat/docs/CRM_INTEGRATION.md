# Connecting a CRM later

The chat works on its own. When you are ready to connect it to a CRM, everything you need is the
**Integration API** (see [API.md](API.md#integration-api-crm)). Nothing CRM-specific is built in, and nothing
calls out to your CRM — your CRM calls the chat.

## 1. Enable access

Set a long random token and restart the app:

```
INTEGRATION_API_TOKEN=<openssl rand -hex 32>
```

Your CRM backend sends `Authorization: Bearer <token>`. Keep the token server-side (never in a browser),
reach the chat over HTTPS, and rotate it by changing the variable. If you leave it empty, the endpoints
accept operator sessions only.

## 2. Pull conversations (incremental sync)

```
GET /api/integration/conversations?updated_since=<cursor>&limit=200
→ { conversations: [...], next_cursor }
```

1. First run: omit `updated_since` and page forward.
2. Store `next_cursor` after each batch and send it as `updated_since` next time.
3. Upsert by the conversation `id` (UUID). The boundary row may repeat once.
4. Fetch message bodies on demand: `GET /api/integration/conversations/:id/messages?after=<lastSeenMessageId>`.

A conversation's `updated_at` moves whenever a message is added or its status changes, so one cursor is
enough to notice both new messages and status changes. Poll every few seconds to minutes depending on
how fresh your CRM view must be.

## 3. Link a chat to a CRM record

Store your CRM's contact/deal id on the conversation so both sides can find each other:

```
PATCH /api/integration/conversations/:id    { "external_ref": "crm-contact-1234" }
```

Operators can also type the reference into the inbox ("CRM reference"). `external_ref` is returned by every
integration endpoint and is never shown to visitors.

## 4. Suggested mapping

| Chat | CRM |
|---|---|
| `id` (UUID) | external id of the chat / activity record |
| `external_ref` | the CRM contact or deal id |
| `status` | `new`/`open`/`waiting` → open activity; `resolved`/`closed` → done |
| `source_page` | where the visitor was (origin + path only) |
| messages (`sender_type`, `sender_name`, `body`, `created_at`) | timeline entries |

## 5. Who is the visitor?

The chat is deliberately anonymous: it stores a random browser token, not a person. Identity is yours to
add. Typical options once you integrate: (a) an operator asks for a phone/e-mail in the conversation and
records the CRM id in `external_ref`; (b) later, a signed-in-user hand-off from your site (not implemented
here — it needs a server-signed assertion so visitors cannot impersonate customers).

## 6. What is not implemented (by design, for now)

- **Webhooks / push to the CRM.** Use polling today. Adding a webhook means calling your CRM from
  `src/service.ts` after a message is stored (the `publish()` call sites are the natural hook points);
  add retries and a delivery log if you do.
- **Replying from the CRM.** The operator console is the reply channel. A CRM reply endpoint would reuse
  `postOperatorMessage()` in `src/service.ts` with a service identity instead of a session.
- **Contact/customer tables.** Add them in a new migration when you know your CRM's data model.
