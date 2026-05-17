//! Smoke test: load the embedder, embed a known string, assert dim and
//! L2-norm. Marked `#[ignore]` because it needs the model cached on disk
//! (or network access for the first-run download). Run with:
//!
//!   cargo test -p sci-embeddings smoke -- --ignored --nocapture
//!
//! On CI without network, run with the model pre-staged at
//! `$SCI_MODEL_CACHE_DIR/bge-base-en-v1.5/`.

use sci_handlers::Embedder;

#[tokio::test]
#[ignore = "requires model files on disk or network for first-run download"]
async fn embed_known_string_returns_unit_vector() {
    let embedder = sci_embeddings::BgeEmbedder::load()
        .await
        .expect("load BgeEmbedder");

    let v = embedder
        .embed("hello world")
        .await
        .expect("embed");

    assert_eq!(v.len(), 768, "BGE-base output must be 768-dim");

    // L2 norm should be ~1.0 — we explicitly L2-normalize after pooling.
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!(
        (norm - 1.0).abs() < 1e-4,
        "expected L2-normalized output, got |v|={norm}"
    );
}
