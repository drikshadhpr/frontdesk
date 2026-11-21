CREATE TABLE IF NOT EXISTS agents (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('agent','manager'))
);

CREATE TABLE IF NOT EXISTS holidays (
  day  DATE PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id                     SERIAL PRIMARY KEY,
  ref                    TEXT GENERATED ALWAYS AS ('FD-' || lpad(id::text, 4, '0')) STORED,
  subject                TEXT NOT NULL,
  customer_name          TEXT NOT NULL,
  customer_email         TEXT NOT NULL,
  priority               TEXT NOT NULL CHECK (priority IN ('urgent','medium','low')),
  status                 TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','in_progress','waiting_on_customer','resolved','closed')),
  assignee_id            INT REFERENCES agents(id),
  access_token           TEXT NOT NULL UNIQUE,
  created_at             TIMESTAMPTZ NOT NULL,
  sla_start_at           TIMESTAMPTZ NOT NULL,
  first_response_at      TIMESTAMPTZ,
  response_breached      BOOLEAN NOT NULL DEFAULT FALSE,
  paused_since           TIMESTAMPTZ,
  paused_working_minutes DOUBLE PRECISION NOT NULL DEFAULT 0,
  resolved_at            TIMESTAMPTZ,
  resolution_breached    BOOLEAN NOT NULL DEFAULT FALSE,
  closed_at              TIMESTAMPTZ,
  close_reason           TEXT,
  follows_ticket_id      INT REFERENCES tickets(id),
  reopen_count           INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status);
CREATE INDEX IF NOT EXISTS tickets_assignee_idx ON tickets(assignee_id);

-- Customer-visible conversation. Never contains internal notes.
CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  ticket_id   INT NOT NULL REFERENCES tickets(id),
  author_type TEXT NOT NULL CHECK (author_type IN ('agent','customer')),
  agent_id    INT REFERENCES agents(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_ticket_idx ON messages(ticket_id, id);

-- Team-only notes live in their OWN table so no customer-facing query can
-- pick them up by accident (INC-0304).
CREATE TABLE IF NOT EXISTS internal_notes (
  id         BIGSERIAL PRIMARY KEY,
  ticket_id  INT NOT NULL REFERENCES tickets(id),
  agent_id   INT NOT NULL REFERENCES agents(id),
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_ticket_idx ON internal_notes(ticket_id, id);

-- Append-only audit log with a per-ticket hash chain (INC-0318).
CREATE TABLE IF NOT EXISTS ticket_events (
  id         BIGSERIAL PRIMARY KEY,
  ticket_id  INT NOT NULL REFERENCES tickets(id),
  at         TIMESTAMPTZ NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent','customer','system')),
  actor_id   INT,
  actor_name TEXT NOT NULL,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ticket_idx ON ticket_events(ticket_id, id);

CREATE OR REPLACE FUNCTION frontdesk_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_events','messages','internal_notes'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_immutable', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION frontdesk_block_mutation()', t || '_immutable', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_notruncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION frontdesk_block_mutation()', t || '_notruncate', t);
  END LOOP;
END $$;
