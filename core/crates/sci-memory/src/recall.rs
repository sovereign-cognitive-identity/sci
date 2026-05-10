//! Recall: dense vector search + keyword boost + RRF merge.
//!
//! Mirrors the `recall()` method on the TS `CloudAdapter`. The structure
//! is:
//!
//!   1. For each requested memory class (`episodic` / `semantic` /
//!      `identity`), pull all embeddings for that class out of the
//!      `embeddings` table together with the joined memory row.
//!   2. Compute cosine similarity between `query_embedding` and each
//!      stored embedding.
//!   3. Take the top `limit * 3` per type (the over-fetch lets RRF
//!      reorder later).
//!   4. Apply a keyword boost: +0.02 to the score if the row's `content`
//!      contains the lowercased query as a substring. Matches the TS
//!      behavior verbatim — full FTS isn't worth the dependency for
//!      Sci's "remember the time we discussed X" recall pattern.
//!   5. RRF merge across types: each result's RRF score is
//!      `1 / (rank + 1 + 60)`. The +60 is the standard
//!      reciprocal-rank-fusion constant. Same value as TS.
//!   6. Truncate to the caller's `limit`.
//!
//! The brute-force cosine over all rows is the v0.5 implementation —
//! see `schema.rs` for why. Latency: <100ms up to ~5k memories on M-series.
//! When sqlite-vec stabilizes we swap step 1 for a `MATCH` query and the
//! rest is unchanged.

use crate::error::Result;
use crate::types::{Metadata, RecallQuery, RecallResult, RecallType};
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use std::collections::HashMap;

/// Convert an `&[f32]` to a little-endian byte buffer for SQLite BLOB
/// storage. f32 LE is the same shape sqlite-vec uses, so swapping to
/// vec0 won't require a data migration.
pub(crate) fn embedding_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// Inverse of `embedding_to_bytes`. Returns `None` if `bytes.len()` isn't
/// a multiple of 4 — that would indicate corruption.
pub(crate) fn bytes_to_embedding(bytes: &[u8]) -> Option<Vec<f32>> {
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Some(out)
}

/// SQLite's `datetime('now')` returns `'YYYY-MM-DD HH:MM:SS'` with no T
/// separator and no timezone. Real ISO-8601 is also possible if a caller
/// inserted from elsewhere. Try both shapes; return `None` for anything
/// else rather than poisoning a recall result with a synthesized stamp.
fn parse_sqlite_datetime(s: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|n| n.and_utc())
}

/// Cosine similarity. Returns 0.0 if either vector is zero-norm — would
/// otherwise be NaN, which sorts unpredictably.
pub(crate) fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot   = 0.0_f32;
    let mut na    = 0.0_f32;
    let mut nb    = 0.0_f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na  += a[i] * a[i];
        nb  += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

/// Single hit from the dense-search step. Owns its content + metadata
/// because the row is fetched once and then merged across types in
/// pure Rust.
struct DenseHit {
    id:          String,
    kind:        RecallType,
    content:     String,
    score:       f32,
    metadata:    Metadata,
    occurred_at: Option<DateTime<Utc>>,
}

/// Run the dense + keyword + RRF pipeline. The caller has already filtered
/// to the desired memory classes; an empty `types` slice means "all three"
/// (matches the TS default).
pub fn recall(conn: &Connection, q: &RecallQuery<'_>) -> Result<Vec<RecallResult>> {
    // Empty types → search all three (matches TS default).
    let all_types = [RecallType::Episodic, RecallType::Semantic, RecallType::Identity];
    let types: &[RecallType] = if q.types.is_empty() { &all_types } else { q.types };

    let lower_query = q.query.to_lowercase();
    let fetch_n     = q.limit.saturating_mul(3);
    let mut all_hits: Vec<DenseHit> = Vec::new();

    for ty in types {
        let dense = dense_hits(conn, q.query_embedding, *ty, q.profile_id, fetch_n, &lower_query)?;
        all_hits.extend(dense);
    }

    // RRF merge: rank-based deduplication. Each id keeps its best RRF
    // score across appearances. Sorting by raw cosine first gives every
    // hit a deterministic rank for the RRF constant.
    all_hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    let mut best: HashMap<String, RecallResult> = HashMap::new();
    for (i, hit) in all_hits.iter().enumerate() {
        let rrf = 1.0_f64 / (i as f64 + 1.0 + 60.0);
        match best.get_mut(&hit.id) {
            Some(prev) if prev.score >= rrf => continue,
            _ => {
                best.insert(
                    hit.id.clone(),
                    RecallResult {
                        id:          hit.id.clone(),
                        kind:        hit.kind,
                        content:     hit.content.clone(),
                        score:       rrf,
                        metadata:    hit.metadata.clone(),
                        occurred_at: hit.occurred_at,
                    },
                );
            }
        }
    }

    let mut out: Vec<RecallResult> = best.into_values().collect();
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(q.limit);
    Ok(out)
}

fn dense_hits(
    conn:        &Connection,
    query_emb:   &[f32],
    kind:        RecallType,
    profile_id:  &str,
    fetch_n:     usize,
    lower_query: &str,
) -> Result<Vec<DenseHit>> {
    // Single query joins embeddings + the relevant memory table. The
    // join shape varies by class because `identity_facts` has no
    // profile_id — it's globally scoped.
    let (sql, profile_arg): (&str, Option<&str>) = match kind {
        RecallType::Episodic => (
            "SELECT e.memory_id, m.content, m.metadata, m.occurred_at, e.embedding
               FROM embeddings AS e
               JOIN episodic_memories AS m ON m.id = e.memory_id
              WHERE e.memory_type = 'episodic'
                AND m.profile_id  = ?1",
            Some(profile_id),
        ),
        RecallType::Semantic => (
            "SELECT e.memory_id, m.content, m.metadata, NULL AS occurred_at, e.embedding
               FROM embeddings AS e
               JOIN semantic_nodes AS m ON m.id = e.memory_id
              WHERE e.memory_type = 'semantic'
                AND m.profile_id  = ?1",
            Some(profile_id),
        ),
        RecallType::Identity => (
            "SELECT e.memory_id, m.content, m.metadata, NULL AS occurred_at, e.embedding
               FROM embeddings AS e
               JOIN identity_facts AS m ON m.id = e.memory_id
              WHERE e.memory_type = 'identity'",
            None,
        ),
    };

    let mut stmt = conn.prepare(sql)?;
    let rows = match profile_arg {
        Some(pid) => stmt.query_map([pid], |row| {
            let id:           String         = row.get(0)?;
            let content:      String         = row.get(1)?;
            let metadata_raw: String         = row.get(2)?;
            let occurred_at:  Option<String> = row.get(3)?;
            let embedding:    Vec<u8>        = row.get(4)?;
            Ok((id, content, metadata_raw, occurred_at, embedding))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?,
        None => stmt.query_map([], |row| {
            let id:           String         = row.get(0)?;
            let content:      String         = row.get(1)?;
            let metadata_raw: String         = row.get(2)?;
            let occurred_at:  Option<String> = row.get(3)?;
            let embedding:    Vec<u8>        = row.get(4)?;
            Ok((id, content, metadata_raw, occurred_at, embedding))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?,
    };

    let mut hits: Vec<DenseHit> = Vec::with_capacity(rows.len());
    for (id, content, metadata_raw, occurred_at, embedding_bytes) in rows {
        let Some(stored) = bytes_to_embedding(&embedding_bytes) else {
            // Corrupt blob — skip, don't poison the recall.
            continue;
        };
        let mut score = cosine(query_emb, &stored);
        if content.to_lowercase().contains(lower_query) && !lower_query.is_empty() {
            score += 0.02;
        }
        let metadata: Metadata = serde_json::from_str(&metadata_raw).unwrap_or_default();
        // Same RFC3339-or-naive fallback as `adapter::parse_datetime`.
        // Inlined here rather than crossing the module boundary because
        // `recall.rs` doesn't otherwise touch `adapter`.
        let occurred_at = occurred_at.and_then(|s| parse_sqlite_datetime(&s));
        hits.push(DenseHit {
            id,
            kind,
            content,
            score,
            metadata,
            occurred_at,
        });
    }

    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(fetch_n);
    Ok(hits)
}
