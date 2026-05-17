//! TS↔Rust parity test for BGE-base-en-v1.5 embeddings.
//!
//! Loads `core/tests/fixtures/embeddings.json` (captured by
//! `capture-embeddings-from-ts.mjs`) and asserts cosine similarity ≥
//! 0.999 between Rust and TS vectors of the same input.
//!
//! Marked `#[ignore]` because:
//!
//! 1. The model file (~440 MB) isn't bundled in the repo.
//! 2. The fixtures file is generated separately and isn't committed
//!    until the first dev run captures it.
//! 3. CI without network can't run this; opt in with
//!    `cargo test -p sci-embeddings -- --ignored --nocapture`.
//!
//! ## How to run locally
//!
//! ```bash
//! # 1. Capture TS reference vectors (requires the TS workspace built)
//! cd /Users/<you>/src/cognitive-os/sci
//! npm run build --workspaces --if-present
//! node core/tests/fixtures/capture-embeddings-from-ts.mjs > core/tests/fixtures/embeddings.json
//!
//! # 2. Run the Rust parity test
//! cd core
//! cargo test -p sci-embeddings parity --release -- --ignored --nocapture
//! ```
//!
//! The first Rust run will download the model into
//! `~/.sci/models/bge-base-en-v1.5/` (or `$SCI_MODEL_CACHE_DIR`).
//! Subsequent runs hit the cache.

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
struct Fixture {
    text:   String,
    vector: Vec<f32>,
}

fn fixtures_path() -> PathBuf {
    // crate root → workspace root → tests/fixtures/embeddings.json
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    crate_root
        .parent() // crates/
        .and_then(|p| p.parent()) // core/
        .map(|p| p.join("tests").join("fixtures").join("embeddings.json"))
        .expect("could not derive workspace root from CARGO_MANIFEST_DIR")
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    let mut dot = 0.0_f32;
    let mut na  = 0.0_f32;
    let mut nb  = 0.0_f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na  += x * x;
        nb  += y * y;
    }
    dot / (na.sqrt() * nb.sqrt()).max(1e-12)
}

#[tokio::test]
#[ignore = "requires model + captured fixtures; run with --ignored once both are present"]
async fn rust_matches_ts_within_cosine_999() {
    let path = fixtures_path();
    let raw  = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "missing fixtures at {} — run `node {}` first ({})",
            path.display(),
            "core/tests/fixtures/capture-embeddings-from-ts.mjs",
            e
        )
    });
    let fixtures: Vec<Fixture> = serde_json::from_str(&raw).expect("fixtures JSON parse");

    let embedder = sci_embeddings::BgeEmbedder::load()
        .await
        .expect("load BgeEmbedder (downloads on first run)");

    use sci_handlers::Embedder;
    for (i, fix) in fixtures.iter().enumerate() {
        let rust_vec = embedder
            .embed(&fix.text)
            .await
            .unwrap_or_else(|e| panic!("rust embed failed on fixture {i}: {e}"));
        assert_eq!(rust_vec.len(), 768, "rust vector dim != 768 on fixture {i}");
        assert_eq!(fix.vector.len(), 768, "ts vector dim != 768 on fixture {i}");
        let cos = cosine(&rust_vec, &fix.vector);
        assert!(
            cos >= 0.999,
            "fixture {i} ({:?}): cosine {} < 0.999",
            fix.text, cos
        );
        eprintln!("fixture {i:>2}  cos={cos:.6}  text={:?}", fix.text);
    }
}
