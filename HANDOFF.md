# Handoff

_Last updated: 2026-06-22 (session 2). Pushed the 5 staged commits to origin, fixed a CI infra bug, drove the parity Action green, closed SCI-289. Now driving toward a new release._

## Goal

Sci is a sovereign cognitive identity layer. Current focus: **cut a new release** bundling all unreleased work (Lanes A/B/C bindings, parity, CI, rate limiter) and reconcile the stale release-tail tickets. The cold soak has **passed** (helper ~9d continuous uptime) and no longer gates anything.

## Current state (verified ground truth, not Jira)

- **`origin/main` == local `main`**, fully synced. Parity CI **green** on origin (run `27950420769`).
- **Last release = `v0.1.1-alpha` (Jun 12). `main` is 33 commits AHEAD of it.** Everything since — multi-language bindings (SCI-272 epic: WASM + Python + parity), SCI-365 allowlist dedup, SCI-289 CI, rate limiter SCI-364 — is **UNRELEASED**.
- **No open PRs.** So SCI-265 ("merge PR #36") and SCI-262 ("merge PR #37") are already done in fact; PR #37 was merged Jun 12 and v0.1.1-alpha tagged then. Board is stale.
- **Soak PASSED:** helper PID 73247 ~8d22h continuous uptime, healthy, actively masking live traffic. Soak-gating in prior handoff is void.

## What session 2 did

1. **Pushed** the 5 staged commits (`6b130488 → 1e80e4c7`) to origin after confirming with Casey.
2. First parity Action **failed — a real catch:** pinned `rustwasm.org` wasm-pack installer host no longer resolves; `curl … | sh` silently installed nothing. The SCI-289 fail-fast `wasm-pack --version` guard correctly refused to false-green. **The guard earned its keep.**
3. **Fixed** installer host → `rustwasm.github.io` (`9d196a00`), re-pushed, Action **green** (Rust/Python/WASM all ran).
4. **SCI-289 → Done** in Jira with a comment documenting the gate.

## Release plan (in progress)

Two independent tracks. **Track 1 is the immediate deliverable.**

### Track 1 — Helper alpha release ✅ DONE (2026-06-22)
- **v0.2.0-alpha released:** tagged on `9d196a00`, pushed; GitHub prerelease with `sci-helper-{aarch64,x86_64}-apple-darwin` + `SHA256SUMS`. https://github.com/sovereign-cognitive-identity/sci/releases/tag/v0.2.0-alpha
- Notes file: `/tmp/sci-v0.2.0-alpha-notes.md` (no committed CHANGELOG exists yet — optional follow-up).
- Built via `make release-all` (needed `rustup target add x86_64-apple-darwin`). Crate version stays 0.5.0 — release tags are manual/decoupled, matching how v0.1.1-alpha was cut.
- **Jira reconciled:** SCI-262/265/266 → Done. **SCI-267 (notify testers) left OPEN** — needs the alpha-tester list/channel (none wired into the repo); ready to announce once Casey provides it.

### Track 2 — Language-package publishes (PIPELINE BUILT — needs secrets + dispatch)
Decision (Casey, 2026-06-22): **publish via GitHub Actions** (this repo is PUBLIC → Actions are free; the "out of GH credits" constraint does not apply here) at version **0.2.0**.

**Done this session:**
- `.github/workflows/publish.yml` (`89463926`) — publishes npm (WASM) + PyPI (maturin: manylinux x86_64/aarch64 + macOS x86_64/aarch64 + sdist) on **Release published** or **manual workflow_dispatch**.
- Bumped WASM `package.json` + PyPI `pyproject.toml` to **0.2.0**.
- Fixed npm nits: dead `prepublish` → `prepublishOnly` w/ `--no-opt`; broken repo URL `cognitive-os/sci` → `sovereign-cognitive-identity/sci`.

**REMAINING — needs Casey (workflow won't publish until these):**
1. Add repo secrets: **`NPM_TOKEN`** (npm automation token, publish rights to `@sovereign-cognitive-identity`) + **`PYPI_TOKEN`** (PyPI API token for `sci-anonymizer`).
2. Trigger: the v0.2.0-alpha release already exists so `release:published` won't re-fire — run **`gh workflow run publish.yml`** (workflow_dispatch) to publish 0.2.0 now. Future releases auto-publish.
3. Note: published package version is plain **0.2.0** (installable by default), while the git/GitHub release is **v0.2.0-alpha**. Minor inconsistency — switch packages to `0.2.0a0`/`0.2.0-alpha.0` if prerelease-gating is wanted.

**Local toolchain is broken (why we went CI, FYI):** node 26 default → npm 11.12.1 crashes (`minipass`/node26 incompat); node@22 keg → missing `libsimdjson.31.dylib`. `brew reinstall node@22` would fix local if ever needed.

- **SCI-280** crates.io — still **genuinely blocked:** monorepo uses `path = "../sci-anonymizer"`; needs **SCI-277** (standalone repo, preserved history) first. Not covered by publish.yml.

## Still open / for human confirmation

- **Lanes A/B subtasks** show "To Do" but code is merged — confirm & close: SCI-274/277/280/281 (A); SCI-273/290–296 (B). Note SCI-277 + SCI-280 are genuinely NOT done.
- **SCI-276** (integrated-proxy regression sign-off) + **SCI-268** (embedder cold-start verify): now soak-unblocked but require running the live proxy/embedder — do on a quiet window.
- **SCI-264 / SCI-270** alpha-feedback triage — PARKED, needs a feedback source/labeling scheme from a human.
- Optional: bump shipped `SCI_RATE_LIMIT_MAX` default >120 in code (needs helper rebuild).

## Context & Gotchas

### Services (launchd-managed — use kickstart, never kill/nohup)
```bash
launchctl kickstart -k "gui/$(id -u)/dev.sci.helper"   # Rust helper :3001 proxy / :3002 admin (KeepAlive=true)
launchctl kickstart -k "gui/$(id -u)/com.sci.agent"    # Node agent :8080 (KeepAlive=true)
launchctl list | grep -i sci
```
- Helper logs: `~/Library/Logs/sci-helper.log`. Plists: `~/Library/LaunchAgents/{dev.sci.helper,com.sci.agent}.plist`.

### Rate limiter (SCI-364 Done)
- `SCI_RATE_LIMIT_MAX` (default 120) + `SCI_RATE_LIMIT_WINDOW_SECS` (default 60) in `core/crates/sci-handlers/src/state.rs`. No ENABLED/RPS/BURST/LOG flag. Plist currently sets `SCI_RATE_LIMIT_MAX=5000` so dev fan-out + soak share `:3001` without self-429ing.

### Jira
- Cloud ID `e04b7caa-9314-439b-9772-d2bf75440183`; Done transition ID `31` (Task + Subtask). PRD backlog labeled `strategy-2026`, `phase-0`…`phase-5`. Each epic ships independently.

### Codebase conventions
- Rust core: `core/` workspace (`crates/*` glob). Build helper: `cargo build --release -p sci-helper` from `apps/sci-mac/SciHelper/`.
- Parity: shared fixtures `core/tests/fixtures/anonymizer.json` (43 cases) + `make test-parity-all`.
- Release: `make release-all` (arm+x86 helper binaries → `dist/` + SHA256SUMS). No CHANGELOG yet.
