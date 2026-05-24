//! SCI-152: localhost-only admin HTTP API + SSE event stream.
//!
//! Lives on `127.0.0.1:3002` (default; configurable via `--admin <port>`
//! or `SCI_HELPER_ADMIN_PORT`). The helper's proxy listener is on 3001;
//! the admin listener is a sibling so the surfaces don't share TCP
//! lifetimes and so the admin port can be off (proxy still works) or
//! the proxy off (admin still works for inspecting an existing DB).
//!
//! Endpoints (v1):
//!
//!   GET /sci/status                       — version, uptime, db stats
//!   GET /sci/audit_turns?limit=&profile=  — flight-recorder rows
//!   GET /sci/audit_turns/:id              — one turn + its mappings
//!   GET /sci/audit_turns/count?original=  — count_token_original
//!   GET /sci/profiles                     — profile list
//!   GET /sci/recall?query=&profile=&limit — recall preview (no store)
//!   GET /sci/identity?query=&category=&limit — identity facts (semantic or confidence-ranked)
//!   GET /sci/memories?profile=&limit=     — all memories for graph
//!  POST /sci/memories                     — store a memory (episodic|identity)
//! DELETE /sci/memories/:id                — delete an episodic memory + vector
//!   GET /sci/events                       — SSE event stream
//!
//! Bind is hardcoded to `127.0.0.1` (never `0.0.0.0`); the localhost
//! constraint is what makes CORS permissive safe.
//!
//! Why axum vs. hand-rolling on tokio TCP (like proxy.rs): axum gives
//! us routing, JSON ser/de, Query extractor, SSE framing, and CORS in
//! ~120 KB of release-binary growth. Hand-rolling all that for seven
//! endpoints would be 5x the LoC at lower correctness.

use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        IntoResponse,
        sse::{Event as SseEvent, KeepAlive, Sse},
    },
    routing::{delete, get},
};
use futures::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::{convert::Infallible, sync::Arc, time::Instant};
use tokio::net::TcpListener;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::cors::CorsLayer;

use std::collections::HashMap;

use sci_core::handlers::HandlerState;
use sci_core::memory::{
    AuditTurn, IdentityFact, Profile, RecallQuery, RecallResult, RecallType, StorageStats,
    StoreEpisodicInput, StoreIdentityInput, TokenMapping,
};

use crate::events::EventBus;

/// State threaded into every admin handler. Cheap to clone (everything
/// is `Arc`-wrapped already).
#[derive(Clone)]
pub struct AdminState {
    pub handler_state: Arc<HandlerState>,
    pub events:        EventBus,
    pub version:       &'static str,
    pub started_at:    Instant,
}

/// Build the admin router. Exposed for tests that want to bind the
/// listener themselves (e.g. on port 0 to discover the assigned port).
pub fn admin_router(state: AdminState) -> Router {
    // CORS: permissive is safe because the listener is bound to
    // 127.0.0.1 only. The only callers are same-machine processes
    // (sci-chat backend/frontend, future sci clients). A non-local
    // attacker can't reach the listener at all.
    let cors = CorsLayer::permissive();

    Router::new()
        .route("/sci/status",            get(get_status))
        .route("/sci/audit_turns",       get(list_audit_turns))
        .route("/sci/audit_turns/count", get(count_token_original))
        .route("/sci/audit_turns/:id",   get(get_audit_turn))
        .route("/sci/profiles",          get(list_profiles).post(create_profile))
        .route("/sci/active_profile",    get(get_active_profile).post(set_active_profile))
        .route("/sci/active_project",    get(get_active_project).post(set_active_project))
        .route("/sci/recall",            get(preview_recall))
        .route("/sci/identity",          get(list_identity))
        .route("/sci/memories",           get(list_memories).post(store_memory))
        .route("/sci/memories/:id",      delete(delete_memory))
        .route("/sci/events",            get(events_stream))
        .layer(cors)
        .with_state(state)
}

/// Serve the admin HTTP API on a pre-bound listener. Caller is
/// responsible for `TcpListener::bind` — that way tests can use port 0
/// and read the assigned port off the listener before serving.
pub async fn serve_admin(listener: TcpListener, state: AdminState) -> Result<()> {
    let addr = listener.local_addr()?;
    tracing::info!(addr = %addr, "admin API listening");
    axum::serve(listener, admin_router(state)).await?;
    Ok(())
}

// ── /sci/status ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    version:        &'static str,
    uptime_seconds: u64,
    stats:          StorageStats,
}

async fn get_status(State(s): State<AdminState>) -> Result<Json<StatusResponse>, AdminError> {
    let stats = with_storage(&s, |a| a.get_stats())?;
    Ok(Json(StatusResponse {
        version:        s.version,
        uptime_seconds: s.started_at.elapsed().as_secs(),
        stats,
    }))
}

// ── /sci/audit_turns ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ListTurnsQuery {
    /// Optional profile name OR id. Name-lookup happens server-side.
    profile: Option<String>,
    /// Default 50, clamped to 200.
    limit:   Option<usize>,
}

async fn list_audit_turns(
    State(s): State<AdminState>,
    Query(q): Query<ListTurnsQuery>,
) -> Result<Json<Vec<AuditTurn>>, AdminError> {
    let limit = q.limit.unwrap_or(50).min(200);
    let turns = with_storage(&s, |a| {
        let profile_id = resolve_profile_id(a, q.profile.as_deref())?;
        a.list_audit_turns(profile_id.as_deref(), limit)
    })?;
    Ok(Json(turns))
}

#[derive(Serialize)]
struct AuditTurnDetail {
    turn:     AuditTurn,
    mappings: Vec<TokenMapping>,
}

async fn get_audit_turn(
    State(s): State<AdminState>,
    Path(id): Path<String>,
) -> Result<Json<AuditTurnDetail>, AdminError> {
    let result = with_storage(&s, |a| a.get_audit_turn(&id))?;
    match result {
        Some((turn, mappings)) => Ok(Json(AuditTurnDetail { turn, mappings })),
        None => Err(AdminError::NotFound(format!("audit_turn {id}"))),
    }
}

#[derive(Deserialize)]
struct CountQuery {
    original: String,
    profile:  Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CountResponse {
    original: String,
    count:    u64,
}

async fn count_token_original(
    State(s): State<AdminState>,
    Query(q): Query<CountQuery>,
) -> Result<Json<CountResponse>, AdminError> {
    let original = q.original.clone();
    let count = with_storage(&s, |a| {
        let profile_id = resolve_profile_id(a, q.profile.as_deref())?;
        a.count_token_original(&q.original, profile_id.as_deref())
    })?;
    Ok(Json(CountResponse { original, count }))
}

// ── /sci/profiles ──────────────────────────────────────────────────────────

async fn list_profiles(State(s): State<AdminState>) -> Result<Json<Vec<Profile>>, AdminError> {
    let profiles = with_storage(&s, |a| a.list_profiles())?;
    Ok(Json(profiles))
}

#[derive(Deserialize)]
struct CreateProfileBody {
    name: String,
}

/// SCI-156: create a profile. Idempotent — calling with an existing
/// name returns that profile. Empty / whitespace-only names are 400.
async fn create_profile(
    State(s):    State<AdminState>,
    Json(input): Json<CreateProfileBody>,
) -> Result<Json<Profile>, AdminError> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AdminError::BadRequest("profile name cannot be empty".into()));
    }
    let owned = name.to_owned();
    let profile = with_storage(&s, |a| a.create_profile(&owned))?;
    Ok(Json(profile))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveProfileResponse {
    name: String,
}

/// SCI-156: read the currently-active profile name. The handlers
/// (anthropic.rs / openai.rs / google.rs) use this name to route
/// recall + storage. Default `"work"` on first boot.
async fn get_active_profile(State(s): State<AdminState>) -> Json<ActiveProfileResponse> {
    Json(ActiveProfileResponse {
        name: s.handler_state.active_profile_name(),
    })
}

#[derive(Deserialize)]
struct SetActiveProfileBody {
    name: String,
}

/// SCI-156: set the active profile name. The string is stored as-is;
/// resolution to a profile-id happens lazily per-request inside the
/// handlers. We don't validate that the name exists here so a user can
/// type-then-create a profile in either order.
async fn set_active_profile(
    State(s):    State<AdminState>,
    Json(input): Json<SetActiveProfileBody>,
) -> Result<Json<ActiveProfileResponse>, AdminError> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AdminError::BadRequest("profile name cannot be empty".into()));
    }
    {
        let mut g = s.handler_state.active_profile.lock()
            .map_err(|_| AdminError::Internal("active_profile lock poisoned".into()))?;
        *g = name.to_owned();
    }
    tracing::info!(profile = name, "active profile set");
    Ok(Json(ActiveProfileResponse { name: name.to_owned() }))
}

// ── /sci/active_project (SCI-159 Project Mode) ────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveProjectResponse {
    /// Absolute path of the active project's working directory, or
    /// `null` when no project is set.
    path: Option<String>,
}

#[derive(Deserialize)]
struct SetActiveProjectBody {
    /// Pass an absolute path to set the project, or `null` (or empty
    /// string) to clear it.
    path: Option<String>,
}

/// SCI-159: read the currently-active project working directory.
/// `null` means no project mode is active.
async fn get_active_project(State(s): State<AdminState>) -> Json<ActiveProjectResponse> {
    Json(ActiveProjectResponse {
        path: s.handler_state.active_project_path(),
    })
}

/// SCI-159: set or clear the active project working directory.
/// We do not validate that the path exists on disk — the helper is
/// localhost-only and the path is just metadata threaded into the
/// system prompt; an invalid path produces a no-op recall hit but
/// no security impact. Trimming + collapsing empty-string-to-None
/// keeps the wire shape ergonomic for the JS client.
async fn set_active_project(
    State(s):    State<AdminState>,
    Json(input): Json<SetActiveProjectBody>,
) -> Result<Json<ActiveProjectResponse>, AdminError> {
    let normalized: Option<String> = input
        .path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    {
        let mut g = s.handler_state.active_project.lock()
            .map_err(|_| AdminError::Internal("active_project lock poisoned".into()))?;
        *g = normalized.clone();
    }
    match &normalized {
        Some(p) => tracing::info!(project = %p, "active project set"),
        None    => tracing::info!("active project cleared"),
    }
    Ok(Json(ActiveProjectResponse { path: normalized }))
}

// ── /sci/memories ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ListMemoriesQuery {
    profile: Option<String>,
    /// Default 200, clamped to 500.
    limit:   Option<usize>,
}

/// Wire shape returned for every node in the graph. Flattened to a single
/// type so the frontend doesn't need to discriminate three separate arrays.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryNode {
    id:         String,
    #[serde(rename = "type")]
    kind:       &'static str,
    content:    String,
    category:   Option<String>,
    confidence: Option<f64>,
    #[serde(rename = "occurredAt")]
    occurred_at: Option<String>,
    #[serde(rename = "createdAt")]
    created_at:  String,
}

#[derive(Serialize)]
struct MemoryGraphResponse {
    nodes: Vec<MemoryNode>,
}

async fn list_memories(
    State(s): State<AdminState>,
    Query(q): Query<ListMemoriesQuery>,
) -> Result<Json<MemoryGraphResponse>, AdminError> {
    let limit = q.limit.unwrap_or(200).min(500);
    let nodes = with_storage(&s, |a| {
        let profile_id = resolve_profile_id(a, q.profile.as_deref())?;
        let pid = profile_id.as_deref();

        let mut nodes: Vec<MemoryNode> = Vec::new();

        for e in a.list_episodic(pid, limit)? {
            nodes.push(MemoryNode {
                id:          e.id,
                kind:        "episodic",
                content:     e.content,
                category:    None,
                confidence:  None,
                occurred_at: Some(e.occurred_at.to_rfc3339()),
                created_at:  e.created_at.to_rfc3339(),
            });
        }

        for s in a.list_semantic(pid, limit)? {
            nodes.push(MemoryNode {
                id:          s.id,
                kind:        "semantic",
                content:     s.content,
                category:    s.category,
                confidence:  Some(s.confidence),
                occurred_at: None,
                created_at:  s.created_at.to_rfc3339(),
            });
        }

        for f in a.query_identity_facts(None, limit)? {
            nodes.push(MemoryNode {
                id:          f.id,
                kind:        "identity",
                content:     f.content,
                category:    f.category,
                confidence:  Some(f.confidence),
                occurred_at: None,
                created_at:  f.created_at.to_rfc3339(),
            });
        }

        Ok(nodes)
    })?;

    Ok(Json(MemoryGraphResponse { nodes }))
}

// ── /sci/recall ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct RecallParams {
    query:   String,
    profile: Option<String>,
    limit:   Option<usize>,
}

async fn preview_recall(
    State(s): State<AdminState>,
    Query(q): Query<RecallParams>,
) -> Result<Json<Vec<RecallResult>>, AdminError> {
    // Resolve profile_id BEFORE embedding the query — saves the
    // embedder round-trip if the requested profile doesn't exist.
    let profile_id = with_storage(&s, |a| resolve_profile_id(a, q.profile.as_deref()))?
        .ok_or_else(|| AdminError::BadRequest("profile not found".into()))?;

    // Embed the query. This is the only `.await` between storage
    // locks — we do not hold a guard across it.
    let embedding = s.handler_state.embedder.embed(&q.query).await
        .map_err(|e| AdminError::Internal(format!("embed: {e}")))?;

    let limit = q.limit.unwrap_or(10).min(50);
    let hits = with_storage(&s, |a| {
        a.recall(&RecallQuery {
            query_embedding:   &embedding,
            query:             &q.query,
            profile_id:        &profile_id,
            limit,
            types:             &[],
        })
    })?;
    Ok(Json(hits))
}

// ── /sci/identity ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct IdentityParams {
    query:    Option<String>,
    category: Option<String>,
    limit:    Option<usize>,
}

/// `GET /sci/identity` — retrieve identity facts.
///
/// Without `query`: returns facts ordered by confidence descending (optionally
/// filtered by `category`). This is the "load Casey's profile" path.
///
/// With `query`: runs a semantic search over `embeddings_identity` then joins
/// back to `identity_facts` to include `category` and `confidence`.
async fn list_identity(
    State(s): State<AdminState>,
    Query(q): Query<IdentityParams>,
) -> Result<Json<Vec<IdentityFact>>, AdminError> {
    let limit = q.limit.unwrap_or(20).min(100);

    if let Some(query) = q.query {
        // Semantic search path.  Embed the query, recall identity-type only,
        // then join to identity_facts to get category/confidence.
        let embedding = s.handler_state.embedder.embed(&query).await
            .map_err(|e| AdminError::Internal(format!("embed: {e}")))?;

        let hits = with_storage(&s, |a| {
            // profile_id is ignored for RecallType::Identity — pass empty str.
            a.recall(&RecallQuery {
                query_embedding: &embedding,
                query:           &query,
                profile_id:      "",
                limit,
                types:           &[RecallType::Identity],
            })
        })?;

        // Join each hit back to identity_facts for the full row.
        let facts = with_storage(&s, |a| {
            let mut out: Vec<IdentityFact> = Vec::with_capacity(hits.len());
            for hit in &hits {
                let fact_opt: Option<IdentityFact> = a.query_identity_facts(None, usize::MAX)
                    .unwrap_or_default()
                    .into_iter()
                    .find(|f| f.id == hit.id);
                if let Some(f) = fact_opt {
                    out.push(f);
                }
            }
            Ok(out)
        })?;
        Ok(Json(facts))
    } else {
        // Confidence-ranked list path.
        let facts = with_storage(&s, |a| {
            a.query_identity_facts(q.category.as_deref(), limit)
        })?;
        Ok(Json(facts))
    }
}

// ── /sci/memories (POST: store) ──────────────────────────────────────────────

#[derive(Deserialize)]
struct StoreMemoryBody {
    content: String,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    metadata: Option<HashMap<String, serde_json::Value>>,
    /// "episodic" (default) or "identity".
    #[serde(default)]
    kind: Option<String>,
    /// Identity-only: preference | value | skill | relationship | project | context.
    #[serde(default)]
    category: Option<String>,
    /// Identity-only: 0.0–1.0.
    #[serde(default)]
    confidence: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreMemoryResponse {
    id:     String,
    stored: bool,
}

/// Write a memory to the live SQLite + sqlite-vec store. This is the
/// single write path shared with the proxy, so memories stored here are
/// immediately recallable via `/sci/recall`. Embedding happens with the
/// same `handler_state.embedder` used by recall — no model drift.
///
/// The embed `.await` is taken before any storage lock (mirrors
/// `preview_recall`), so `clippy::await_holding_lock` stays satisfied.
async fn store_memory(
    State(s):    State<AdminState>,
    Json(input): Json<StoreMemoryBody>,
) -> Result<Json<StoreMemoryResponse>, AdminError> {
    let content = input.content.trim();
    if content.is_empty() {
        return Err(AdminError::BadRequest("content cannot be empty".into()));
    }

    let embedding = s.handler_state.embedder.embed(content).await
        .map_err(|e| AdminError::Internal(format!("embed: {e}")))?;

    let metadata = input.metadata.unwrap_or_default();
    let kind = input.kind.as_deref().unwrap_or("episodic");

    let id = match kind {
        "identity" => with_storage(&s, |a| {
            a.store_identity_fact(&StoreIdentityInput {
                content,
                embedding:  &embedding,
                category:   input.category.as_deref(),
                confidence: input.confidence,
                metadata,
            })
        })?,
        "episodic" => {
            let profile_name = input.profile.clone()
                .unwrap_or_else(|| s.handler_state.active_profile_name());
            with_storage(&s, |a| {
                let profile_id = match a.get_profile(&profile_name)? {
                    Some(p) => p.id,
                    None    => a.create_profile(&profile_name)?.id,
                };
                a.store_episodic(&StoreEpisodicInput {
                    profile_id: &profile_id,
                    content,
                    embedding:  &embedding,
                    source:     input.source.as_deref(),
                    agent_id:   None,
                    metadata,
                })
            })?
        }
        other => return Err(AdminError::BadRequest(format!("unknown kind: {other}"))),
    };

    Ok(Json(StoreMemoryResponse { id, stored: true }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteMemoryResponse {
    deleted: bool,
}

/// Delete an episodic memory (row + vector) by id. 404 if it doesn't exist.
async fn delete_memory(
    State(s):  State<AdminState>,
    Path(id):  Path<String>,
) -> Result<Json<DeleteMemoryResponse>, AdminError> {
    let deleted = with_storage(&s, |a| a.delete_episodic(&id))?;
    if !deleted {
        return Err(AdminError::NotFound(format!("memory not found: {id}")));
    }
    Ok(Json(DeleteMemoryResponse { deleted: true }))
}

// ── /sci/events (SSE) ──────────────────────────────────────────────────────

/// SSE stream of helper events. Subscribes to the broadcast bus; one
/// event per `data:` line. Format matches the Unix-socket subscriber
/// (`run_subscriber`) so consumers can use the same JSON parsing.
///
/// On subscriber lag (>256 events buffered), we drop the lagged frames
/// and continue rather than killing the connection — same policy as
/// the Unix-socket subscriber.
async fn events_stream(
    State(s): State<AdminState>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = s.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|res| async move {
        match res {
            Ok(event) => {
                // The Event enum already serializes with `"type":"..."`
                // embedded in the JSON. Send the whole thing as the
                // SSE `data` payload; consumers parse `type` to
                // discriminate. Matches the Unix-socket wire format.
                let data = serde_json::to_string(&event).ok()?;
                Some(Ok(SseEvent::default().data(data)))
            }
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(n)) => {
                tracing::debug!("admin SSE subscriber lagged by {n}");
                None
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Acquire the storage lock, run a sync closure, release. The closure
/// must NOT `.await` — `clippy::await_holding_lock` would fire on a
/// regression. All read paths in `LocalAdapter` are sync, so this is
/// the natural shape.
fn with_storage<F, T>(s: &AdminState, f: F) -> Result<T, AdminError>
where
    F: FnOnce(&sci_core::memory::LocalAdapter) -> sci_core::memory::Result<T>,
{
    let guard = s.handler_state.storage.lock()
        .map_err(|_| AdminError::Internal("storage lock poisoned".into()))?;
    f(&guard).map_err(|e| AdminError::Internal(e.to_string()))
}

/// Resolve a profile reference (name OR id) to an id. `None` input →
/// `Ok(None)`, meaning "no profile filter." Returns `Err` only on a DB
/// error; an unknown name returns `Ok(None)` so list endpoints with a
/// bogus profile filter return an empty list rather than a 500.
fn resolve_profile_id(
    a:    &sci_core::memory::LocalAdapter,
    pref: Option<&str>,
) -> sci_core::memory::Result<Option<String>> {
    let Some(p) = pref else { return Ok(None); };
    // Try by name first (the common case from URL params).
    if let Some(profile) = a.get_profile(p)? {
        return Ok(Some(profile.id));
    }
    // Fall back to treating it as a raw id by checking if any profile
    // matches it. We don't have a get_profile_by_id method — list and
    // scan; profile count is in the single digits.
    let profiles = a.list_profiles()?;
    Ok(profiles.into_iter().find(|x| x.id == p).map(|x| x.id))
}

// ── Error type ─────────────────────────────────────────────────────────────

#[derive(Debug)]
enum AdminError {
    NotFound(String),
    BadRequest(String),
    Internal(String),
}

impl IntoResponse for AdminError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match self {
            AdminError::NotFound(m)   => (StatusCode::NOT_FOUND,            m),
            AdminError::BadRequest(m) => (StatusCode::BAD_REQUEST,          m),
            AdminError::Internal(m)   => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}
