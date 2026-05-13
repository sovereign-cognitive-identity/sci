//! Handler-side state: storage adapter, embedder, upstream client.
//!
//! `HandlerState` is what the platform shell builds once at startup
//! and hands to every per-request handler call. Cheap to clone (each
//! field is wrapped in `Arc`).

use crate::cascade::CascadeMonitor;
use crate::types::Result;
use crate::upstream::UpstreamClient;
use async_trait::async_trait;
use sci_memory::LocalAdapter;
use std::sync::{Arc, Mutex};

/// Embed text into a 768-dim vector. Implemented by SCI-130 against
/// BGE-base-en-v1.5; SCI-126 ships a `NoopEmbedder` that returns a
/// zero vector so handler logic + tests can exercise the recall +
/// store flow without the model dependency.
///
/// Async because the real embedding implementation will offload to a
/// blocking pool (ONNX inference is CPU-bound enough to matter).
#[async_trait]
pub trait Embedder: Send + Sync {
    /// Returns a vector of length `sci_memory::EMBEDDING_DIM` (768).
    async fn embed(&self, text: &str) -> Result<Vec<f32>>;
}

/// Trivial embedder for tests + scaffolding. Returns a zero vector;
/// recall against zero-vector queries gets all-zero cosine scores
/// (uninformative but doesn't crash). Replaced wholesale by SCI-130's
/// real `BgeEmbedder`.
pub struct NoopEmbedder;

#[async_trait]
impl Embedder for NoopEmbedder {
    async fn embed(&self, _text: &str) -> Result<Vec<f32>> {
        Ok(vec![0.0; sci_memory::EMBEDDING_DIM])
    }
}

/// Per-process state. Built once by the platform shell, cloned into
/// each request handler.
///
/// `LocalAdapter` wraps a rusqlite `Connection` which has interior
/// mutability via `RefCell` — so `LocalAdapter: Send` but not `Sync`.
/// To make the whole `HandlerState` `Send + Sync` (a hard requirement
/// for the future to be `Send` and run on any tokio worker), we wrap
/// the adapter in a sync `Mutex`. Storage operations are short and
/// sync; we acquire the lock, run the call, drop the guard before
/// returning to async-land. No `.await` ever happens while the lock
/// is held — `clippy::await_holding_lock` would catch a regression.
pub struct HandlerState {
    pub storage:  Arc<Mutex<LocalAdapter>>,
    pub embedder: Arc<dyn Embedder>,
    pub upstream: Arc<dyn UpstreamClient>,
    /// SCI-156: globally-active identity profile name. Handlers route
    /// recall + storage to this profile; the admin API GETs/POSTs it.
    /// `Mutex<String>` rather than `ArcSwap` because reads/writes are
    /// rare (once per turn / once per profile-switch) and a tiny
    /// clone is fine. Default `"work"` matches the prior hard-coded
    /// behavior so existing flows are unaffected on first boot.
    pub active_profile: Arc<Mutex<String>>,

    /// SCI-159: globally-active project working directory. When set,
    /// handlers prepend a "Working directory: <path>" hint to the
    /// system prompt so model defaults filesystem-tool paths to this
    /// directory and accepts relative path references from the user.
    /// `None` means no project context is injected (the prior
    /// behavior). Same single-global-per-helper trade-off as
    /// `active_profile` — acceptable for v1 daily-driver use.
    pub active_project: Arc<Mutex<Option<String>>>,

    /// Cross-turn anonymizer cascade monitor. Tracks masked-entity counts
    /// across consecutive turns per profile; fires when 5 consecutive turns
    /// all exceed the elevated threshold (35 entities). Distinguishes a
    /// legitimate single dense document (one spike, returns to baseline)
    /// from a runaway cascade (sustained elevation across many turns).
    pub cascade_monitor: Arc<CascadeMonitor>,
}

impl HandlerState {
    pub fn new(
        storage:  Arc<Mutex<LocalAdapter>>,
        embedder: Arc<dyn Embedder>,
        upstream: Arc<dyn UpstreamClient>,
    ) -> Self {
        Self {
            storage,
            embedder,
            upstream,
            active_profile:  Arc::new(Mutex::new("work".to_string())),
            active_project:  Arc::new(Mutex::new(None)),
            cascade_monitor: Arc::new(CascadeMonitor::new()),
        }
    }

    /// Read the current active profile name. Brief lock; clone returns.
    pub fn active_profile_name(&self) -> String {
        self.active_profile
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "work".to_string())
    }

    /// Read the current active project working directory, if any.
    pub fn active_project_path(&self) -> Option<String> {
        self.active_project.lock().ok().and_then(|g| g.clone())
    }
}
