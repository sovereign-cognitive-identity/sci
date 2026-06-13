//! WASM bindings for sci-anonymizer. Exposes the public API via wasm-bindgen.
//!
//! Published as npm package: `@sovereign-cognitive-identity/anonymizer`
//!
//! This crate is a thin re-export wrapper over `sci-anonymizer`, bridging
//! the Rust types to WASM/JavaScript using `wasm-bindgen` and `serde-wasm-bindgen`
//! for complex types like TokenMap.
//!
//! ## Design notes
//!
//! - `serde_wasm_bindgen` is used to serialize/deserialize `TokenMap` to/from JS
//!   because the forward/reverse HashMap structure doesn't map cleanly to WASM
//!   without a serialization layer.
//!
//! - `Fact<'a>` from sci-anonymizer requires an owned-string wrapper for the WASM
//!   boundary (`FactOwned`), since borrowed references cannot cross the JS boundary.
//!
//! - NLP NER path (bare PERSON detection) is not exposed — this inherits the SCI-123
//!   gap documented in sci-anonymizer. The WASM bindings expose only the portable
//!   surface (regex + CamelCase + custom entities + custom allowlist).
//!
//! - Binary size optimizations (LTO, strip, panic=abort) target 300-500 KB for
//!   the final .wasm module when published to npm.

use sci_anonymizer::{
    anonymize as rs_anonymize, anonymize_with_custom as rs_anonymize_with_custom,
    deanonymize as rs_deanonymize, apply_token_map as rs_apply_token_map,
    build_token_map as rs_build_token_map, Entity, EntityType, TokenMap, AnonymizeResult,
    SessionError, SESSION_FORMAT_VERSION, TECH_ALLOWLIST,
};
use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};

// ── EntityType ──────────────────────────────────────────────────────────────
//
// Re-export as-is; the enum serializes identically on both sides of the boundary.

#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum WasmEntityType {
    #[serde(rename = "PERSON")]
    Person = 0,
    #[serde(rename = "PLACE")]
    Place = 1,
    #[serde(rename = "ORG")]
    Org = 2,
    #[serde(rename = "PROJECT")]
    Project = 3,
    #[serde(rename = "EMAIL")]
    Email = 4,
    #[serde(rename = "PHONE")]
    Phone = 5,
    #[serde(rename = "URL")]
    Url = 6,
    #[serde(rename = "HANDLE")]
    Handle = 7,
    #[serde(rename = "SECRET")]
    Secret = 8,
    #[serde(rename = "IP_ADDRESS")]
    IpAddress = 9,
}

impl WasmEntityType {
    /// Return the token prefix used for this entity type (e.g., "PERSON", "EMAIL").
    pub fn token_prefix(self) -> String {
        self.to_rust().token_prefix().to_string()
    }
}

/// Return the token prefix for an entity type (e.g., "PERSON", "EMAIL").
#[wasm_bindgen]
pub fn entity_type_token_prefix(entity_type: WasmEntityType) -> String {
    entity_type.token_prefix()
}

impl WasmEntityType {
    fn to_rust(&self) -> EntityType {
        match self {
            WasmEntityType::Person => EntityType::Person,
            WasmEntityType::Place => EntityType::Place,
            WasmEntityType::Org => EntityType::Org,
            WasmEntityType::Project => EntityType::Project,
            WasmEntityType::Email => EntityType::Email,
            WasmEntityType::Phone => EntityType::Phone,
            WasmEntityType::Url => EntityType::Url,
            WasmEntityType::Handle => EntityType::Handle,
            WasmEntityType::Secret => EntityType::Secret,
            WasmEntityType::IpAddress => EntityType::IpAddress,
        }
    }

    fn from_rust(rt: EntityType) -> Self {
        match rt {
            EntityType::Person => WasmEntityType::Person,
            EntityType::Place => WasmEntityType::Place,
            EntityType::Org => WasmEntityType::Org,
            EntityType::Project => WasmEntityType::Project,
            EntityType::Email => WasmEntityType::Email,
            EntityType::Phone => WasmEntityType::Phone,
            EntityType::Url => WasmEntityType::Url,
            EntityType::Handle => WasmEntityType::Handle,
            EntityType::Secret => WasmEntityType::Secret,
            EntityType::IpAddress => WasmEntityType::IpAddress,
        }
    }
}

// ── Entity ──────────────────────────────────────────────────────────────────
//
// This is the serializable Rust version used internally. For WASM we'll
// serialize/deserialize via serde_wasm_bindgen without the #[wasm_bindgen] derive.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WasmEntity {
    pub text: String,
    #[serde(rename = "entity_type")]
    pub entity_type: WasmEntityType,
}

impl WasmEntity {
    fn to_rust(&self) -> Entity {
        Entity {
            text: self.text.clone(),
            entity_type: self.entity_type.to_rust(),
        }
    }

    fn from_rust(e: Entity) -> Self {
        WasmEntity {
            text: e.text,
            entity_type: WasmEntityType::from_rust(e.entity_type),
        }
    }
}

// ── TokenMap ────────────────────────────────────────────────────────────────
//
// TokenMap contains HashMaps and doesn't serialize cleanly to JS without
// `serde_wasm_bindgen`. We expose it as an opaque handle and provide
// serialization methods.

#[wasm_bindgen]
pub struct WasmTokenMap {
    inner: TokenMap,
}

#[wasm_bindgen]
impl WasmTokenMap {
    /// Create an empty token map.
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmTokenMap {
        WasmTokenMap {
            inner: TokenMap::new(),
        }
    }

    /// Serialize into the versioned session envelope (JSON string).
    /// Returns an error string on failure.
    pub fn to_session_json(&self) -> Result<String, String> {
        self.inner
            .to_session_json()
            .map_err(|e| format!("Session serialization failed: {}", e))
    }

    /// Parse a versioned session envelope and restore a TokenMap.
    /// Returns an error string if the JSON is malformed or the version is unsupported.
    pub fn from_session_json(json: &str) -> Result<WasmTokenMap, String> {
        TokenMap::from_session_json(json)
            .map(|inner| WasmTokenMap { inner })
            .map_err(|e| match e {
                SessionError::Json(je) => format!("JSON parse error: {}", je),
                SessionError::UnsupportedVersion { found, supported } => {
                    format!(
                        "Unsupported session format version {} (this build supports {})",
                        found, supported
                    )
                }
            })
    }
}

// Internal conversion helpers.
impl WasmTokenMap {
    fn from_rust(inner: TokenMap) -> Self {
        WasmTokenMap { inner }
    }

    fn to_rust(&self) -> TokenMap {
        self.inner.clone()
    }
}

// ── AnonymizeResult ─────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct WasmAnonymizeResult {
    text: String,
    token_map: WasmTokenMap,
    detected: Vec<WasmEntity>,
    entity_count: usize,
}

#[wasm_bindgen]
impl WasmAnonymizeResult {
    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String {
        self.text.clone()
    }

    pub fn get_token_map(&self) -> WasmTokenMap {
        WasmTokenMap {
            inner: self.token_map.inner.clone(),
        }
    }

    pub fn get_detected(&self) -> Vec<JsValue> {
        self.detected
            .iter()
            .map(|e| serde_wasm_bindgen::to_value(e).unwrap_or(JsValue::NULL))
            .collect()
    }

    #[wasm_bindgen(getter)]
    pub fn entity_count(&self) -> usize {
        self.entity_count
    }
}

impl WasmAnonymizeResult {
    fn from_rust(result: AnonymizeResult) -> Self {
        WasmAnonymizeResult {
            text: result.text,
            token_map: WasmTokenMap {
                inner: result.token_map,
            },
            detected: result
                .detected
                .into_iter()
                .map(WasmEntity::from_rust)
                .collect(),
            entity_count: result.entity_count,
        }
    }
}

// ── Public API functions ────────────────────────────────────────────────────

/// Detect entities in `text` and replace them with stable placeholder tokens.
/// Pass `existing` to extend a prior session's TokenMap; None starts a fresh session.
#[wasm_bindgen]
pub fn anonymize(text: &str, existing: Option<WasmTokenMap>) -> WasmAnonymizeResult {
    let existing_map = existing.map(|m| m.to_rust());
    let result = rs_anonymize(text, existing_map);
    WasmAnonymizeResult::from_rust(result)
}

/// Same as `anonymize`, plus caller-supplied custom entities that should be masked.
///
/// # Arguments
///
/// - `text`: The input text to anonymize.
/// - `existing`: Optional prior TokenMap to extend.
/// - `custom_entities`: Array of custom entities to mask (in addition to built-in detectors).
#[wasm_bindgen]
pub fn anonymize_with_custom(
    text: &str,
    existing: Option<WasmTokenMap>,
    custom_entities: Vec<JsValue>,
) -> Result<WasmAnonymizeResult, String> {
    let existing_map = existing.map(|m| m.to_rust());

    let mut custom = Vec::new();
    for js_entity in custom_entities {
        let entity: WasmEntity = serde_wasm_bindgen::from_value(js_entity)
            .map_err(|e| format!("Failed to deserialize custom entity: {}", e))?;
        custom.push(entity.to_rust());
    }

    let result = rs_anonymize_with_custom(text, existing_map, &custom);
    Ok(WasmAnonymizeResult::from_rust(result))
}

/// Reverse substitution: replace placeholder tokens in `text` with the real
/// entities from the token map. Inverse of `anonymize`.
#[wasm_bindgen]
pub fn deanonymize(text: &str, token_map: &WasmTokenMap) -> String {
    rs_deanonymize(text, &token_map.inner)
}

/// Build (or extend) a TokenMap from detected entities with deterministic
/// per-type numbering. Lower-level building block used by `anonymize`.
#[wasm_bindgen]
pub fn build_token_map(
    entities: Vec<JsValue>,
    existing: Option<WasmTokenMap>,
) -> Result<WasmTokenMap, String> {
    let existing_map = existing.map(|m| m.to_rust());

    let mut rust_entities = Vec::new();
    for js_entity in entities {
        let entity: WasmEntity = serde_wasm_bindgen::from_value(js_entity)
            .map_err(|e| format!("Failed to deserialize entity: {}", e))?;
        rust_entities.push(entity.to_rust());
    }

    let token_map = rs_build_token_map(&rust_entities, existing_map);
    Ok(WasmTokenMap::from_rust(token_map))
}

/// Apply a TokenMap's forward substitutions to `text` (entity → token).
#[wasm_bindgen]
pub fn apply_token_map(text: &str, token_map: &WasmTokenMap) -> String {
    rs_apply_token_map(text, &token_map.inner)
}

// ── Session format version ──────────────────────────────────────────────────

/// The versioned session format version supported by this build.
/// Bump only on breaking changes to the persisted envelope shape.
#[wasm_bindgen]
pub fn get_session_format_version() -> u32 {
    SESSION_FORMAT_VERSION
}

/// Get the tech allowlist as an array of allowlisted terms.
/// These are case-sensitive proper nouns (frameworks, languages, SaaS names)
/// that should not be masked during anonymization.
///
/// Returns a Vec<String> that JavaScript can use for case-insensitive matching.
#[wasm_bindgen]
pub fn get_tech_allowlist() -> Vec<JsValue> {
    TECH_ALLOWLIST
        .iter()
        .map(|s| JsValue::from_str(s))
        .collect()
}

// ── Serialization helpers for TokenMap ─────────────────────────────────────
//
// TokenMap is a HashMap-based structure that needs custom serialization
// to cross the WASM boundary cleanly. These helpers allow JS code to
// serialize/deserialize TokenMap objects.

/// Serialize a TokenMap to a JavaScript object (plain object with forward/reverse maps).
#[wasm_bindgen]
pub fn serialize_token_map(token_map: &WasmTokenMap) -> Result<JsValue, String> {
    serde_wasm_bindgen::to_value(&token_map.inner)
        .map_err(|e| format!("Failed to serialize TokenMap: {}", e))
}

/// Deserialize a TokenMap from a JavaScript object.
#[wasm_bindgen]
pub fn deserialize_token_map(value: JsValue) -> Result<WasmTokenMap, String> {
    let inner: TokenMap = serde_wasm_bindgen::from_value(value)
        .map_err(|e| format!("Failed to deserialize TokenMap: {}", e))?;
    Ok(WasmTokenMap::from_rust(inner))
}
