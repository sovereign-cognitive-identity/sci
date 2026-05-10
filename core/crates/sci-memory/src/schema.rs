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
"#;

/// Profile seeds — `'work'` is what `injectMemoryContext` looks up by
/// default; `'personal'` is for the eventual UI toggle. Same names as
/// the TS adapter so an existing user's data flows over.
pub const SEED_PROFILES: &[&str] = &["work", "personal"];
