//! Sci's portable core — umbrella crate.
//!
//! Platform shells (macOS NE, Android VpnService, Windows WFP host,
//! the dev CLI) take a single dependency on `sci-core`. Everything
//! else is transitive. Keeping the public surface narrow here is
//! what makes the eventual security-audit pass tractable.

pub use sci_anonymizer  as anonymizer;
pub use sci_embeddings  as embeddings;
pub use sci_handlers    as handlers;
pub use sci_memory      as memory;
pub use sci_tls         as tls;

/// Concrete real embedder for the BGE-base-en-v1.5 model. Re-exported
/// here so a platform shell can take a single dep on `sci-core` and
/// instantiate it without naming `sci-embeddings`. The handler layer's
/// `Embedder` trait stays the abstraction; this is the production impl.
pub use sci_embeddings::BgeEmbedder;

/// Crate version, surfaced through FFI for diagnostic UIs.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
