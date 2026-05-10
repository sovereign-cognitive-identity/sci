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
    pub episodic:     i64,
    pub semantic:     i64,
    pub identity:     i64,
    pub embeddings:   i64,
    /// SCI-152: flight-recorder turn count. Surfaced by the helper's
    /// `/sci/status` admin endpoint so the sci-chat UI can show "Sci
    /// has captured N turns" without a separate query round-trip.
    #[serde(rename = "auditTurns")]
    pub audit_turns:  i64,
    pub backend:      String,
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

// ── Flight recorder ────────────────────────────────────────────────────────

/// Direction of a token mapping. `Outbound` = entity in the user's
/// prompt that Sci masked before sending upstream (common). `Inbound`
/// = a token in the model's response that Sci deanonymized when
/// echoing back to the client (less common, but recorded so the
/// audit trail captures the full round-trip).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenDirection {
    Outbound,
    Inbound,
}

impl TokenDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenDirection::Outbound => "outbound",
            TokenDirection::Inbound  => "inbound",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TokenMappingInput<'a> {
    pub token:       &'a str,
    pub original:    &'a str,
    pub entity_kind: &'a str,
    pub direction:   TokenDirection,
}

/// Input for `LocalAdapter::store_audit_turn`. Most fields are
/// optional because the writer (sci-handlers) may not have all
/// artifacts in every error path — e.g. an upstream connection
/// failure has a `status` and `error` but no `assistant_text`.
#[derive(Debug, Clone, Default)]
pub struct StoreAuditTurnInput<'a> {
    pub profile_id:      Option<&'a str>,
    pub host:            &'a str,
    pub endpoint:        &'a str,
    pub model:           Option<&'a str>,
    pub oauth_active:    bool,
    pub user_text:       Option<&'a str>,
    pub assistant_text:  Option<&'a str>,
    pub request_body:    Option<&'a str>,
    pub response_raw:    Option<&'a str>,
    pub recall_injected: Option<&'a str>,
    pub masked_count:    u32,
    pub status:          Option<u16>,
    pub latency_ms:      Option<u64>,
    pub error:           Option<&'a str>,
    pub token_mappings:  Vec<TokenMappingInput<'a>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditTurn {
    pub id:              String,
    #[serde(rename = "profileId")]
    pub profile_id:      Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at:      DateTime<Utc>,
    pub host:            String,
    pub endpoint:        String,
    pub model:           Option<String>,
    #[serde(rename = "oauthActive")]
    pub oauth_active:    bool,
    #[serde(rename = "userText")]
    pub user_text:       Option<String>,
    #[serde(rename = "assistantText")]
    pub assistant_text:  Option<String>,
    #[serde(rename = "requestBody")]
    pub request_body:    Option<String>,
    #[serde(rename = "responseRaw")]
    pub response_raw:    Option<String>,
    #[serde(rename = "recallInjected")]
    pub recall_injected: Option<String>,
    #[serde(rename = "maskedCount")]
    pub masked_count:    u32,
    pub status:          Option<u16>,
    #[serde(rename = "latencyMs")]
    pub latency_ms:      Option<u64>,
    pub error:           Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenMapping {
    pub id:          i64,
    #[serde(rename = "turnId")]
    pub turn_id:     String,
    #[serde(rename = "profileId")]
    pub profile_id:  Option<String>,
    pub token:       String,
    pub original:    String,
    #[serde(rename = "entityKind")]
    pub entity_kind: String,
    pub direction:   TokenDirection,
    #[serde(rename = "createdAt")]
    pub created_at:  DateTime<Utc>,
}
