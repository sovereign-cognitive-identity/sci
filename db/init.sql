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

-- ── Seed ──────────────────────────────────────────────────────────────────────

INSERT INTO profiles (name) VALUES ('work'), ('personal');
-- Run `sci setup` after first start to generate your trusted token.
