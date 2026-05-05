-- Phase 4: Nightly consolidation tracking table

CREATE TABLE consolidation_runs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ran_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_start      TIMESTAMPTZ NOT NULL,
  window_end        TIMESTAMPTZ NOT NULL,
  episodic_processed INT NOT NULL DEFAULT 0,
  semantic_promoted  INT NOT NULL DEFAULT 0,
  semantic_reinforced INT NOT NULL DEFAULT 0,
  nodes_decayed      INT NOT NULL DEFAULT 0,
  digest_id         UUID REFERENCES episodic_memories(id),
  model_used        TEXT,
  duration_ms       INT
);

-- Semantic node edges (relationships discovered during knowledge graph pass)
CREATE TABLE semantic_edges (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id    UUID NOT NULL REFERENCES semantic_nodes(id) ON DELETE CASCADE,
  target_id    UUID NOT NULL REFERENCES semantic_nodes(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,  -- 'relates_to', 'motivates', 'contradicts', 'part_of'
  confidence   FLOAT NOT NULL DEFAULT 0.7,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, target_id, relationship)
);

GRANT SELECT ON consolidation_runs TO db_reader;
GRANT SELECT ON semantic_edges TO db_reader;
GRANT SELECT, INSERT, UPDATE ON consolidation_runs TO db_writer;
GRANT SELECT, INSERT, UPDATE ON semantic_edges TO db_writer;
