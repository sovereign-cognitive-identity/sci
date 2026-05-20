//! Error type for sci-embeddings.

use std::path::PathBuf;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, EmbeddingError>;

#[derive(Debug, Error)]
pub enum EmbeddingError {
    #[error("io error at {path}: {source}")]
    Io {
        path:   PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("network error fetching {url}: {source}")]
    Network {
        url:    String,
        #[source]
        source: reqwest::Error,
    },

    #[error("downloaded {path} sha256 mismatch — expected {expected}, got {actual}")]
    HashMismatch {
        path:     PathBuf,
        expected: String,
        actual:   String,
    },

    #[error("ONNX runtime error: {0}")]
    Ort(#[from] ort::Error),

    #[error("tokenizer error: {0}")]
    Tokenizer(String),

    #[error("model output shape unexpected: {0}")]
    Shape(String),

    #[error("could not resolve home directory for model cache")]
    NoHome,
}

impl EmbeddingError {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io { path: path.into(), source }
    }
}
