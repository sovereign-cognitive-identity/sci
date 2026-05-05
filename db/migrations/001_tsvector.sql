-- Phase 1: Add tsvector columns for hybrid retrieval
-- Run once against the live database

-- ── episodic_memories ────────────────────────────────────────────────────────

ALTER TABLE episodic_memories
  ADD COLUMN IF NOT EXISTS fts tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS episodic_memories_fts_idx
  ON episodic_memories USING GIN (fts);

-- ── semantic_nodes ───────────────────────────────────────────────────────────

ALTER TABLE semantic_nodes
  ADD COLUMN IF NOT EXISTS fts tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS semantic_nodes_fts_idx
  ON semantic_nodes USING GIN (fts);

-- ── identity_facts ────────────────────────────────────────────────────────────

ALTER TABLE identity_facts
  ADD COLUMN IF NOT EXISTS fts tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS identity_facts_fts_idx
  ON identity_facts USING GIN (fts);

-- ── Grant SELECT on fts columns to db_reader ─────────────────────────────────
-- (already covered by existing GRANT SELECT ON ALL TABLES)
