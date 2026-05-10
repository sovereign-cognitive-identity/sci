//! Storage types — port of `packages/core/src/storage/interface.ts`.
//!
//! Field names are snake_case here to match Rust convention; serialized
//! representations in fixtures and FFI use the same camelCase the TS
//! interface used so the wire format round-trips. `chrono::DateTime<Utc>`
//! replaces `Date` from TS; `HashMap<String, serde_json::Value>` replaces
//! `Record<string, unknown>` for free-form metadata.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Metadata columns are JSON blobs in SQLite. We preserve the dynamic
/// shape via serde_json so callers (consolidation cron, decay pass) can
/// stash whatever they need without schema migrations.
pub type Metadata = HashMap<String, serde_json::Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id:         String,
    pub name:       String,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpisodicMemory {
    pub id:          String,
    #[serde(rename = "profileId")]
    pub profile_id:  String,
    pub content:     String,
    pub source:      Option<String>,
    #[serde(rename = "agentId")]
    pub agent_id:    Option<String>,
    #[serde(rename = "occurredAt")]
    pub occurred_at: DateTime<Utc>,
    #[serde(rename = "createdAt")]
    pub created_at:  DateTime<Utc>,
    pub metadata:    Metadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticNode {
    pub id:               String,
    #[serde(rename = "profileId")]
    pub profile_id:       String,
    pub content:          String,
    pub category:         Option<String>,
    pub confidence:       f64,
    #[serde(rename = "decayScore")]
    pub decay_score:      f64,
    #[serde(rename = "accessCount")]
    pub access_count:     i64,
    #[serde(rename = "lastAccessedAt")]
    pub last_accessed_at: DateTime<Utc>,
    #[serde(rename = "createdAt")]
    pub created_at:       DateTime<Utc>,
    pub metadata:         Metadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityFact {
    pub id:         String,
    pub content:    String,
    pub category:   Option<String>,
    pub confidence: f64,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    pub metadata:   Metadata,
}

/// Memory class within a recall result. Mirrors the TS `'episodic' |
/// 'semantic' | 'identity'` union. Lowercase serde to match the TS
/// JSON shape used in fixtures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecallType {
    Episodic,
    Semantic,
    Identity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecallResult {
    pub id:          String,
    #[serde(rename = "type")]
    pub kind:        RecallType,
    pub content:     String,
    pub score:       f64,
    pub metadata:    Metadata,
    #[serde(rename = "occurredAt")]
    pub occurred_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageStats {
    pub episodic:   i64,
    pub semantic:   i64,
    pub identity:   i64,
    pub embeddings: i64,
    pub backend:    String,
}

// ── Inputs for store_* ─────────────────────────────────────────────────────
//
// Separate input structs (vs. building incomplete `EpisodicMemory` etc.)
// so the caller never has to invent values for fields the database fills
// in (id / created_at / occurred_at). Mirrors the TS interface's anonymous
// `{ profileId, content, embedding, ... }` shape.

#[derive(Debug, Clone)]
pub struct StoreEpisodicInput<'a> {
    pub profile_id: &'a str,
    pub content:    &'a str,
    pub embedding:  &'a [f32],
    pub source:     Option<&'a str>,
    pub agent_id:   Option<&'a str>,
    pub metadata:   Metadata,
}

#[derive(Debug, Clone)]
pub struct StoreSemanticInput<'a> {
    pub profile_id: &'a str,
    pub content:    &'a str,
    pub embedding:  &'a [f32],
    pub category:   Option<&'a str>,
    /// `None` → defaults to 1.0 to match the TS adapter.
    pub confidence: Option<f64>,
    pub metadata:   Metadata,
}

#[derive(Debug, Clone)]
pub struct StoreIdentityInput<'a> {
    pub content:    &'a str,
    pub embedding:  &'a [f32],
    pub category:   Option<&'a str>,
    pub confidence: Option<f64>,
    pub metadata:   Metadata,
}

/// Recall query. Mirrors TS `recall({ queryEmbedding, query, profileId,
/// limit, types })`. The `query` string is used for keyword boost on top
/// of the dense vector hits — same logic as the TS adapter, where a
/// substring match against the result content adds 0.02 to the score.
#[derive(Debug, Clone)]
pub struct RecallQuery<'a> {
    pub query_embedding: &'a [f32],
    pub query:           &'a str,
    pub profile_id:      &'a str,
    pub limit:           usize,
    /// Which memory classes to search. Empty slice → all three.
    pub types:           &'a [RecallType],
}
