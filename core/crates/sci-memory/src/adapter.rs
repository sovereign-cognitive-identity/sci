//! `LocalAdapter` — the storage entrypoint for the Sci Rust core.
//!
//! Mirrors the methods on the TS `StorageAdapter` interface. Methods are
//! synchronous; the caller (the platform shell + sci-handlers) is
//! expected to wrap them in `tokio::task::spawn_blocking` when
//! integrating with an async runtime. SQLite connections aren't
//! `Send + Sync`, so a per-task ownership model fits cleanly with that
//! pattern.
//!
//! What's implemented for SCI-125:
//!
//!   - lifecycle (`open`, `close`)
//!   - profiles: list / get / create
//!   - episodic / semantic / identity stores: persist row + embedding
//!   - identity-fact query (used by SCI-124's custom-entity loader)
//!   - recall (delegates to `recall::recall`)
//!   - stats
//!
//! Stubbed (return `MemoryError::NotFound("...; not yet implemented (SCI-X)")`):
//!
//!   - reinforce_semantic / update_decay_score / get_semantic_nodes /
//!     get_semantic_nodes_for_graph — used by the consolidation cron
//!     (`@sci/core/consolidation-cron.ts`). Lands with the cron
//!     port; not critical-path for handler dispatch.
//!   - get_episodic_memories_in_window / count_episodic_memories_in_window /
//!     get_last_episodic_write — also consolidation-flavored.
//!   - find_similar_semantic_node / insert_semantic_edge — consolidator
//!     internals.
//!   - record_write / get_last_consolidation_run / record_consolidation_run
//!     — audit + cron metadata, not on the hot path.

use crate::error::{MemoryError, Result};
use crate::recall::{embedding_to_bytes, recall};
use crate::schema::{EMBEDDING_DIM, SCHEMA, SEED_PROFILES};
use crate::types::{
    IdentityFact, Metadata, Profile, RecallQuery, RecallResult, StorageStats, StoreEpisodicInput,
    StoreIdentityInput, StoreSemanticInput,
};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use uuid::Uuid;

pub struct LocalAdapter {
    conn:    Connection,
    backend: String,
}

impl LocalAdapter {
    /// Open or create the database at `path`. On first open: applies
    /// the schema, seeds the `'work'` and `'personal'` profiles. The
    /// path's parent directory must exist; we don't `mkdir -p` to keep
    /// behavior obvious — the platform shell is the right layer for
    /// "ensure config directory" logic.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// In-memory database — used by tests and the doctor's smoke
    /// suite. Same schema, no persistence. The backend label flips to
    /// `'sqlite-mem'` so observability surfaces don't lie about where
    /// state lives.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init_with_backend(conn, "sqlite-mem")
    }

    fn init(conn: Connection) -> Result<Self> {
        Self::init_with_backend(conn, "sqlite-local")
    }

    fn init_with_backend(conn: Connection, backend: &str) -> Result<Self> {
        conn.execute_batch(SCHEMA)?;
        let adapter = LocalAdapter { conn, backend: backend.to_string() };
        adapter.seed_profiles()?;
        Ok(adapter)
    }

    fn seed_profiles(&self) -> Result<()> {
        for name in SEED_PROFILES {
            self.conn.execute(
                "INSERT OR IGNORE INTO profiles (id, name) VALUES (?1, ?2)",
                params![Uuid::new_v4().to_string(), name],
            )?;
        }
        Ok(())
    }

    /// Cleanly close the connection. SQLite flushes WAL on drop, so the
    /// caller doesn't strictly need to call this — but having an
    /// explicit shutdown is the contract sci-handlers expects from
    /// the StorageAdapter trait when we wire it.
    pub fn close(self) -> Result<()> {
        // `Connection::close` returns `Result<(), (Connection, Error)>`
        // — the connection comes back if it can't close. We bubble
        // the error and drop the connection on success.
        self.conn
            .close()
            .map_err(|(_, e)| MemoryError::from(e))
    }

    pub fn backend(&self) -> &str {
        &self.backend
    }

    // ── Profiles ───────────────────────────────────────────────────────────

    pub fn list_profiles(&self) -> Result<Vec<Profile>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, created_at FROM profiles ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], row_to_profile)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_profile(&self, name: &str) -> Result<Option<Profile>> {
        let row = self.conn
            .query_row(
                "SELECT id, name, created_at FROM profiles WHERE name = ?1",
                params![name],
                row_to_profile,
            )
            .optional()?;
        Ok(row)
    }

    /// Idempotent: returns the existing profile if `name` is already
    /// present. Same contract as the TS `createProfile`.
    pub fn create_profile(&self, name: &str) -> Result<Profile> {
        if let Some(p) = self.get_profile(name)? {
            return Ok(p);
        }
        let id = Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO profiles (id, name) VALUES (?1, ?2)",
            params![id, name],
        )?;
        // Read back so created_at reflects whatever SQLite stamped.
        Ok(self.get_profile(name)?.expect("just inserted"))
    }

    // ── Stores ─────────────────────────────────────────────────────────────

    pub fn store_episodic(&self, input: &StoreEpisodicInput<'_>) -> Result<String> {
        check_dim(input.embedding)?;
        let id = Uuid::new_v4().to_string();
        let metadata_json = serde_json::to_string(&input.metadata)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO episodic_memories
               (id, profile_id, content, source, agent_id, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                input.profile_id,
                input.content,
                input.source.unwrap_or("sci"),
                input.agent_id,
                metadata_json,
            ],
        )?;
        tx.execute(
            "INSERT INTO embeddings (memory_id, memory_type, embedding)
             VALUES (?1, 'episodic', ?2)",
            params![id, embedding_to_bytes(input.embedding)],
        )?;
        tx.commit()?;
        Ok(id)
    }

    pub fn store_semantic(&self, input: &StoreSemanticInput<'_>) -> Result<String> {
        check_dim(input.embedding)?;
        let id = Uuid::new_v4().to_string();
        let metadata_json = serde_json::to_string(&input.metadata)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO semantic_nodes
               (id, profile_id, content, category, confidence, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                input.profile_id,
                input.content,
                input.category,
                input.confidence.unwrap_or(1.0),
                metadata_json,
            ],
        )?;
        tx.execute(
            "INSERT INTO embeddings (memory_id, memory_type, embedding)
             VALUES (?1, 'semantic', ?2)",
            params![id, embedding_to_bytes(input.embedding)],
        )?;
        tx.commit()?;
        Ok(id)
    }

    pub fn store_identity_fact(&self, input: &StoreIdentityInput<'_>) -> Result<String> {
        check_dim(input.embedding)?;
        let id = Uuid::new_v4().to_string();
        let metadata_json = serde_json::to_string(&input.metadata)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO identity_facts
               (id, content, category, confidence, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                id,
                input.content,
                input.category,
                input.confidence.unwrap_or(1.0),
                metadata_json,
            ],
        )?;
        tx.execute(
            "INSERT INTO embeddings (memory_id, memory_type, embedding)
             VALUES (?1, 'identity', ?2)",
            params![id, embedding_to_bytes(input.embedding)],
        )?;
        tx.commit()?;
        Ok(id)
    }

    // ── Queries ────────────────────────────────────────────────────────────

    pub fn recall(&self, q: &RecallQuery<'_>) -> Result<Vec<RecallResult>> {
        check_dim(q.query_embedding)?;
        recall(&self.conn, q)
    }

    /// Fetch identity facts. Filters by category if supplied. Used by
    /// SCI-124's custom-entity loader (the regex-over-fact-content
    /// extraction). When `query_embedding` is supplied, results are
    /// ordered by cosine similarity instead of confidence — but for
    /// SCI-125 we only implement the confidence-ordered branch since
    /// the loader's only need is "give me everything tagged 'project'."
    pub fn query_identity_facts(
        &self,
        category: Option<&str>,
        limit: usize,
    ) -> Result<Vec<IdentityFact>> {
        let limit = limit as i64;
        let mut stmt;
        let rows = if let Some(cat) = category {
            stmt = self.conn.prepare(
                "SELECT id, content, category, confidence, created_at, metadata
                   FROM identity_facts
                  WHERE category = ?1
                  ORDER BY confidence DESC
                  LIMIT ?2",
            )?;
            stmt.query_map(params![cat, limit], row_to_identity_fact)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            stmt = self.conn.prepare(
                "SELECT id, content, category, confidence, created_at, metadata
                   FROM identity_facts
                  ORDER BY confidence DESC
                  LIMIT ?1",
            )?;
            stmt.query_map(params![limit], row_to_identity_fact)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

    pub fn get_stats(&self) -> Result<StorageStats> {
        let count = |sql: &str| -> Result<i64> {
            Ok(self.conn.query_row(sql, [], |r| r.get(0))?)
        };
        Ok(StorageStats {
            episodic:   count("SELECT COUNT(*) FROM episodic_memories")?,
            semantic:   count("SELECT COUNT(*) FROM semantic_nodes")?,
            identity:   count("SELECT COUNT(*) FROM identity_facts")?,
            embeddings: count("SELECT COUNT(*) FROM embeddings")?,
            backend:    self.backend.clone(),
        })
    }
}

// ── Row mappers ────────────────────────────────────────────────────────────

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    let id:         String = row.get(0)?;
    let name:       String = row.get(1)?;
    let created_at: String = row.get(2)?;
    Ok(Profile {
        id,
        name,
        created_at: parse_datetime(&created_at).unwrap_or_else(Utc::now),
    })
}

fn row_to_identity_fact(row: &rusqlite::Row<'_>) -> rusqlite::Result<IdentityFact> {
    let id:           String         = row.get(0)?;
    let content:      String         = row.get(1)?;
    let category:     Option<String> = row.get(2)?;
    let confidence:   f64            = row.get(3)?;
    let created_at:   String         = row.get(4)?;
    let metadata_raw: String         = row.get(5)?;
    let metadata:     Metadata       = serde_json::from_str(&metadata_raw).unwrap_or_default();
    Ok(IdentityFact {
        id,
        content,
        category,
        confidence,
        created_at: parse_datetime(&created_at).unwrap_or_else(Utc::now),
        metadata,
    })
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn check_dim(emb: &[f32]) -> Result<()> {
    if emb.len() == EMBEDDING_DIM {
        Ok(())
    } else {
        Err(MemoryError::EmbeddingDim {
            expected: EMBEDDING_DIM,
            got:      emb.len(),
        })
    }
}

/// SQLite's `datetime('now')` returns `'YYYY-MM-DD HH:MM:SS'` without a
/// `T` separator or timezone. Real ISO-8601 is also possible if a caller
/// inserted from elsewhere. Try both.
pub(crate) fn parse_datetime(s: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|n| n.and_utc())
}
