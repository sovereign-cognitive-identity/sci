//! `BgeEmbedder` — the actual embedding pipeline.
//!
//! Pipeline:
//!   1. tokenize text → input_ids + attention_mask + token_type_ids
//!   2. ONNX forward pass → last_hidden_state of shape [1, seq_len, 768]
//!   3. mean-pool over seq_len axis using attention_mask as weights
//!   4. L2-normalize the resulting 768-vector
//!
//! Steps 3–4 must match `@huggingface/transformers`'s `pooling: 'mean',
//! normalize: true` behavior exactly. Cosine parity vs the TS reference
//! is the test bar (>= 0.999).
//!
//! ## Concurrency
//!
//! `Session::run` takes `&mut self`, so we wrap the session in a sync
//! `Mutex` and offload the whole tokenize+forward+pool+normalize chain
//! into `tokio::task::spawn_blocking`. The lock is acquired only inside
//! the blocking task; nothing async happens while it's held. That lets a
//! `BgeEmbedder` be `Send + Sync` and shareable behind `Arc` across the
//! handler hot path without ever stalling a tokio worker on inference.
//!
//! Single-session is the right starting shape — concurrent embed calls
//! serialize, but BGE-base on Apple Silicon CoreML is ~30 ms per call,
//! and the request rate the agent sees on a single user's machine is
//! orders of magnitude below that. If we ever need real parallelism
//! (cross-user / batch consolidation) we can pool sessions or batch
//! inputs; the public API doesn't change.

use crate::download::{default_model_dir, ensure_model_files, ModelFiles};
use crate::error::{EmbeddingError, Result};
use crate::tokenizer::BgeTokenizer;
use async_trait::async_trait;
use ndarray::{Array2, Axis};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 768-dim, the BGE-base-en-v1.5 contract. Asserted against
/// `sci_memory::EMBEDDING_DIM` at construction time.
pub const EMBEDDING_DIM: usize = 768;

const _: () = assert!(EMBEDDING_DIM == sci_memory::EMBEDDING_DIM);

pub struct BgeEmbedder {
    /// `Mutex<Session>` because `Session::run` requires `&mut self`. The
    /// lock is short-held inside `spawn_blocking`; never across `.await`.
    session:    Arc<Mutex<Session>>,
    tokenizer:  Arc<BgeTokenizer>,
    /// Kept for diagnostics / `sci doctor` reporting.
    #[allow(dead_code)]
    model_dir:  PathBuf,
}

impl BgeEmbedder {
    /// Load (downloading on first run) from `~/.sci/models/bge-base-en-v1.5/`
    /// (or `$SCI_MODEL_CACHE_DIR/bge-base-en-v1.5/`).
    pub async fn load() -> Result<Self> {
        let dir = default_model_dir()?;
        Self::load_from_dir(&dir).await
    }

    /// Load from an explicit directory. Files (`model.onnx`,
    /// `tokenizer.json`) are downloaded into `dir` if missing.
    pub async fn load_from_dir(dir: &Path) -> Result<Self> {
        let files: ModelFiles = ensure_model_files(dir).await?;
        Self::load_from_files(&files).await
    }

    /// Load from already-resolved file paths. Used by tests with a
    /// custom-located fixture model. Doesn't touch the network.
    pub async fn load_from_files(files: &ModelFiles) -> Result<Self> {
        let model_path     = files.model_onnx.clone();
        let tokenizer_path = files.tokenizer.clone();
        let model_dir      = files.model_dir.clone();

        // Session construction is itself blocking (memory-mapping the
        // ~440 MB model file). Offload it.
        let (session, tokenizer) = tokio::task::spawn_blocking(move || -> Result<_> {
            let session = build_session(&model_path)?;
            let tokenizer = BgeTokenizer::from_file(&tokenizer_path)?;
            Ok((session, tokenizer))
        })
        .await
        .map_err(|e| EmbeddingError::Tokenizer(format!("session spawn_blocking failed: {e}")))??;

        Ok(Self {
            session:   Arc::new(Mutex::new(session)),
            tokenizer: Arc::new(tokenizer),
            model_dir,
        })
    }
}

#[async_trait]
impl sci_handlers::Embedder for BgeEmbedder {
    async fn embed(&self, text: &str) -> sci_handlers::Result<Vec<f32>> {
        // Convert to `sci_handlers::Result` at the boundary so the trait
        // signature stays the project-wide one.
        embed_inner(self, text)
            .await
            .map_err(|e| sci_handlers::HandlerError::Memory(format!("embedding error: {e}")))
    }
}

async fn embed_inner(this: &BgeEmbedder, text: &str) -> Result<Vec<f32>> {
    let session   = Arc::clone(&this.session);
    let tokenizer = Arc::clone(&this.tokenizer);
    let owned_text = text.to_string();

    tokio::task::spawn_blocking(move || -> Result<Vec<f32>> {
        let encoded = tokenizer.encode(&owned_text)?;
        let seq_len = encoded.seq_len;

        // Convert mask to f32 weights up-front so we don't need to keep
        // the i64 mask alive after handing it to the tensor.
        let mask_f32: Vec<f32> = encoded.attention_mask.iter().map(|&v| v as f32).collect();

        // ndarray inputs of shape [1, seq_len].
        let input_ids = Array2::from_shape_vec((1, seq_len), encoded.input_ids)
            .map_err(|e| EmbeddingError::Shape(format!("input_ids reshape: {e}")))?;
        let attention_mask = Array2::from_shape_vec((1, seq_len), encoded.attention_mask)
            .map_err(|e| EmbeddingError::Shape(format!("attention_mask reshape: {e}")))?;
        let token_type_ids = Array2::from_shape_vec((1, seq_len), encoded.token_type_ids)
            .map_err(|e| EmbeddingError::Shape(format!("token_type_ids reshape: {e}")))?;

        // The BGE ONNX export uses the standard BERT input names. We feed
        // by name (the `inputs! { "k" => v }` map form) so we don't depend
        // on the order ort surfaces them in.
        let input_ids_t  = Tensor::from_array(input_ids)?;
        let attention_t  = Tensor::from_array(attention_mask)?;
        let token_type_t = Tensor::from_array(token_type_ids)?;

        // Run inference and immediately copy the last_hidden_state
        // tensor out into an owned ndarray. We can then drop both the
        // session lock and the SessionOutputs before the (cheap)
        // post-processing happens — keeping the lock window tight.
        let owned_hidden: ndarray::ArrayD<f32> = {
            let mut sess = session.lock().expect("embedder session mutex poisoned");
            let outputs = sess.run(ort::inputs! {
                "input_ids"      => input_ids_t,
                "attention_mask" => attention_t,
                "token_type_ids" => token_type_t,
            })?;

            // BGE returns last_hidden_state of shape [1, seq_len, hidden].
            // Most exports name it explicitly; some name it `output_0` or
            // similar. Try the named lookup first; fall back to the first
            // output in iteration order. Each branch extracts into an
            // owned array so the borrow on `outputs` is released before
            // we leave this block.
            let owned: ndarray::ArrayD<f32> = if let Some(named) = outputs.get("last_hidden_state") {
                let view = named.try_extract_array::<f32>()?;
                let shape = view.shape().to_vec();
                check_shape(&shape, seq_len)?;
                view.to_owned()
            } else {
                let mut iter = outputs.iter();
                let (_, first) = iter
                    .next()
                    .ok_or_else(|| EmbeddingError::Shape("model produced no outputs".into()))?;
                let view = first.try_extract_array::<f32>()?;
                let shape = view.shape().to_vec();
                check_shape(&shape, seq_len)?;
                view.to_owned()
            };
            owned
        };

        Ok(mean_pool_and_normalize(&owned_hidden.view(), &mask_f32, seq_len))
    })
    .await
    .map_err(|e| EmbeddingError::Tokenizer(format!("embed spawn_blocking failed: {e}")))?
}

/// Mean-pool token embeddings using the attention mask as weights, then
/// L2-normalize the result. Mirrors `@huggingface/transformers`'s
/// behavior with `{ pooling: 'mean', normalize: true }`:
///
///   pooled[d] = sum_i (mask[i] * hidden[i, d]) / max(sum(mask), 1e-9)
///   output    = pooled / ||pooled||_2
///
/// Bit-equality across runtimes isn't realistic; cosine similarity vs
/// the TS reference is asserted >= 0.999 in the parity test.
fn mean_pool_and_normalize(
    last_hidden: &ndarray::ArrayViewD<'_, f32>,
    mask: &[f32],
    seq_len: usize,
) -> Vec<f32> {
    debug_assert_eq!(mask.len(), seq_len);

    // last_hidden is shape [1, seq_len, EMBEDDING_DIM]; collapse the
    // leading batch axis so we can iterate as [seq_len, EMBEDDING_DIM].
    let lh = last_hidden.index_axis(Axis(0), 0);

    let mut sum = vec![0.0f32; EMBEDDING_DIM];
    let mut mask_sum = 0.0f32;

    for (i, &m) in mask.iter().enumerate().take(seq_len) {
        mask_sum += m;
        if m == 0.0 {
            continue;
        }
        let row = lh.index_axis(Axis(0), i);
        for (s, &h) in sum.iter_mut().zip(row.iter()) {
            *s += m * h;
        }
    }

    let denom = mask_sum.max(1e-9);
    for s in &mut sum {
        *s /= denom;
    }

    // L2 normalize.
    let norm: f32 = sum.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    for s in &mut sum {
        *s /= norm;
    }
    sum
}

fn check_shape(shape: &[usize], seq_len: usize) -> Result<()> {
    if shape.len() != 3 || shape[0] != 1 || shape[1] != seq_len || shape[2] != EMBEDDING_DIM {
        return Err(EmbeddingError::Shape(format!(
            "expected output shape [1, {seq_len}, {EMBEDDING_DIM}], got {shape:?}"
        )));
    }
    Ok(())
}

fn build_session(model_path: &Path) -> Result<Session> {
    #[allow(unused_mut)]
    let mut builder = Session::builder()?
        .with_optimization_level(GraphOptimizationLevel::Level3)?;

    // Execution provider configuration. Each EP is feature-flagged so a
    // build doesn't pull in CoreML on Linux or CUDA on macOS. The
    // `register_for_session` calls below are best-effort: ort silently
    // falls back to the next provider (and ultimately CPU) if the EP
    // isn't available at runtime.
    #[cfg(feature = "coreml")]
    {
        use ort::execution_providers::CoreMLExecutionProvider;
        builder = builder.with_execution_providers([
            CoreMLExecutionProvider::default().build()
        ])?;
    }
    #[cfg(feature = "cuda")]
    {
        use ort::execution_providers::CUDAExecutionProvider;
        builder = builder.with_execution_providers([
            CUDAExecutionProvider::default().build()
        ])?;
    }
    #[cfg(feature = "directml")]
    {
        use ort::execution_providers::DirectMLExecutionProvider;
        builder = builder.with_execution_providers([
            DirectMLExecutionProvider::default().build()
        ])?;
    }

    let session = builder.commit_from_file(model_path)?;
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mean_pool_and_normalize_handles_uniform_mask() {
        // 2-token sequence, 4-dim hidden, mask=[1,1].
        let arr = ndarray::array![[
            [1.0_f32, 0.0, 0.0, 0.0],
            [0.0,     1.0, 0.0, 0.0],
        ]];
        // Pretend EMBEDDING_DIM is 4 for this unit-only check by using
        // the function's logic against the actual constant — we only
        // exercise the math via an EMBEDDING_DIM-sized array below.
        let _ = arr; // unused; just a sanity placeholder

        // Build a [1, 2, 768] array where dim 0 is one-hot for token 0,
        // dim 1 is one-hot for token 1.
        let mut hidden = ndarray::Array3::<f32>::zeros((1, 2, EMBEDDING_DIM));
        hidden[[0, 0, 0]] = 1.0;
        hidden[[0, 1, 1]] = 1.0;
        let dyn_view = hidden.view().into_dyn();
        let mask = [1.0_f32, 1.0];
        let out = mean_pool_and_normalize(&dyn_view, &mask, 2);

        // Pre-norm: [0.5, 0.5, 0, ..., 0]; norm = sqrt(0.5).
        // Post-norm: [1/sqrt(2), 1/sqrt(2), 0, ..., 0].
        let inv_sqrt2 = 1.0 / 2.0_f32.sqrt();
        assert!((out[0] - inv_sqrt2).abs() < 1e-6);
        assert!((out[1] - inv_sqrt2).abs() < 1e-6);
        for v in &out[2..] {
            assert_eq!(*v, 0.0);
        }
        let l2: f32 = out.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((l2 - 1.0).abs() < 1e-5);
    }

    #[test]
    fn mean_pool_respects_attention_mask() {
        // 2 tokens, mask=[1, 0]. Token 1's hidden should be ignored.
        let mut hidden = ndarray::Array3::<f32>::zeros((1, 2, EMBEDDING_DIM));
        hidden[[0, 0, 0]] = 1.0;
        hidden[[0, 1, 5]] = 99.0; // would dominate if mask were [1,1]
        let dyn_view = hidden.view().into_dyn();
        let mask = [1.0_f32, 0.0];
        let out = mean_pool_and_normalize(&dyn_view, &mask, 2);
        // Only dim 0 should be non-zero (and == 1.0 after L2 norm).
        assert!((out[0] - 1.0).abs() < 1e-5);
        for v in &out[1..] {
            assert!(v.abs() < 1e-6);
        }
    }
}
