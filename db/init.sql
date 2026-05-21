-- ── Sci — Full Schema ──────────────────────────────────────────────────────────
-- Single source of truth. Applied automatically on docker compose up (first init).
-- For existing installs running individual migrations, this file is idempotent.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Roles ─────────────────────────────────────────────────────────────────────

CREATE ROLE db_reader NOLOGIN;
CREATE ROLE db_writer NOLOGIN;

CREATE USER sci_reader WITH PASSWORD 'sci_reader_local' IN ROLE db_reader;
CREATE USER sci_writer WITH PASSWORD 'sci_writer_local' IN ROLE db_writer;

-- ── Core tables ───────────────────────────────────────────────────────────────

CREATE TABLE profiles (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE episodic_memories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id  UUID REFERENCES profiles(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  source      TEXT,
  agent_id    TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata    JSONB NOT NULL DEFAULT '{}',
  fts         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE INDEX episodic_memories_fts_idx ON episodic_memories USING GIN (fts);

CREATE TABLE semantic_nodes (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id       UUID REFERENCES profiles(id) ON DELETE CASCADE,
  content          TEXT NOT NULL,
  category         TEXT,
  confidence       FLOAT NOT NULL DEFAULT 1.0,
  decay_score      FLOAT NOT NULL DEFAULT 1.0,
  access_count     INT NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata         JSONB NOT NULL DEFAULT '{}',
  fts              tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE INDEX semantic_nodes_fts_idx ON semantic_nodes USING GIN (fts);

CREATE TABLE semantic_edges (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id    UUID NOT NULL REFERENCES semantic_nodes(id) ON DELETE CASCADE,
  target_id    UUID NOT NULL REFERENCES semantic_nodes(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,
  confidence   FLOAT NOT NULL DEFAULT 0.7,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, target_id, relationship)
);

CREATE TABLE identity_facts (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content    TEXT NOT NULL,
  category   TEXT,
  confidence FLOAT NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata   JSONB NOT NULL DEFAULT '{}',
  fts        tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE INDEX identity_facts_fts_idx ON identity_facts USING GIN (fts);

CREATE TABLE embeddings (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_type TEXT NOT NULL,
  memory_id   UUID NOT NULL,
  model_id    TEXT NOT NULL,
  embedding   vector(768),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (memory_type, memory_id, model_id)
);

CREATE INDEX ON embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE write_queue (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation    TEXT NOT NULL,
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE agents (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  tier       TEXT NOT NULL DEFAULT 'trusted',
  profile_id UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agents_name_unique UNIQUE (name)
);

CREATE TABLE agent_tokens (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  token_hint   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ
);

CREATE TABLE connect_requests (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code       TEXT NOT NULL UNIQUE,
  agent_name TEXT NOT NULL,
  tier       TEXT NOT NULL DEFAULT 'standard',
  profile_id UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  used_at    TIMESTAMPTZ
);

CREATE TABLE consolidation_runs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ran_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_start        TIMESTAMPTZ NOT NULL,
  window_end          TIMESTAMPTZ NOT NULL,
  episodic_processed  INT NOT NULL DEFAULT 0,
  semantic_promoted   INT NOT NULL DEFAULT 0,
  semantic_reinforced INT NOT NULL DEFAULT 0,
  nodes_decayed       INT NOT NULL DEFAULT 0,
  digest_id           UUID REFERENCES episodic_memories(id),
  model_used          TEXT,
  duration_ms         INT
);

-- ── Control plane tables ─────────────────────────────────────────────────────

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  display_name   TEXT,
  is_admin       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at  TIMESTAMPTZ
);

CREATE TABLE user_sessions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  ip_address   TEXT,
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX user_sessions_user_id_idx ON user_sessions (user_id);

CREATE TABLE devices (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id      UUID REFERENCES profiles(id),
  agent_id        UUID REFERENCES agents(id),
  name            TEXT NOT NULL,
  platform        TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  wg_public_key   TEXT,
  wg_preshared_key TEXT,
  wg_assigned_ip  TEXT,
  last_seen_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX devices_user_id_idx ON devices (user_id);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id),
  agent_id   UUID REFERENCES agents(id),
  device_id  UUID REFERENCES devices(id),
  action     TEXT NOT NULL,
  target     TEXT,
  outcome    TEXT NOT NULL DEFAULT 'ok',
  metadata   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_log_user_id_idx    ON audit_log (user_id);
CREATE INDEX audit_log_created_at_idx ON audit_log (created_at DESC);

CREATE TABLE gateway_state (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wg_private_key    TEXT NOT NULL,
  wg_public_key     TEXT NOT NULL,
  wg_listen_port    INT NOT NULL DEFAULT 51820,
  wg_subnet         TEXT NOT NULL DEFAULT '10.13.13.0/24',
  wg_server_ip      TEXT NOT NULL DEFAULT '10.13.13.1',
  proxy_ip          TEXT NOT NULL DEFAULT '10.13.13.1',
  external_endpoint TEXT,
  next_peer_octet   INT NOT NULL DEFAULT 2,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE exposure_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id),
  device_id   UUID REFERENCES devices(id),
  hostname    TEXT NOT NULL,
  vendor_id   TEXT,
  query_type  TEXT,
  resolved_ip TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX exposure_events_user_id_idx    ON exposure_events (user_id);
CREATE INDEX exposure_events_created_at_idx ON exposure_events (created_at DESC);

-- Add user_id to profiles for multi-tenant scoping (nullable: NULL = orphan/legacy)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- ── Grants ────────────────────────────────────────────────────────────────────

GRANT SELECT ON ALL TABLES IN SCHEMA public TO db_reader;

GRANT SELECT, INSERT, UPDATE ON
  episodic_memories,
  semantic_nodes,
  semantic_edges,
  identity_facts,
  embeddings,
  write_queue,
  profiles,
  consolidation_runs
TO db_writer;

GRANT SELECT, INSERT, UPDATE, DELETE ON agents TO db_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_tokens TO db_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON connect_requests TO db_writer;

GRANT SELECT, INSERT, UPDATE ON users TO db_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_sessions TO db_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON devices TO db_writer;
GRANT SELECT, INSERT ON audit_log TO db_writer;
GRANT SELECT, INSERT, UPDATE ON gateway_state TO db_writer;
GRANT SELECT, INSERT ON exposure_events TO db_writer;

-- ── Seed ──────────────────────────────────────────────────────────────────────

INSERT INTO profiles (name) VALUES ('work'), ('personal') ON CONFLICT (name) DO NOTHING;
-- Run POST /api/setup/init after first start to create your account.
