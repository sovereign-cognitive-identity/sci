//! Sci memory store — local SQLite + brute-force vector recall.
//!
//! The TS reference is `packages/core/src/storage/cloud-adapter.ts` plus
//! the `StorageAdapter` interface in `packages/core/src/storage/interface.ts`.
//! This crate ports the storage shape verbatim, with two intentional
//! shifts (see `schema.rs` for the full reasoning):
//!
//!   - Embeddings live inside SQLite as f32 LE BLOBs in a dedicated
//!     `embeddings` table, not in a sibling hnswlib index file. Recall
//!     does brute-force cosine in Rust. v0.5-class performance (sub-100ms
//!     up to ~5k memories on M-series); the API doesn't change when we
//!     swap to sqlite-vec or another ANN index later.
//!   - CHECK constraints on `confidence` / `decay_score` so a sibling
//!     crate bug can't quietly poison the store with out-of-range scores.
//!
//! Embedding generation (BGE-base-en-v1.5 via `ort`) is split off as
//! SCI-130. This crate accepts caller-supplied `&[f32]` slices and
//! validates the dimension at the API boundary.

#![warn(clippy::all)]

mod adapter;
mod error;
mod recall;
mod schema;
mod types;

pub use adapter::LocalAdapter;
pub use error::{MemoryError, Result};
pub use schema::EMBEDDING_DIM;
pub use types::{
    AuditTurn, EpisodicMemory, IdentityFact, Metadata, Profile, RecallQuery, RecallResult,
    RecallType, SemanticNode, StorageStats, StoreAuditTurnInput, StoreEpisodicInput,
    StoreIdentityInput, StoreSemanticInput, TokenDirection, TokenMapping, TokenMappingInput,
};

#[cfg(test)]
mod tests;
