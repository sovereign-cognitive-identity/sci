//! Error type for the storage layer.
//!
//! Sci-memory wraps three transitive failure modes — SQLite errors,
//! sqlite-vec extension load/use errors, and JSON (de)serialization for
//! metadata columns — into a single `MemoryError` enum so the calling
//! layer (handlers, FFI shim) doesn't have to know which dependency
//! failed. Each variant preserves the source error via `#[from]` so
//! `eprintln!("{e:?}")` keeps the full chain.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum MemoryError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// `sqlite-vec` failed to load or returned an unexpected result.
    /// Most often: the extension wasn't built into the binary, or the
    /// loader couldn't register the function via `auto_extension`.
    #[error("sqlite-vec: {0}")]
    Vec(String),

    /// Stored metadata blobs are JSON; if SQLite gave us back something
    /// that doesn't parse, that's the row's fault, not the schema.
    #[error("metadata JSON: {0}")]
    Json(#[from] serde_json::Error),

    /// Caller asked for a profile / memory / fact that doesn't exist.
    /// We return this as an `Err` rather than `Ok(None)` for the
    /// operations whose contract is "must exist" (e.g. `reinforce_semantic`
    /// on an unknown id is almost always a bug); for genuine
    /// "may exist" lookups the API uses `Option`.
    #[error("not found: {0}")]
    NotFound(String),

    /// Embedding shape didn't match the configured dimension. We reject
    /// these at the API boundary because sqlite-vec will accept them and
    /// silently produce nonsense recall.
    #[error("embedding dim mismatch: expected {expected}, got {got}")]
    EmbeddingDim { expected: usize, got: usize },
}

pub type Result<T> = std::result::Result<T, MemoryError>;
