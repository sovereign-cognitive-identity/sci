//! Cross-turn anonymizer cascade detection.
//!
//! The per-request circuit breaker (in `anonymize_messages_body`) catches
//! single-request over-masking. This module catches the *sustained growth*
//! pattern that caused the May 2026 LangGraph recursion-limit loop:
//!
//!   Turn 1:  23 distinct entities masked
//!   Turn 2:  24 (+1)
//!   Turn 3:  26 (+2)
//!   Turn 4:  35 (+9)    ← tool schemas starting to degrade
//!   Turn 5:  42 (+7)    ← model begins narrating tool calls as text
//!   ...
//!   Turn 12: 63 (+?)    ← recursion limit hit
//!
//! ## Signal: distinct-entity growth, not absolute count (SCI-260)
//!
//! The first cut of this module fired when the *absolute* masked count
//! stayed above a fixed floor (35) for 5 turns. That floor counted
//! occurrences across the whole re-anonymized history, so it scaled with
//! **session length × entity density**, not with any feedback loop. Real
//! infra sessions (dense with IPs, hostnames, project/person names) sit at
//! 70–80 entities every turn and tripped the breaker on *every* long
//! legitimate session — 1720 false-positive 503s in one log.
//!
//! The honest discriminator is **saturation**:
//!
//!   - A LEGITIMATE session draws on a *finite* real vocabulary. Its
//!     distinct-entity count climbs as topics are introduced, then
//!     **plateaus** — the same names/IPs recur and dedupe through the token
//!     map, so net growth across a window decays to ~0.
//!   - A CASCADE keeps minting *new* tokens (placeholder re-tagging, NER
//!     over-firing on its own output). Its distinct count **never levels
//!     off**.
//!
//! So we track the count of *distinct* entities masked per turn
//! (`token_map.reverse.len()`, immune to repeat-mention inflation) and fire
//! only when, across the window, the count is (a) high, (b) grew by a
//! sustained margin, and (c) is *still climbing at the end* — the property
//! a saturating legitimate session lacks. A normal ramp-to-plateau dips or
//! flattens at the tail and is spared; a runaway is caught while still
//! below the per-request hard cap (`ANON_CIRCUIT_BREAKER = 100`).
//!
//! ## Thread safety
//!
//! `CascadeMonitor` is `Send + Sync`. The inner `Mutex` is held briefly
//! (O(window_size) work, no I/O, no `.await`). Safe to share across
//! async tasks via `Arc`.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// Length of the sliding window of recent distinct-entity counts.
const CASCADE_WINDOW: usize = 5;

/// Floor below which a window can never be a cascade. A cascade only
/// matters once distinct entities are genuinely elevated; this also keeps
/// short sessions that legitimately introduce their vocabulary (ramping
/// 1 → ~30 distinct entities) from ever firing. Sits comfortably below the
/// per-request hard cap (`ANON_CIRCUIT_BREAKER = 100`) so the cascade
/// breaker engages before the hard rollback does.
const HIGH_FLOOR: u32 = 50;

/// Minimum net growth in distinct entities across the window required to
/// call it "still growing." A saturating legitimate session nets ~0 (its
/// vocabulary is exhausted); a cascade keeps adding new tokens.
const SUSTAINED_GROWTH: u32 = 20;

/// Monitors the anonymizer's distinct-entity count across turns to detect
/// a runaway cascade before it corrupts tool schemas.
pub struct CascadeMonitor {
    /// Profile-id → ring buffer of the last CASCADE_WINDOW distinct counts.
    history: Mutex<HashMap<String, VecDeque<u32>>>,
}

impl CascadeMonitor {
    pub fn new() -> Self {
        Self {
            history: Mutex::new(HashMap::new()),
        }
    }

    /// Record this turn's `distinct_count` (number of distinct entities
    /// masked, i.e. `token_map.reverse.len()`) for `profile_id`, then return
    /// `true` if a cascade is detected.
    ///
    /// Cascade condition, over the last `CASCADE_WINDOW` turns:
    ///   1. the newest count is above `HIGH_FLOOR`,
    ///   2. it grew by at least `SUSTAINED_GROWTH` since the oldest turn in
    ///      the window (net non-saturating growth), and
    ///   3. it is *still climbing* at the tail (newest > previous) — the
    ///      property a saturating legitimate session lacks.
    ///
    /// Resets the window after firing so the system has CASCADE_WINDOW
    /// clean turns before it can fire again.
    pub fn update_and_check(&self, distinct_count: u32, profile_id: &str) -> bool {
        let mut history = self.history.lock().unwrap_or_else(|e| e.into_inner());
        let window = history.entry(profile_id.to_string()).or_default();

        window.push_back(distinct_count);
        if window.len() > CASCADE_WINDOW {
            window.pop_front();
        }

        let cascade = window.len() == CASCADE_WINDOW && {
            let newest = *window.back().unwrap();
            let oldest = *window.front().unwrap();
            let prev = window[window.len() - 2];

            newest > HIGH_FLOOR
                && (newest as i64 - oldest as i64) >= SUSTAINED_GROWTH as i64
                && newest > prev
        };

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
        // Typical baseline: well below HIGH_FLOOR.
        for count in [12, 14, 11, 15, 13, 16, 10, 18] {
            assert!(!m.update_and_check(count, "work"), "fired on normal count {count}");
        }
    }

    #[test]
    fn single_spike_does_not_fire() {
        // One dense turn (e.g. a pasted resume) then back to baseline.
        let m = CascadeMonitor::new();
        for count in [12, 14, 60, 13, 11] {
            assert!(!m.update_and_check(count, "work"), "fired on single spike at {count}");
        }
    }

    #[test]
    fn stable_high_dense_session_never_fires() {
        // SCI-260 regression: a long infra session sits at 70–80 distinct
        // entities every turn (IPs, hostnames, names) with normal volatility.
        // The old absolute-threshold breaker fired on every such turn (1720
        // false-positive 503s in one log). Saturation ⇒ net growth ≈ 0 ⇒
        // must never fire.
        let m = CascadeMonitor::new();
        for count in [78, 80, 70, 80, 70, 75, 80, 72, 78, 76] {
            assert!(
                !m.update_and_check(count, "work"),
                "false positive on stable-high count {count}"
            );
        }
    }

    #[test]
    fn slow_legitimate_ramp_does_not_fire() {
        // A session that introduces its vocabulary gradually (< SUSTAINED_GROWTH
        // per window) and then plateaus. Never trips.
        let m = CascadeMonitor::new();
        for count in [40, 45, 50, 54, 57, 60, 62, 63, 63, 62] {
            assert!(
                !m.update_and_check(count, "work"),
                "false positive on slow legit ramp at {count}"
            );
        }
    }

    #[test]
    fn accelerating_runaway_fires() {
        // A genuine cascade: distinct entities climb fast and keep climbing,
        // heading for the per-request hard cap. Caught before reaching it.
        let m = CascadeMonitor::new();
        let counts = [40, 50, 62, 75, 88, 96];
        let mut fired_at = None;
        for (i, &c) in counts.iter().enumerate() {
            if m.update_and_check(c, "work") {
                fired_at = Some(i);
                break;
            }
        }
        assert_eq!(
            fired_at,
            Some(4),
            "runaway should fire when the window first fills while still climbing"
        );
    }

    #[test]
    fn growth_that_plateaus_at_tail_does_not_fire() {
        // Net growth across the window is large, but the count has stopped
        // climbing at the tail (newest == prev) — saturation. The "still
        // climbing" guard spares it.
        let m = CascadeMonitor::new();
        for count in [40, 55, 70, 82, 82] {
            assert!(
                !m.update_and_check(count, "work"),
                "fired despite plateaued tail at {count}"
            );
        }
    }

    #[test]
    fn resets_after_firing_allows_detection_again() {
        let m = CascadeMonitor::new();
        // First runaway fires when the window fills and resets it.
        for c in [40, 50, 62, 75, 88] {
            m.update_and_check(c, "work");
        }
        assert!(m.window_for("work").is_empty(), "window should reset after firing");
        // A second runaway must be detectable again.
        let mut fired = false;
        for c in [55, 65, 75, 85, 95] {
            fired |= m.update_and_check(c, "work");
        }
        assert!(fired, "second runaway not detected after reset");
    }

    #[test]
    fn per_profile_isolation() {
        let m = CascadeMonitor::new();
        // Drive "work" into a cascade.
        for c in [40, 50, 62, 75, 88] {
            m.update_and_check(c, "work");
        }
        // "personal" has its own (empty) history and is unaffected.
        assert!(
            !m.update_and_check(90, "personal"),
            "personal profile affected by work profile history"
        );
    }
}
