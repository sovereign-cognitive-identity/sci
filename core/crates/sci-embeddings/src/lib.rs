//! Sci embeddings — BGE-base-en-v1.5 via `ort` + `tokenizers`.
//!
//! Implements `sci_handlers::Embedder` against the same model the TS
//! reference (`packages/core/src/embeddings.ts`) uses through
//! `@huggingface/transformers`. Output is a 768-dim vector, mean-pooled
//! over the token sequence with the attention mask, then L2-normalized.
//! Cosine parity vs the TS path is asserted >= 0.999.
//!
//! ## Why this crate exists
//!
//! `sci-memory` (SCI-125) shipped expecting caller-provided embeddings as
//! `&[f32]` of length 768. The handler layer (SCI-126) wired in a
//! `NoopEmbedder` that returns zeros so the recall + store flow could be
//! exercised end-to-end without the model dependency. Real recall needs a
//! real embedder; this is it.
//!
//! ## Cross-platform
//!
//! `ort` v2 wraps Microsoft's ONNX Runtime — first-class on macOS / iOS /
//! Android / Windows / Linux. Execution providers are gated by Cargo
//! features (see `Cargo.toml`):
//!
//! - `coreml` — Apple Silicon CoreML EP, recommended on macOS / iOS
//! - `cuda` — NVIDIA, opt-in for desktop builds with a discrete GPU
//! - `directml` — Windows + DirectX, opt-in
//! - default — CPU EP, works everywhere
//!
//! ## Threading
//!
//! ONNX inference is CPU-bound and heavy enough that we do **not** run it
//! inline on a tokio worker — that would stall every other task on the
//! same worker for the duration of the forward pass. Every `embed()` call
//! offloads to `tokio::task::spawn_blocking`. The `ort::Session` is
//! protected by a sync `Mutex` (its `run` takes `&mut self`); the lock is
//! held only for the duration of the forward pass and never across
//! `.await`.
//!
//! ## Model file management
//!
//! The model is **not** bundled in the binary. ONNX float32 export of
//! BGE-base-en-v1.5 is ~440 MB; bundling would inflate every release
//! tarball Sci ships across every platform. Instead, on first call the
//! crate downloads:
//!
//! 1. `model.onnx`     — the ONNX graph (≈110 MB optimized FP16, ≈440 MB FP32)
//! 2. `tokenizer.json` — HuggingFace WordPiece tokenizer
//!
//! to `~/.sci/models/bge-base-en-v1.5/`. Each download is verified against
//! a pinned SHA256 (see `download::PINNED_HASHES`). Override the cache
//! root with `SCI_MODEL_CACHE_DIR`.

#![warn(clippy::all)]

mod download;
mod embedder;
mod error;
mod tokenizer;

pub use embedder::{BgeEmbedder, EMBEDDING_DIM};
pub use error::{EmbeddingError, Result};
pub use download::{cache_dir, ModelFiles};
