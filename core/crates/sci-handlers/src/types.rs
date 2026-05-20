//! Shared types for the handler crate. Wire-stack-agnostic on purpose
//! — these types describe an HTTP request/response shape but don't
//! carry any I/O machinery. The platform shell (SCI-127) is responsible
//! for parsing the bytes off the TLS-decrypted socket into a
//! `HandlerRequest` and writing a `HandlerResponse` back.

use bytes::Bytes;
use futures::Stream;
use std::collections::HashMap;
use std::pin::Pin;
use thiserror::Error;

/// Boxed `Stream<Item = Result<Bytes>>` — what handlers return for SSE
/// or chunked bodies. `Send + 'static` so the shell can poll the
/// stream from any task.
pub type BodyStream =
    Pin<Box<dyn Stream<Item = std::result::Result<Bytes, std::io::Error>> + Send + 'static>>;

#[derive(Debug, Clone)]
pub struct HandlerRequest {
    pub method:   String,
    /// Full URL path including query string (e.g. `/v1/messages?beta=1`).
    pub url:      String,
    /// Lowercase keys (HTTP headers are case-insensitive; we normalize at
    /// parse time so handlers can look up by lower-case literal).
    pub headers:  HashMap<String, String>,
    pub body:     Bytes,
    /// Hostname this request was destined for (from SNI or Host header).
    /// Anthropic-specific routing keys off this so cross-host quirks
    /// (e.g. openrouter.ai vs api.anthropic.com) stay in one place.
    pub hostname: String,
}

impl HandlerRequest {
    /// Return the value of the named header, lowercase-matched. The
    /// constructor normalizes header names to lowercase, so callers
    /// can pass `"x-api-key"` regardless of how the wire formatted it.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_lowercase()).map(String::as_str)
    }

    /// Path without query string. Convenience for dispatch matching.
    pub fn path(&self) -> &str {
        self.url.split_once('?').map_or(self.url.as_str(), |(p, _)| p)
    }
}

/// What handlers return. The body is always streaming — Anthropic SSE
/// is the common case, and even non-streaming JSON responses go through
/// the same channel for uniformity (the shell never has to branch on
/// "is this stream or not").
pub struct HandlerResponse {
    pub status:  u16,
    pub headers: HashMap<String, String>,
    pub body:    BodyStream,

    /// SCI-138 inspector view: post-anonymization request body Sci
    /// forwarded to the provider. Always populated by handlers that
    /// anonymize. The platform shell reads this after dispatch and
    /// emits a `flow_anonymized_request` event so observers (sci-tail,
    /// the macOS Settings → Status pane) can show exactly what left
    /// the machine.
    ///
    /// Safe to log: every PII entity has been replaced with a
    /// `[CLASS_N]` token by construction.
    pub inspect_request: Option<Bytes>,

    /// SCI-138 inspector view: raw upstream response body, BEFORE
    /// deanonymization. Populated by handlers that fully buffer the
    /// upstream response (the non-streaming JSON path); left `None`
    /// for SSE-streaming responses where buffering would defeat
    /// streaming. SSE-chunk-level traces are a future enhancement.
    ///
    /// Same safety story as `inspect_request`: the bytes echo masked
    /// tokens, never user PII.
    pub inspect_upstream_raw: Option<Bytes>,
}

impl HandlerResponse {
    /// Convenience constructor for handlers that don't populate the
    /// inspector fields (the OpenAI / Google handlers today, which
    /// proxy SSE through without buffering). Anthropic builds its own
    /// response with the inspector fields populated where applicable.
    pub fn streaming(status: u16, headers: HashMap<String, String>, body: BodyStream) -> Self {
        Self {
            status,
            headers,
            body,
            inspect_request:      None,
            inspect_upstream_raw: None,
        }
    }
}

impl std::fmt::Debug for HandlerResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HandlerResponse")
            .field("status", &self.status)
            .field("headers", &self.headers)
            .field("body", &"<stream>")
            .finish()
    }
}

#[derive(Debug, Error)]
pub enum HandlerError {
    #[error("upstream: {0}")]
    Upstream(String),

    #[error("malformed request: {0}")]
    Malformed(String),

    #[error("missing credential: no {header} or upstream auth path configured")]
    MissingCredential { header: &'static str },

    #[error("provider returned {status}: {body}")]
    UpstreamStatus { status: u16, body: String },

    #[error("anonymizer: {0}")]
    Anonymizer(String),

    #[error("memory: {0}")]
    Memory(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("not yet implemented: {0}")]
    NotImplemented(&'static str),
}

pub type Result<T> = std::result::Result<T, HandlerError>;

impl From<sci_memory::MemoryError> for HandlerError {
    fn from(e: sci_memory::MemoryError) -> Self {
        HandlerError::Memory(format!("{e}"))
    }
}
