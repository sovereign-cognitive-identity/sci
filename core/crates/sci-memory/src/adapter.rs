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
use crate::schema::{EMBEDDING_DIM, MIGRATIONS, SCHEMA, SEED_PROFILES};
use crate::types::{
    AuditTurn, IdentityFact, Metadata, Profile, RecallQuery, RecallResult, StorageStats,
    StoreAuditTurnInput, StoreEpisodicInput, StoreIdentityInput, StoreSemanticInput, TokenDirection,
    TokenMapping,
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
        // Additive migrations — each ALTER TABLE is idempotent: SQLite
        // returns "duplicate column" on re-runs, which we swallow.
        for migration in MIGRATIONS {
            if let Err(e) = conn.execute_batch(migration) {
                let msg = e.to_string();
                if !msg.contains("duplicate column") {
                    return Err(e.into());
                }
            }
        }
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
    /// List episodic memories for a profile, newest-first. Used by the
    /// memory graph admin endpoint.
    pub fn list_episodic(
        &self,
        profile_id: Option<&str>,
        limit:      usize,
    ) -> Result<Vec<crate::types::EpisodicMemory>> {
        let limit = limit as i64;
        let mut stmt;
        let rows = if let Some(pid) = profile_id {
            stmt = self.conn.prepare(
                "SELECT id, profile_id, content, source, agent_id,
                        occurred_at, created_at, metadata
                   FROM episodic_memories
                  WHERE profile_id = ?1
                  ORDER BY occurred_at DESC
                  LIMIT ?2",
            )?;
            stmt.query_map(params![pid, limit], row_to_episodic)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            stmt = self.conn.prepare(
                "SELECT id, profile_id, content, source, agent_id,
                        occurred_at, created_at, metadata
                   FROM episodic_memories
                  ORDER BY occurred_at DESC
                  LIMIT ?1",
            )?;
            stmt.query_map(params![limit], row_to_episodic)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

    /// List semantic nodes for a profile, highest-confidence-first.
    pub fn list_semantic(
        &self,
        profile_id: Option<&str>,
        limit:      usize,
    ) -> Result<Vec<crate::types::SemanticNode>> {
        let limit = limit as i64;
        let mut stmt;
        let rows = if let Some(pid) = profile_id {
            stmt = self.conn.prepare(
                "SELECT id, profile_id, content, category, confidence,
                        decay_score, access_count, last_accessed_at,
                        created_at, metadata
                   FROM semantic_nodes
                  WHERE profile_id = ?1
                  ORDER BY confidence DESC, decay_score DESC
                  LIMIT ?2",
            )?;
            stmt.query_map(params![pid, limit], row_to_semantic)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            stmt = self.conn.prepare(
                "SELECT id, profile_id, content, category, confidence,
                        decay_score, access_count, last_accessed_at,
                        created_at, metadata
                   FROM semantic_nodes
                  ORDER BY confidence DESC, decay_score DESC
                  LIMIT ?1",
            )?;
            stmt.query_map(params![limit], row_to_semantic)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

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

    // ── Flight recorder ────────────────────────────────────────────────────
    //
    // `store_audit_turn` is the single write path for the flight
    // recorder. It persists the audit row + all associated token
    // mappings in one transaction so a partial write can never leave
    // the audit row claiming "0 entities" when the mappings table
    // has rows referring to a turn that doesn't exist.
    //
    // Read paths (`list_audit_turns`, `get_audit_turn`,
    // `count_token_original`) are designed to be cheap so the
    // LibreChat inspector panel + audit search can call them
    // freely without paginating.

    pub fn store_audit_turn(&self, input: &StoreAuditTurnInput<'_>) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO audit_turns (
               id, profile_id, host, endpoint, model, oauth_active,
               user_text, assistant_text, request_body, response_raw,
               recall_injected, masked_count, status, latency_ms, error,
               cache_creation_tokens, cache_read_tokens,
               input_tokens, output_tokens
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                     ?7, ?8, ?9, ?10,
                     ?11, ?12, ?13, ?14, ?15,
                     ?16, ?17, ?18, ?19)",
            params![
                id,
                input.profile_id,
                input.host,
                input.endpoint,
                input.model,
                input.oauth_active as i64,
                input.user_text,
                input.assistant_text,
                input.request_body,
                input.response_raw,
                input.recall_injected,
                input.masked_count as i64,
                input.status.map(|s| s as i64),
                input.latency_ms.map(|s| s as i64),
                input.error,
                input.cache_creation_tokens.map(|v| v as i64),
                input.cache_read_tokens.map(|v| v as i64),
                input.input_tokens.map(|v| v as i64),
                input.output_tokens.map(|v| v as i64),
            ],
        )?;

        // Token mappings — one INSERT per row. Per-turn count is
        // typically <50, so loop overhead is negligible vs. the gain
        // in clarity over a multi-VALUES batch insert.
        if !input.token_mappings.is_empty() {
            let mut stmt = tx.prepare(
                "INSERT INTO token_mappings (
                   turn_id, profile_id, token, original, entity_kind, direction
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for m in &input.token_mappings {
                stmt.execute(params![
                    id,
                    input.profile_id,
                    m.token,
                    m.original,
                    m.entity_kind,
                    m.direction.as_str(),
                ])?;
            }
        }

        tx.commit()?;
        Ok(id)
    }

    /// List audit turns newest-first. `profile_id == None` means all
    /// profiles (cross-cutting view for the inspector). Limit caps the
    /// scan; UI defaults to 50.
    pub fn list_audit_turns(
        &self,
        profile_id: Option<&str>,
        limit:      usize,
    ) -> Result<Vec<AuditTurn>> {
        let limit = limit as i64;
        let mut stmt;
        let rows = if let Some(pid) = profile_id {
            stmt = self.conn.prepare(
                "SELECT id, profile_id, created_at, host, endpoint, model,
                        oauth_active, user_text, assistant_text, request_body,
                        response_raw, recall_injected, masked_count,
                        status, latency_ms, error,
                        cache_creation_tokens, cache_read_tokens,
                        input_tokens, output_tokens
                   FROM audit_turns
                  WHERE profile_id = ?1
                  ORDER BY created_at DESC
                  LIMIT ?2",
            )?;
            stmt.query_map(params![pid, limit], row_to_audit_turn)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            stmt = self.conn.prepare(
                "SELECT id, profile_id, created_at, host, endpoint, model,
                        oauth_active, user_text, assistant_text, request_body,
                        response_raw, recall_injected, masked_count,
                        status, latency_ms, error,
                        cache_creation_tokens, cache_read_tokens,
                        input_tokens, output_tokens
                   FROM audit_turns
                  ORDER BY created_at DESC
                  LIMIT ?1",
            )?;
            stmt.query_map(params![limit], row_to_audit_turn)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

    /// Fetch a single audit turn by id, plus all its token mappings.
    /// Returns `None` if the turn doesn't exist.
    pub fn get_audit_turn(&self, id: &str) -> Result<Option<(AuditTurn, Vec<TokenMapping>)>> {
        let turn = self.conn
            .query_row(
                "SELECT id, profile_id, created_at, host, endpoint, model,
                        oauth_active, user_text, assistant_text, request_body,
                        response_raw, recall_injected, masked_count,
                        status, latency_ms, error,
                        cache_creation_tokens, cache_read_tokens,
                        input_tokens, output_tokens
                   FROM audit_turns
                  WHERE id = ?1",
                params![id],
                row_to_audit_turn,
            )
            .optional()?;
        let Some(turn) = turn else { return Ok(None); };

        let mut stmt = self.conn.prepare(
            "SELECT id, turn_id, profile_id, token, original, entity_kind,
                    direction, created_at
               FROM token_mappings
              WHERE turn_id = ?1
              ORDER BY id",
        )?;
        let mappings = stmt.query_map(params![id], row_to_token_mapping)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(Some((turn, mappings)))
    }

    /// Count of times an original entity has been masked across all
    /// turns. Powers "you've mentioned Casey 47 times" surfaces.
    /// `profile_id == None` counts across all profiles.
    pub fn count_token_original(
        &self,
        original:   &str,
        profile_id: Option<&str>,
    ) -> Result<u64> {
        let count: i64 = if let Some(pid) = profile_id {
            self.conn.query_row(
                "SELECT COUNT(*) FROM token_mappings
                  WHERE original = ?1 AND profile_id = ?2",
                params![original, pid],
                |r| r.get(0),
            )?
        } else {
            self.conn.query_row(
                "SELECT COUNT(*) FROM token_mappings WHERE original = ?1",
                params![original],
                |r| r.get(0),
            )?
        };
        Ok(count as u64)
    }

    pub fn get_stats(&self) -> Result<StorageStats> {
        let count = |sql: &str| -> Result<i64> {
            Ok(self.conn.query_row(sql, [], |r| r.get(0))?)
        };
        Ok(StorageStats {
            episodic:    count("SELECT COUNT(*) FROM episodic_memories")?,
            semantic:    count("SELECT COUNT(*) FROM semantic_nodes")?,
            identity:    count("SELECT COUNT(*) FROM identity_facts")?,
            embeddings:  count("SELECT COUNT(*) FROM embeddings")?,
            audit_turns: count("SELECT COUNT(*) FROM audit_turns")?,
            backend:     self.backend.clone(),
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

fn row_to_audit_turn(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditTurn> {
    let id:              String         = row.get(0)?;
    let profile_id:      Option<String> = row.get(1)?;
    let created_at:      String         = row.get(2)?;
    let host:            String         = row.get(3)?;
    let endpoint:        String         = row.get(4)?;
    let model:           Option<String> = row.get(5)?;
    let oauth_active:    i64            = row.get(6)?;
    let user_text:       Option<String> = row.get(7)?;
    let assistant_text:  Option<String> = row.get(8)?;
    let request_body:    Option<String> = row.get(9)?;
    let response_raw:    Option<String> = row.get(10)?;
    let recall_injected: Option<String> = row.get(11)?;
    let masked_count:    i64            = row.get(12)?;
    let status:          Option<i64>    = row.get(13)?;
    let latency_ms:      Option<i64>    = row.get(14)?;
    let error:                   Option<String> = row.get(15)?;
    let cache_creation_tokens:   Option<i64>    = row.get(16).unwrap_or(None);
    let cache_read_tokens:       Option<i64>    = row.get(17).unwrap_or(None);
    let input_tokens:            Option<i64>    = row.get(18).unwrap_or(None);
    let output_tokens:           Option<i64>    = row.get(19).unwrap_or(None);
    Ok(AuditTurn {
        id,
        profile_id,
        created_at: parse_datetime(&created_at).unwrap_or_else(Utc::now),
        host,
        endpoint,
        model,
        oauth_active: oauth_active != 0,
        user_text,
        assistant_text,
        request_body,
        response_raw,
        recall_injected,
        masked_count: masked_count as u32,
        status:       status.map(|s| s as u16),
        latency_ms:   latency_ms.map(|s| s as u64),
        error,
        cache_creation_tokens: cache_creation_tokens.map(|v| v as u64),
        cache_read_tokens:     cache_read_tokens.map(|v| v as u64),
        input_tokens:          input_tokens.map(|v| v as u64),
        output_tokens:         output_tokens.map(|v| v as u64),
    })
}

fn row_to_episodic(row: &rusqlite::Row<'_>) -> rusqlite::Result<crate::types::EpisodicMemory> {
    let id:           String         = row.get(0)?;
    let profile_id:   String         = row.get(1)?;
    let content:      String         = row.get(2)?;
    let source:       Option<String> = row.get(3)?;
    let agent_id:     Option<String> = row.get(4)?;
    let occurred_at:  String         = row.get(5)?;
    let created_at:   String         = row.get(6)?;
    let metadata_raw: String         = row.get(7)?;
    let metadata: crate::types::Metadata =
        serde_json::from_str(&metadata_raw).unwrap_or_default();
    Ok(crate::types::EpisodicMemory {
        id,
        profile_id,
        content,
        source,
        agent_id,
        occurred_at: parse_datetime(&occurred_at).unwrap_or_else(Utc::now),
        created_at:  parse_datetime(&created_at).unwrap_or_else(Utc::now),
        metadata,
    })
}

fn row_to_semantic(row: &rusqlite::Row<'_>) -> rusqlite::Result<crate::types::SemanticNode> {
    let id:               String         = row.get(0)?;
    let profile_id:       String         = row.get(1)?;
    let content:          String         = row.get(2)?;
    let category:         Option<String> = row.get(3)?;
    let confidence:       f64            = row.get(4)?;
    let decay_score:      f64            = row.get(5)?;
    let access_count:     i64            = row.get(6)?;
    let last_accessed_at: String         = row.get(7)?;
    let created_at:       String         = row.get(8)?;
    let metadata_raw:     String         = row.get(9)?;
    let metadata: crate::types::Metadata =
        serde_json::from_str(&metadata_raw).unwrap_or_default();
    Ok(crate::types::SemanticNode {
        id,
        profile_id,
        content,
        category,
        confidence,
        decay_score,
        access_count,
        last_accessed_at: parse_datetime(&last_accessed_at).unwrap_or_else(Utc::now),
        created_at:       parse_datetime(&created_at).unwrap_or_else(Utc::now),
        metadata,
    })
}

fn row_to_token_mapping(row: &rusqlite::Row<'_>) -> rusqlite::Result<TokenMapping> {
    let id:          i64            = row.get(0)?;
    let turn_id:     String         = row.get(1)?;
    let profile_id:  Option<String> = row.get(2)?;
    let token:       String         = row.get(3)?;
    let original:    String         = row.get(4)?;
    let entity_kind: String         = row.get(5)?;
    let direction:   String         = row.get(6)?;
    let created_at:  String         = row.get(7)?;
    Ok(TokenMapping {
        id,
        turn_id,
        profile_id,
        token,
        original,
        entity_kind,
        direction: match direction.as_str() {
            "outbound" => TokenDirection::Outbound,
            "inbound"  => TokenDirection::Inbound,
            // The CHECK constraint guarantees only those two values
            // can land in the column; if a future migration loosens
            // it, default to outbound rather than panic.
            _          => TokenDirection::Outbound,
        },
        created_at: parse_datetime(&created_at).unwrap_or_else(Utc::now),
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
