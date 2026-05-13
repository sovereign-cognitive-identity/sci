//! Database schema — mirrors `_initSchema` in
//! `packages/core/src/storage/cloud-adapter.ts`, with two material
//! differences:
//!
//!   1. **Embeddings live inside SQLite, not a sibling `.idx` file.**
//!      The TS adapter writes vectors into hnswlib (an external file);
//!      we put them in an `embeddings` table keyed by
//!      `(memory_id, memory_type)`, stored as raw f32 little-endian
//!      blobs. Brute-force cosine over this table is sub-100ms up to
//!      ~5k memories, fine for v0.5. When `sqlite-vec` stabilizes
//!      (the only published version is alpha.3 with a build bug as
//!      of 2026-05-09), we swap recall to use a vec0 virtual table
//!      with no API change. See `recall.rs`.
//!
//!   2. **CHECK constraints on `confidence` / `decay_score`.** SQLite
//!      doesn't enforce them by default; the TS code didn't add
//!      them; we do, so a bug in a sibling crate can't quietly
//!      poison the store with out-of-range scores.

/// Embedding dimension, set by the embedding model. BGE-base-en-v1.5
/// emits 768-dim float32. Not configurable at runtime — the vec0
/// virtual table needs it baked into the schema, and changing it
/// requires migration.
pub const EMBEDDING_DIM: usize = 768;

/// Schema applied via `Connection::execute_batch` on `connect()`. Idempotent
/// — every CREATE uses `IF NOT EXISTS` so repeat connects are safe and
/// re-opening an existing DB doesn't trip up. Profile seeds use
/// `INSERT OR IGNORE` so callers can re-seed without UNIQUE collisions.
pub const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS episodic_memories (
    id          TEXT PRIMARY KEY,
    profile_id  TEXT NOT NULL REFERENCES profiles(id),
    content     TEXT NOT NULL,
    source      TEXT,
    agent_id    TEXT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    metadata    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS semantic_nodes (
    id               TEXT PRIMARY KEY,
    profile_id       TEXT NOT NULL REFERENCES profiles(id),
    content          TEXT NOT NULL,
    category         TEXT,
    confidence       REAL NOT NULL DEFAULT 1.0
                       CHECK (confidence BETWEEN 0.0 AND 1.0),
    decay_score      REAL NOT NULL DEFAULT 1.0
                       CHECK (decay_score BETWEEN 0.0 AND 1.0),
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    metadata         TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS identity_facts (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    category    TEXT,
    confidence  REAL NOT NULL DEFAULT 1.0
                  CHECK (confidence BETWEEN 0.0 AND 1.0),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    metadata    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS semantic_edges (
    id           TEXT PRIMARY KEY,
    source_id    TEXT NOT NULL REFERENCES semantic_nodes(id) ON DELETE CASCADE,
    target_id    TEXT NOT NULL REFERENCES semantic_nodes(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL,
    confidence   REAL NOT NULL DEFAULT 0.7,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source_id, target_id, relationship)
);

CREATE TABLE IF NOT EXISTS write_queue (
    id           TEXT PRIMARY KEY,
    operation    TEXT NOT NULL,
    payload      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'done',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
);

CREATE TABLE IF NOT EXISTS consolidation_runs (
    id                  TEXT PRIMARY KEY,
    ran_at              TEXT NOT NULL DEFAULT (datetime('now')),
    window_start        TEXT NOT NULL,
    window_end          TEXT NOT NULL,
    episodic_processed  INTEGER NOT NULL DEFAULT 0,
    semantic_promoted   INTEGER NOT NULL DEFAULT 0,
    semantic_reinforced INTEGER NOT NULL DEFAULT 0,
    nodes_decayed       INTEGER NOT NULL DEFAULT 0,
    digest_id           TEXT,
    model_used          TEXT,
    duration_ms         INTEGER
);

-- Embeddings, brute-force-search-friendly. One row per (memory_id, memory_type)
-- with the raw f32 little-endian blob. `embedding` is BLOB rather than a
-- BLOB-typed column with the float[N] hint because we never let SQLite
-- look inside it — recall reads the rows back into Rust where the cosine
-- math runs. When we swap to sqlite-vec, this table becomes a `vec0`
-- virtual table with `+memory_id` / `+memory_type` auxiliary columns,
-- and the only Rust code that changes is `recall.rs`.
CREATE TABLE IF NOT EXISTS embeddings (
    memory_id   TEXT NOT NULL,
    memory_type TEXT NOT NULL CHECK (memory_type IN ('episodic','semantic','identity')),
    embedding   BLOB NOT NULL,
    PRIMARY KEY (memory_id, memory_type)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(memory_type);

-- Helpful indexes for the most common access patterns.
CREATE INDEX IF NOT EXISTS idx_episodic_profile_time
    ON episodic_memories(profile_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_semantic_profile_decay
    ON semantic_nodes(profile_id, decay_score DESC, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_identity_category
    ON identity_facts(category, confidence DESC);

-- ─── Flight recorder ────────────────────────────────────────────────────────
--
-- One row per model turn that flowed through Sci. Wide on purpose: the
-- table isn't on the recall hot path, it's the raw material for
-- tuning the anonymization / deanonymization pipeline and rendering
-- the inspector panel. Six artifacts captured per turn:
--
--   user_text       : original (pre-anonymization) prompt as the user typed it
--   request_body    : full anonymized JSON sent to the upstream
--   response_raw    : upstream's raw bytes back (SSE concat or JSON), before deanon
--   assistant_text  : deanonymized response text, what the user actually read
--   recall_injected : memory text injected into the system prompt, for tuning
--   masked_count    : entity count, for sanity-checking the algorithm
--
-- `oauth_active` records whether the request used the Claude Pro/Max
-- bearer path (which is shape-gated and prefix-stamped — turns there
-- need different debugging assumptions than BYO-key turns).
CREATE TABLE IF NOT EXISTS audit_turns (
    id              TEXT PRIMARY KEY,
    profile_id      TEXT REFERENCES profiles(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    host            TEXT NOT NULL,
    endpoint        TEXT NOT NULL,
    model           TEXT,
    oauth_active    INTEGER NOT NULL DEFAULT 0,
    user_text       TEXT,
    assistant_text  TEXT,
    request_body    TEXT,
    response_raw    TEXT,
    recall_injected TEXT,
    masked_count    INTEGER NOT NULL DEFAULT 0,
    status          INTEGER,
    latency_ms      INTEGER,
    error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_turns_created
    ON audit_turns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_turns_profile_created
    ON audit_turns(profile_id, created_at DESC);

-- One row per anonymized entity per turn. Three first-class queries:
--
--   1. "every entity ever masked about Casey" →
--        SELECT * FROM token_mappings WHERE original = ?
--   2. "every entity from this specific turn" →
--        SELECT * FROM token_mappings WHERE turn_id = ?
--   3. "how often has 'OpenClaw' been masked across all turns" →
--        SELECT COUNT(*) FROM token_mappings WHERE original = 'OpenClaw'
--
-- direction is 'outbound' (entity in the user's prompt that we masked
-- before sending upstream) or 'inbound' (rare: a token in the model's
-- response that we deanonymized). Outbound is the common case;
-- inbound exists because the model sometimes reuses our mask tokens
-- when echoing back, and we want a record of the round-trip.
CREATE TABLE IF NOT EXISTS token_mappings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id       TEXT NOT NULL REFERENCES audit_turns(id) ON DELETE CASCADE,
    profile_id    TEXT REFERENCES profiles(id),
    token         TEXT NOT NULL,
    original      TEXT NOT NULL,
    entity_kind   TEXT NOT NULL,
    direction     TEXT NOT NULL
                    CHECK (direction IN ('outbound','inbound')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_token_mappings_turn
    ON token_mappings(turn_id);
CREATE INDEX IF NOT EXISTS idx_token_mappings_original
    ON token_mappings(original);
CREATE INDEX IF NOT EXISTS idx_token_mappings_token_profile
    ON token_mappings(token, profile_id);
"#;

/// Additive migrations applied after SCHEMA. Each is a single ALTER TABLE
/// that adds a column with a safe default. SQLite ignores "duplicate column"
/// errors so these are idempotent on databases that already have the column.
pub const MIGRATIONS: &[&str] = &[
    // Prompt-caching metrics (Anthropic cache_control feature).
    "ALTER TABLE audit_turns ADD COLUMN cache_creation_tokens INTEGER",
    "ALTER TABLE audit_turns ADD COLUMN cache_read_tokens     INTEGER",
    "ALTER TABLE audit_turns ADD COLUMN input_tokens          INTEGER",
    "ALTER TABLE audit_turns ADD COLUMN output_tokens         INTEGER",
];

/// Profile seeds — `'work'` is what `injectMemoryContext` looks up by
/// default; `'personal'` is for the eventual UI toggle. Same names as
/// the TS adapter so an existing user's data flows over.
pub const SEED_PROFILES: &[&str] = &["work", "personal"];
