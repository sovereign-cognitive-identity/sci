//! PyO3 bindings for sci-anonymizer.
//!
//! Exposes the five core functions and four types from the Rust crate
//! as a Python module via PyO3 + maturin (abi3 wheels for Python 3.10+).
//!
//! Note: The NLP/NER entity detection path (SCI-123) and custom entity loading
//! from identity_facts (SCI-124) are outside this binding layer. This crate
//! wraps only the portable regex + CamelCase extraction and token map plumbing.
//! Callers who need NLP NER or identity facts should use the Rust core directly
//! or patch this binding layer with a fresh public API in the parent crate.

use pyo3::prelude::*;
use ::sci_anonymizer as rust_anon;

// ============================================================================
// Python-facing type wrappers
// ============================================================================

/// Python wrapper for EntityType enum.
#[pyclass(eq, eq_int, frozen, hash)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PyEntityType {
    Person,
    Place,
    Org,
    Project,
    Email,
    Phone,
    Url,
    Handle,
    Secret,
    IpAddress,
}

impl PyEntityType {
    /// Convert from Rust EntityType to Python wrapper.
    fn from_rust(et: rust_anon::EntityType) -> Self {
        match et {
            rust_anon::EntityType::Person => PyEntityType::Person,
            rust_anon::EntityType::Place => PyEntityType::Place,
            rust_anon::EntityType::Org => PyEntityType::Org,
            rust_anon::EntityType::Project => PyEntityType::Project,
            rust_anon::EntityType::Email => PyEntityType::Email,
            rust_anon::EntityType::Phone => PyEntityType::Phone,
            rust_anon::EntityType::Url => PyEntityType::Url,
            rust_anon::EntityType::Handle => PyEntityType::Handle,
            rust_anon::EntityType::Secret => PyEntityType::Secret,
            rust_anon::EntityType::IpAddress => PyEntityType::IpAddress,
        }
    }

    /// Convert from Python wrapper to Rust EntityType.
    fn to_rust(self) -> rust_anon::EntityType {
        match self {
            PyEntityType::Person => rust_anon::EntityType::Person,
            PyEntityType::Place => rust_anon::EntityType::Place,
            PyEntityType::Org => rust_anon::EntityType::Org,
            PyEntityType::Project => rust_anon::EntityType::Project,
            PyEntityType::Email => rust_anon::EntityType::Email,
            PyEntityType::Phone => rust_anon::EntityType::Phone,
            PyEntityType::Url => rust_anon::EntityType::Url,
            PyEntityType::Handle => rust_anon::EntityType::Handle,
            PyEntityType::Secret => rust_anon::EntityType::Secret,
            PyEntityType::IpAddress => rust_anon::EntityType::IpAddress,
        }
    }
}

#[pymethods]
impl PyEntityType {
    /// Get the token prefix for this entity type (e.g., "PERSON", "EMAIL").
    #[staticmethod]
    pub fn token_prefix(py_et: PyEntityType) -> &'static str {
        py_et.to_rust().token_prefix()
    }

    pub fn __repr__(&self) -> String {
        format!("EntityType.{:?}", self)
    }
}

/// Python wrapper for Entity (detected span).
#[pyclass]
#[derive(Clone, Debug)]
pub struct PyEntity {
    #[pyo3(get)]
    pub text: String,
    #[pyo3(get)]
    pub entity_type: PyEntityType,
}

impl PyEntity {
    /// Convert from Rust Entity to Python wrapper.
    fn from_rust(e: rust_anon::Entity) -> Self {
        PyEntity {
            text: e.text,
            entity_type: PyEntityType::from_rust(e.entity_type),
        }
    }

    /// Convert from Python wrapper to Rust Entity.
    fn to_rust(self) -> rust_anon::Entity {
        rust_anon::Entity {
            text: self.text,
            entity_type: self.entity_type.to_rust(),
        }
    }
}

#[pymethods]
impl PyEntity {
    #[new]
    pub fn new(text: String, entity_type: PyEntityType) -> Self {
        PyEntity {
            text,
            entity_type,
        }
    }

    pub fn __repr__(&self) -> String {
        format!("Entity(text={:?}, type={:?})", self.text, self.entity_type)
    }
}

/// Python wrapper for TokenMap (bidirectional entity ↔ token mapping).
#[pyclass]
#[derive(Clone)]
pub struct PyTokenMap {
    inner: rust_anon::TokenMap,
}

impl PyTokenMap {
    /// Wrap a Rust TokenMap.
    fn from_rust(tm: rust_anon::TokenMap) -> Self {
        PyTokenMap { inner: tm }
    }

    /// Extract the Rust TokenMap (consuming self).
    fn to_rust(self) -> rust_anon::TokenMap {
        self.inner
    }
}

#[pymethods]
impl PyTokenMap {
    /// Create a new empty TokenMap.
    #[new]
    pub fn new() -> Self {
        PyTokenMap {
            inner: rust_anon::TokenMap::new(),
        }
    }

    /// Serialize this map into a versioned JSON string.
    pub fn to_session_json(&self) -> PyResult<String> {
        self.inner
            .to_session_json()
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))
    }

    /// Parse a versioned JSON string back into a TokenMap.
    /// Raises ValueError if the JSON is malformed or the version is unsupported.
    #[staticmethod]
    pub fn from_session_json(json_str: &str) -> PyResult<PyTokenMap> {
        rust_anon::TokenMap::from_session_json(json_str)
            .map(PyTokenMap::from_rust)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))
    }

    /// Get the number of entities in this map (forward + reverse).
    pub fn __len__(&self) -> usize {
        self.inner.forward.len()
    }

    pub fn __repr__(&self) -> String {
        format!("TokenMap(len={})", self.inner.forward.len())
    }
}

/// Python wrapper for AnonymizeResult (output of anonymize* functions).
#[pyclass]
pub struct PyAnonymizeResult {
    #[pyo3(get)]
    pub text: String,
    #[pyo3(get)]
    pub token_map: PyTokenMap,
    #[pyo3(get)]
    pub entity_count: usize,
    #[pyo3(get)]
    pub entities: Vec<PyEntity>,
}

#[pymethods]
impl PyAnonymizeResult {
    pub fn __repr__(&self) -> String {
        format!(
            "AnonymizeResult(text_len={}, entities={})",
            self.text.len(),
            self.entity_count
        )
    }
}

// ============================================================================
// Core Python-facing functions
// ============================================================================

/// Detect entities in `text` and replace them with stable placeholder tokens.
#[pyfunction]
#[pyo3(signature = (text, existing=None))]
pub fn anonymize(text: &str, existing: Option<PyTokenMap>) -> PyAnonymizeResult {
    let existing_rust = existing.map(|tm| tm.to_rust());
    let result = rust_anon::anonymize(text, existing_rust);
    PyAnonymizeResult {
        text: result.text,
        token_map: PyTokenMap::from_rust(result.token_map),
        entity_count: result.entity_count,
        entities: result.detected.into_iter().map(PyEntity::from_rust).collect(),
    }
}

/// Anonymize with caller-supplied custom entities in addition to built-in detectors.
#[pyfunction]
#[pyo3(signature = (text, existing=None, custom_entities=None))]
pub fn anonymize_with_custom(
    text: &str,
    existing: Option<PyTokenMap>,
    custom_entities: Option<Vec<PyEntity>>,
) -> PyAnonymizeResult {
    let existing_rust = existing.map(|tm| tm.to_rust());
    let custom_entities = custom_entities.unwrap_or_default();
    let custom_rust: Vec<rust_anon::Entity> = custom_entities.into_iter().map(|e| e.to_rust()).collect();
    let result = rust_anon::anonymize_with_custom(text, existing_rust, &custom_rust);
    PyAnonymizeResult {
        text: result.text,
        token_map: PyTokenMap::from_rust(result.token_map),
        entity_count: result.entity_count,
        entities: result.detected.into_iter().map(PyEntity::from_rust).collect(),
    }
}

/// Reverse substitution: replace placeholder tokens in `text` with real entities.
#[pyfunction]
pub fn deanonymize(text: &str, token_map: &PyTokenMap) -> String {
    rust_anon::deanonymize(text, &token_map.inner)
}

/// Build or extend a TokenMap from detected entities with deterministic numbering.
#[pyfunction]
#[pyo3(signature = (entities, existing=None))]
pub fn build_token_map(entities: Vec<PyEntity>, existing: Option<PyTokenMap>) -> PyTokenMap {
    let entities_rust: Vec<rust_anon::Entity> = entities.into_iter().map(|e| e.to_rust()).collect();
    let existing_rust = existing.map(|tm| tm.to_rust());
    let result = rust_anon::build_token_map(&entities_rust, existing_rust);
    PyTokenMap::from_rust(result)
}

/// Apply a TokenMap's forward substitutions to text (entity → token).
#[pyfunction]
pub fn apply_token_map(text: &str, token_map: &PyTokenMap) -> String {
    rust_anon::apply_token_map(text, &token_map.inner)
}

/// Get the tech allowlist as a list of allowlisted terms.
/// These are case-sensitive proper nouns (frameworks, languages, SaaS names)
/// that should not be masked during anonymization.
///
/// Returns a list[str] for case-insensitive matching in the parity tests.
#[pyfunction]
pub fn get_tech_allowlist() -> Vec<&'static str> {
    rust_anon::TECH_ALLOWLIST.iter().copied().collect()
}

// ============================================================================
// Module
// ============================================================================

#[pymodule]
fn sci_anonymizer(_py: Python, m: &Bound<PyModule>) -> PyResult<()> {
    // Session format version constant.
    m.add("SESSION_FORMAT_VERSION", rust_anon::SESSION_FORMAT_VERSION)?;

    // Types (add with their public names).
    m.add("EntityType", _py.get_type_bound::<PyEntityType>())?;
    m.add("Entity", _py.get_type_bound::<PyEntity>())?;
    m.add("TokenMap", _py.get_type_bound::<PyTokenMap>())?;
    m.add("AnonymizeResult", _py.get_type_bound::<PyAnonymizeResult>())?;

    // Functions.
    m.add_function(wrap_pyfunction!(anonymize, m)?)?;
    m.add_function(wrap_pyfunction!(anonymize_with_custom, m)?)?;
    m.add_function(wrap_pyfunction!(deanonymize, m)?)?;
    m.add_function(wrap_pyfunction!(build_token_map, m)?)?;
    m.add_function(wrap_pyfunction!(apply_token_map, m)?)?;
    m.add_function(wrap_pyfunction!(get_tech_allowlist, m)?)?;

    Ok(())
}
