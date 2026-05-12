//! Sci anonymization core — Rust port of `packages/core/src/anonymizer.ts`.
//!
//! The TypeScript implementation has four passes:
//!
//! 1. **Regex** — emails, phones, URLs, bare domains, social handles.
//!    Highest precision, byte-deterministic, no language model needed.
//! 2. **NLP NER (compromise.js)** — PERSON / PLACE / ORG. Lightweight
//!    JS lexicon + grammar tagger.
//! 3. **Custom entities** loaded from `identity_facts` (DB-backed,
//!    cached 5 min). Project names, known orgs, etc.
//! 4. **CamelCase heuristic** — catches compound proper nouns the
//!    other passes miss (`OpenClaw`, `BlueBubbles`).
//!
//! This crate ports passes (1) and (4) verbatim plus the token-map
//! plumbing that wraps them. Passes (2) and (3) are tracked separately:
//!
//!   - **NLP NER**: SCI-123. Rust has no compromise.js equivalent.
//!     Options on the table are (a) a hand-crafted lexicon + grammar
//!     translation of compromise's tagger, (b) a small ONNX NER model
//!     loaded via `ort` (~50 MB on disk), or (c) the lexicon for v0.5
//!     and the model for v1.0. Without NER the Rust pipeline misses
//!     bare PERSON detections like "Casey Zandbergen" — a real
//!     regression vs the TS smoke tests we ran. Critical to close
//!     before any platform shell ships against this crate.
//!
//!   - **Custom entities**: SCI-124. Belongs in `sci-memory` once the
//!     storage adapter lands (SCI-125) — the cache fetches via that
//!     adapter, not directly. Plumbed through the public API today as
//!     an optional argument that takes a slice of `Entity`.
//!
//! What you *can* trust this crate to do today:
//!
//!   - Mask URLs, emails, phone numbers, bare domains, social handles
//!   - Mask compound CamelCase proper nouns (filtered through the
//!     allowlist)
//!   - Build deterministic forward/reverse token maps
//!   - Apply / reverse those token maps with case-insensitive
//!     replacement and word-boundary safety
//!
//! Parity with the TS reference is enforced by fixture tests under
//! `tests/parity/` — same input string, same allowlist, same output.

#![warn(clippy::all)]

mod allowlist;
mod code_regions;
mod custom_entities;
mod ner;
mod regex_extract;
mod token_map;

pub use allowlist::{TECH_ALLOWLIST, is_allowlisted};
pub use code_regions::{extract_code_regions, is_in_code_region};
pub use custom_entities::{Fact, extract_entities_from_facts};
pub use ner::extract_nlp_entities;
pub use regex_extract::{extract_camelcase_entities, extract_regex_entities};
pub use token_map::{
    AnonymizeResult, Entity, EntityType, TokenMap, anonymize, anonymize_with_custom,
    apply_token_map, build_token_map, deanonymize,
};
