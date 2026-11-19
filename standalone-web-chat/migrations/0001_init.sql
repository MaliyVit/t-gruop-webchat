-- 0001_init: complete schema of the standalone web chat.
-- Applied once by the migration runner (src/migrate.ts), inside a transaction.

CREATE TABLE operators (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,            -- scrypt$N$r$p$salt$hash, never clear text
  role          TEXT NOT NULL DEFAULT 'operator',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE operator_sessions (
  id           BIGSERIAL PRIMARY KEY,
  operator_id  BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,      -- SHA-256 of the cookie token; the raw token is never stored
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX operator_sessions_operator_idx ON operator_sessions (operator_id);
CREATE INDEX operator_sessions_expires_idx  ON operator_sessions (expires_at);

CREATE TABLE conversations (
  id                       BIGSERIAL PRIMARY KEY,
  public_id                UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  -- Browser-generated random token kept in the visitor's localStorage. It is a
  -- bearer credential for the visitor's own conversations: never log it.
  visitor_id               TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'new'
                           CHECK (status IN ('new', 'open', 'waiting', 'resolved', 'closed')),
  source_page              TEXT,          -- origin + path of the embedding page, no query string
  external_ref             TEXT,          -- free reference for a CRM (contact / deal id)
  suspected_spam           BOOLEAN NOT NULL DEFAULT false,
  spam_reason              TEXT,
  operator_seen_message_id BIGINT NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversations_visitor_idx ON conversations (visitor_id);
CREATE INDEX conversations_status_idx  ON conversations (status);
CREATE INDEX conversations_updated_idx ON conversations (updated_at, id);

CREATE TABLE messages (
  id                 BIGSERIAL PRIMARY KEY,   -- the id is the thread order
  conversation_id    BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type        TEXT NOT NULL CHECK (sender_type IN ('visitor', 'operator')),
  sender_name        TEXT,
  sender_operator_id BIGINT REFERENCES operators(id) ON DELETE SET NULL,
  body               TEXT NOT NULL,
  idempotency_key    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, id);
-- A retried send with the same key inside one conversation is the same message.
CREATE UNIQUE INDEX messages_idempotency_idx
  ON messages (conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
