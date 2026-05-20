//! Sci CA + per-host leaf cert + rustls server-side termination.
//!
//! Mirrors the TS implementation in `packages/agent/src/cert.ts`. The
//! on-disk format (`ca.crt` + `ca.key`, both PEM) matches byte-for-byte
//! what the TS agent writes — a user moving from the TS agent to a
//! Rust-core-based shell doesn't have to re-trust a fresh CA.
//!
//! What's here:
//!
//!   - `ensure_ca(dir)` — load the CA from disk if `dir/ca.crt` +
//!     `dir/ca.key` exist, generate a fresh self-signed RSA-2048 CA
//!     valid 10 years if not. Same parameters as the TS agent.
//!   - `Ca` value owns the loaded keypair + cert.
//!   - `make_server_config(&Ca)` — builds a `rustls::ServerConfig`
//!     wired with a `CertResolver` that lazily signs per-host leaf
//!     certs via rcgen on first request for each SNI hostname, and
//!     caches them by name for the lifetime of the resolver.
//!
//! The actual TLS handshake / network I/O is the platform shell's job
//! (SCI-127); this crate ends at "give the shell a `ServerConfig` it
//! can hand to `tokio_rustls::TlsAcceptor`." Keeps the audit surface
//! narrow + lets the shell choose its own async runtime story.

#![warn(clippy::all)]

mod ca;
mod resolver;

pub use ca::{Ca, ensure_ca};
pub use resolver::{CertResolver, make_server_config};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum TlsError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// rcgen surface — cert generation, signing, PEM encoding.
    #[error("rcgen: {0}")]
    Rcgen(#[from] rcgen::Error),

    /// rustls surface — config build / sign error wrapping. Wrapped as
    /// String because the rustls error types aren't all `'static`.
    #[error("rustls: {0}")]
    Rustls(String),

    #[error("PEM parse: {0}")]
    Pem(String),
}

pub type Result<T> = std::result::Result<T, TlsError>;
