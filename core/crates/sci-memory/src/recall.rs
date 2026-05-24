//! Recall: vec0 ANN search + informativeness weighting + keyword boost.
//!
//!   1. For each requested memory class (`episodic` / `semantic` /
//!      `identity`), issue a `vec0 MATCH` query — sqlite-vec's ANN index
//!      returns the top-k nearest vectors in sub-millisecond time regardless
//!      of corpus size.
//!   2. Compute `base = 1/(1+L2_distance)` (higher = semantically closer).
//!   3. Apply an informativeness factor based on content length: very short
//!      chunks (headings, bare questions) are demoted so substantive content
//!      ranks above them even when the short chunk is marginally closer in
//!      vector space.
//!   4. Apply a keyword boost: +0.02 if the content contains the raw query.
//!   5. Sort by adjusted score, deduplicate by id, truncate to `limit`.
//!      Return the adjusted score directly so callers see a meaningful signal.
//!
//! The distance metric from vec0 is L2. For BGE-base-en-v1.5 (which
//! emits L2-normalised vectors) L2 and cosine distance are monotonically
//! related: `cosine_dist = L2_dist² / 2`.

use crate::error::Result;
use crate::types::{Metadata, RecallQuery, RecallResult, RecallType};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;

// ── Serialisation helpers ────────────────────────────────────────────────────

/// Serialise an `&[f32]` to little-endian bytes — the format sqlite-vec
/// expects for vector literals passed as query parameters.
pub(crate) fn embedding_to_vec0_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// Deserialise a little-endian byte blob back to `Vec<f32>`.
/// Returns `None` for corrupt blobs (length not a multiple of 4).
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

fn parse_sqlite_datetime(s: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|n| n.and_utc())
}

/// Cosine similarity — kept for tests.
#[cfg(test)]
pub(crate) fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() { return 0.0; }
    let mut dot = 0.0_f32;
    let mut na  = 0.0_f32;
    let mut nb  = 0.0_f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na  += a[i] * a[i];
        nb  += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na.sqrt() * nb.sqrt()) }
}

// ── Internal types ───────────────────────────────────────────────────────────

struct DenseHit {
    id:          String,
    kind:        RecallType,
    content:     String,
    /// `1 / (1 + L2_distance)` — higher is better.
    score:       f32,
    metadata:    Metadata,
    occurred_at: Option<DateTime<Utc>>,
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Run the ANN + keyword + RRF pipeline for the given query.
pub fn recall(conn: &Connection, q: &RecallQuery<'_>) -> Result<Vec<RecallResult>> {
    let all_types = [RecallType::Episodic, RecallType::Semantic, RecallType::Identity];
    let types: &[RecallType] = if q.types.is_empty() { &all_types } else { q.types };

    let lower_query = q.query.to_lowercase();
    // Over-fetch so we have enough candidates after the profile_id post-filter
    // drops some vec0 rows and the informativess reranking shuffles the order.
    let k = (q.limit * 6).max(50) as i64;

    let query_bytes = embedding_to_vec0_bytes(q.query_embedding);
    let mut all_hits: Vec<DenseHit> = Vec::new();

    for ty in types {
        let hits = dense_hits(conn, &query_bytes, *ty, q.profile_id, k, &lower_query)?;
        all_hits.extend(hits);
    }

    // Sort by adjusted score descending, deduplicate by id (keep highest),
    // then truncate to limit.  Return the raw adjusted score so callers get
    // a meaningful relevance signal rather than a narrow RRF rank band.
    all_hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    let mut seen: HashMap<String, ()> = HashMap::new();
    let mut out: Vec<RecallResult> = Vec::with_capacity(q.limit);
    for hit in all_hits {
        if seen.insert(hit.id.clone(), ()).is_none() {
            out.push(RecallResult {
                id:          hit.id,
                kind:        hit.kind,
                content:     hit.content,
                score:       hit.score as f64,
                metadata:    hit.metadata,
                occurred_at: hit.occurred_at,
            });
            if out.len() >= q.limit {
                break;
            }
        }
    }
    Ok(out)
}

// ── vec0 ANN query ───────────────────────────────────────────────────────────

fn dense_hits(
    conn:        &Connection,
    query_bytes: &[u8],
    kind:        RecallType,
    profile_id:  &str,
    k:           i64,
    lower_query: &str,
) -> Result<Vec<DenseHit>> {
    // Two-step approach to avoid SQLite pushing the JOIN condition
    // `memory_id = <value>` onto the vec0 auxiliary column inside the
    // KNN query (which vec0 v0.1.9 rejects).
    //
    // Step 1: get (memory_id, distance) from vec0 — NO JOIN in this query.
    //   partition key (`profile_id`) IS allowed alongside MATCH.
    // Step 2: look up content/metadata for each memory_id individually.
    let knn: Vec<(String, f64)> = match kind {
        RecallType::Episodic => {
            let sql = "SELECT memory_id, distance FROM embeddings_episodic
                        WHERE embedding MATCH ?1 AND profile_id = ?2 AND k = ?3
                        ORDER BY distance";
            let mut stmt = conn.prepare(sql)?;
            stmt.query_map(params![query_bytes, profile_id, k], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?.collect::<std::result::Result<_, _>>()?
        }
        RecallType::Semantic => {
            let sql = "SELECT memory_id, distance FROM embeddings_semantic
                        WHERE embedding MATCH ?1 AND profile_id = ?2 AND k = ?3
                        ORDER BY distance";
            let mut stmt = conn.prepare(sql)?;
            stmt.query_map(params![query_bytes, profile_id, k], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?.collect::<std::result::Result<_, _>>()?
        }
        RecallType::Identity => {
            let sql = "SELECT memory_id, distance FROM embeddings_identity
                        WHERE embedding MATCH ?1 AND k = ?2
                        ORDER BY distance";
            let mut stmt = conn.prepare(sql)?;
            stmt.query_map(params![query_bytes, k], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?.collect::<std::result::Result<_, _>>()?
        }
    };

    // Step 2: look up content/metadata for each returned memory_id.
    let mut rows: Vec<(String, f64, String, String, Option<String>)> =
        Vec::with_capacity(knn.len());
    for (memory_id, distance) in knn {
        let row_opt: Option<(String, String, Option<String>)> = match kind {
            RecallType::Episodic => {
                conn.query_row(
                    "SELECT content, metadata, occurred_at FROM episodic_memories WHERE id = ?1",
                    params![memory_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                ).optional()?
            }
            RecallType::Semantic => {
                conn.query_row(
                    "SELECT content, metadata, NULL FROM semantic_nodes WHERE id = ?1",
                    params![memory_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?)),
                ).optional()?
            }
            RecallType::Identity => {
                conn.query_row(
                    "SELECT content, metadata, NULL FROM identity_facts WHERE id = ?1",
                    params![memory_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?)),
                ).optional()?
            }
        };
        if let Some((content, metadata, occurred_at)) = row_opt {
            rows.push((memory_id, distance, content, metadata, occurred_at));
        }
    }

    let mut hits = Vec::with_capacity(rows.len());
    for (id, distance, content, metadata_raw, occurred_at_raw) in rows {
        // Base semantic similarity: 1/(1+L2) ∈ (0, 1], higher = closer.
        let base = 1.0_f32 / (1.0 + distance as f32);

        // Informativeness factor: demote very short chunks (headings, one-line
        // labels, bare user questions) that embed close to queries but carry
        // little information.  Ramps from 0.3 at 0 chars to 1.0 at 150 chars,
        // capped at 1.0.  A 30-char heading gets ×0.42; a 150-char paragraph
        // gets ×1.0.
        let len_factor = (content.len() as f32 / 150.0).clamp(0.0, 1.0);
        let info_factor = 0.3 + 0.7 * len_factor;

        // Keyword boost: tiny bonus when the full query appears verbatim.
        let keyword_boost = if !lower_query.is_empty()
            && content.to_lowercase().contains(&*lower_query)
        {
            0.02_f32
        } else {
            0.0
        };

        let score = base * info_factor + keyword_boost;
        let metadata: Metadata = serde_json::from_str(&metadata_raw).unwrap_or_default();
        let occurred_at = occurred_at_raw.and_then(|s| parse_sqlite_datetime(&s));
        hits.push(DenseHit { id, kind, content, score, metadata, occurred_at });
    }
    Ok(hits)
}
