//! Cross-turn anonymizer cascade detection.
//!
//! The per-request circuit breaker (in `anonymize_messages_body`) catches
//! single-request over-masking. This module catches the *sustained growth*
//! pattern that caused the May 2026 LangGraph recursion-limit loop:
//!
//!   Turn 1:  23 entities masked
//!   Turn 2:  24 (+1)
//!   Turn 3:  26 (+2)
//!   Turn 4:  35 (+9)    ← tool schemas starting to degrade
//!   Turn 5:  42 (+7)    ← model begins narrating tool calls as text
//!   ...
//!   Turn 12: 63 (+?)    ← recursion limit hit
//!
//! Key property: the CASCADE is sustained elevation across many turns.
//! A LEGITIMATE spike (e.g. user sends a dense resume) is one turn above
//! the threshold then returns to baseline. The window requirement (5
//! consecutive elevated turns) distinguishes them.
//!
//! ## Why not just look at growth rate?
//!
//! The cascade on May 10 grew slowly — often 1–3 entities per turn.
//! A growth-rate check fires too late (or not at all). Sustained elevation
//! above a floor that's comfortably above normal operation is the right
//! signal.
//!
//! ## Thread safety
//!
//! `CascadeMonitor` is `Send + Sync`. The inner `Mutex` is held briefly
//! (O(window_size) work, no I/O, no `.await`). Safe to share across
//! async tasks via `Arc`.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// Number of consecutive turns that must all exceed `ELEVATED_THRESHOLD`
/// before the cascade breaker fires. 5 turns ≈ 5 minutes of active chat
/// — enough to distinguish a single dense document from a real cascade.
const CASCADE_WINDOW: usize = 5;

/// Masked-entity count that is "elevated" relative to normal operation.
///
/// Normal (post-fix) baseline: ~10–20 entities/turn (artifact instructions
/// + user message). A resume adds ~37, peaking at ~45–55. A cascade would
/// need to sustain above this level for CASCADE_WINDOW turns.
///
/// Setting at 35 means: one resume turn (40–55 entities) does NOT fire the
/// cascade breaker unless 4 more equally-dense turns follow. In practice
/// nobody sends 5 resumes in a row; the cascade would show sustained
/// elevation because the same conversation-history entities re-fire.
const ELEVATED_THRESHOLD: u32 = 35;

/// Monitors the anonymizer's masked-entity count across turns to detect
/// a runaway cascade before it corrupts tool schemas.
pub struct CascadeMonitor {
    /// Profile-id → ring buffer of the last CASCADE_WINDOW masked counts.
    history: Mutex<HashMap<String, VecDeque<u32>>>,
}

impl CascadeMonitor {
    pub fn new() -> Self {
        Self {
            history: Mutex::new(HashMap::new()),
        }
    }

    /// Record `count` for `profile_id`, then return `true` if a cascade
    /// is detected. Cascade condition: the last CASCADE_WINDOW turns (now
    /// including this one) all have masked_count > ELEVATED_THRESHOLD.
    ///
    /// Resets the window after firing so the system has CASCADE_WINDOW
    /// clean turns before it can fire again.
    pub fn update_and_check(&self, count: u32, profile_id: &str) -> bool {
        let mut history = self.history.lock().unwrap_or_else(|e| e.into_inner());
        let window = history.entry(profile_id.to_string()).or_default();

        window.push_back(count);
        if window.len() > CASCADE_WINDOW {
            window.pop_front();
        }

        let cascade = window.len() == CASCADE_WINDOW
            && window.iter().all(|&c| c > ELEVATED_THRESHOLD);

        if cascade {
            // Reset so the system has CASCADE_WINDOW turns to self-correct
            // before firing again. If it fires immediately again, the
            // underlying issue is still present.
            window.clear();
        }

        cascade
    }

    /// Manually reset history for a profile — useful when an admin action
    /// (e.g. restarting a session) makes the historical data stale.
    pub fn reset(&self, profile_id: &str) {
        let mut history = self.history.lock().unwrap_or_else(|e| e.into_inner());
        history.remove(profile_id);
    }

    /// Current window contents for a profile. Used in tests and the
    /// admin status endpoint to inspect monitor state without firing.
    #[cfg(test)]
    pub fn window_for(&self, profile_id: &str) -> Vec<u32> {
        let history = self.history.lock().unwrap_or_else(|e| e.into_inner());
        history
            .get(profile_id)
            .map(|w| w.iter().copied().collect())
            .unwrap_or_default()
    }
}

impl Default for CascadeMonitor {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_operation_never_fires() {
        let m = CascadeMonitor::new();
        // Typical post-fix baseline: 10–20 entities/turn.
        for count in [12, 14, 11, 15, 13, 16, 10, 18] {
            assert!(!m.update_and_check(count, "work"), "fired on normal count {count}");
        }
    }

    #[test]
    fn single_spike_does_not_fire() {
        // Resume: one elevated turn then back to normal.
        let m = CascadeMonitor::new();
        for count in [12, 14, 48, 13, 11] {
            let fired = m.update_and_check(count, "work");
            assert!(!fired, "fired on resume spike at count {count}");
        }
    }

    #[test]
    fn sustained_elevation_fires() {
        // Cascade: 5 consecutive turns all above threshold.
        let m = CascadeMonitor::new();
        let counts = [14, 36, 40, 42, 44, 46]; // first 14 is below threshold
        let mut fired = false;
        for (i, &count) in counts.iter().enumerate() {
            if m.update_and_check(count, "work") {
                fired = true;
                // Should fire on turn 5 (index 5), not earlier
                assert_eq!(i, 5, "cascade fired at wrong turn index {i}");
            }
        }
        assert!(fired, "cascade never fired despite sustained elevation");
    }

    #[test]
    fn resets_after_firing_allows_detection_again() {
        let m = CascadeMonitor::new();
        // First cascade
        for _ in 0..CASCADE_WINDOW {
            m.update_and_check(ELEVATED_THRESHOLD + 1, "work");
        }
        // Should have fired and reset. Now feed another window.
        let mut fired = false;
        for _ in 0..CASCADE_WINDOW {
            if m.update_and_check(ELEVATED_THRESHOLD + 1, "work") {
                fired = true;
            }
        }
        assert!(fired, "second cascade not detected after reset");
    }

    #[test]
    fn per_profile_isolation() {
        let m = CascadeMonitor::new();
        // Saturate "work" profile
        for _ in 0..CASCADE_WINDOW {
            m.update_and_check(ELEVATED_THRESHOLD + 5, "work");
        }
        // "personal" profile should be independent
        assert!(
            !m.update_and_check(ELEVATED_THRESHOLD + 5, "personal"),
            "personal profile affected by work profile history"
        );
    }

    #[test]
    fn window_resets_when_count_drops() {
        // If the count drops mid-window, the window resets naturally
        // (the low value prevents all() from returning true).
        let m = CascadeMonitor::new();
        for count in [40, 42, 44, 10, 46, 48] {
            // '10' breaks the streak; even if next 2 are high, only 2 in window
            let fired = m.update_and_check(count, "work");
            assert!(!fired, "fired when streak was broken at {count}");
        }
    }
}
