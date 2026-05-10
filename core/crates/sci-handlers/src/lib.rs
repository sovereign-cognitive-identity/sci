//! Provider-aware request/response handlers for AI traffic.
//!
//! When the platform shell (SCI-127) terminates TLS for an AI host and
//! parses the request, it hands the parsed `HandlerRequest` to this
//! crate. We:
//!
//!   1. Pick the right handler from `(hostname, path, method)` —
//!      `pick_handler` mirrors `proxy-server.ts`'s function of the same
//!      name. Returns `None` for non-AI paths so the shell can fall
//!      back to passthrough.
//!   2. Run the handler. For Anthropic that means: anonymize the
//!      messages via `sci-anonymizer`, recall + inject relevant
//!      memories via `sci-memory`, forward to api.anthropic.com,
//!      stream the SSE response back through a deanonymizer that
//!      swaps tokens back as deltas arrive, and finally store the
//!      interaction (post-stream) for next-call recall.
//!   3. Hand back a `HandlerResponse` whose body is a stream of
//!      bytes — the shell pipes that into the client socket.
//!
//! What ships in SCI-126:
//!
//!   - Types: `HandlerRequest`, `HandlerResponse`, `HandlerState`,
//!     `Embedder` (trait), `UpstreamClient` (trait — lets tests mock
//!     the real `reqwest` calls).
//!   - `pick_handler` dispatch.
//!   - Anthropic `/v1/messages` handler with anonymization, streaming
//!     SSE deanonymization, BYO API key forwarding (the OAuth path is
//!     SCI-128 territory; we accept x-api-key and bearer transparently).
//!
//! Stubbed for follow-up tickets:
//!
//!   - **OpenAI** (`/v1/chat/completions`) — SCI-132. Same shape as
//!     Anthropic; the `Authorization: Bearer` header swap is the
//!     credential-injection difference. Stubbed at
//!     `handle_openai_chat`.
//!   - **Google** (`:generateContent` / `:streamGenerateContent`) —
//!     SCI-133. Different request body shape and streaming format.
//!     Stubbed at `handle_google_gemini`.
//!   - **Memory storage post-response** — depends on SCI-130 (real
//!     embeddings). Today the pipeline calls into `sci-memory` only
//!     for *recall*; storage on success is pluggable but no-ops
//!     until embeddings are real.

#![warn(clippy::all)]

mod anthropic;
mod deanonymize_stream;
mod dispatch;
mod google;
mod openai;
mod state;
mod types;
/// Public so integration tests + platform shells can construct
/// `UpstreamRequest`/`UpstreamResponse` directly when wiring a custom
/// transport (e.g. test mocks, NetworkExtension-fed bytes).
pub mod upstream;

pub use anthropic::handle_anthropic_messages;
pub use deanonymize_stream::DeanonymizingStream;
pub use dispatch::{Handler, is_intercepted_host, pick_handler};
pub use google::handle_google_gemini;
pub use openai::handle_openai_chat;
pub use state::{Embedder, HandlerState, NoopEmbedder};
pub use types::{BodyStream, HandlerError, HandlerRequest, HandlerResponse, Result};
pub use upstream::{ReqwestClient, UpstreamClient};
