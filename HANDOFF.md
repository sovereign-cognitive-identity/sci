# Handoff

_Last updated: 2026-05-24 — identity pipeline shipped, tickets closed, next up is SCI-249/SCI-223 closure then SCI-254 (sci status CLI)._

## Goal

Sci is a sovereign cognitive identity layer. Current focus: get to v0.1.0-alpha — a one-command install that works on a fresh Mac and routes Claude Code through the Sci proxy with memory.

## Current Progress

### This session (identity pipeline + ticket triage)

**`a8c54e05` — Daily identity pipeline**
- `scripts/dedup-identity.py` — token-Jaccard clustering + Haiku merges, deletes from SQLite directly
- `scripts/review-stale-facts.py` — future-tense fact review; rewrites completed, deletes abandoned, logs stale
- `scripts/run-identity-pipeline.sh` — 3-step wrapper: bootstrap → dedup → stale-review
- `~/Library/LaunchAgents/dev.sci.bootstrap-identity.plist` — daily at 03:00
- identity_facts: 409 total (background 150, preference 96, skill 74, value 72, relationship 16)

**Tickets closed: SCI-247, SCI-248, SCI-210** (dedup + launchd pipeline)

**Ticket triage completed — alpha release order:**
- SCI-249 (Phase 1 epic) — **already done**, just needs closing (SCI-239 + SCI-228 shipped)
- SCI-223 (SQLite-only stack) — **likely already done**, needs verify + close
- SCI-254 → SCI-253 → SCI-218 → SCI-257 → SCI-250 (the real remaining work)

### Prior sessions
- Proxy `cache_control` fixes (SCI-239, SCI-228) — shipped in `3e771a95`, `a2dde61f`, `07185e2d`
- Identity bootstrap Phase A+B, 4 sync bugs fixed, recall content-fingerprint dedup
- `spawn` command updated to launch `claude-sci` instead of `claude`

## What Worked

- **SQLite direct deletes** for identity facts (admin API DELETE only covers episodic)
- **`env HTTPS_PROXY="" python3 script.py`** for direct Anthropic API calls (system-wide `HTTPS_PROXY=http://127.0.0.1:3001`)
- **OAuth Bearer only** — `Authorization: Bearer <token>` + `anthropic-beta: claude-code-20250219`. No `x-api-key`.
- **Sequential curl with 0.5s sleep** for admin API POSTs (concurrent urllib Python calls → 500)
- **Iterative dedup** — run `dedup-identity.py` until "Found 0 clusters" (2–3 passes to converge)

## What Didn't Work

- **Admin API `DELETE /sci/memories/:id`** — only handles episodic; returns 404 for identity fact IDs
- **`x-api-key` header with OAuth token** — 401; OAuth mode uses only `Authorization: Bearer`
- **Admin API pagination** (`?offset=100`) — ignored; always returns same 100 rows. Use SQLite directly for full dataset.
- **Concurrent urllib POSTs** — 500 from helper; use sequential curl instead

## Next Steps

1. **Close SCI-249** — both sub-tickets (SCI-239: cache_control, SCI-228: auto-route) shipped. Transition epic to Done.
2. **Verify + close SCI-223** — check that MCP + CLI use SQLite backend (not Postgres). If healthy, close.
3. **Implement SCI-254** — `sci status` + `sci verify` CLI subcommands in `packages/cli/`:
   - `sci status`: check helper :3001/:3002, agent :8080, MCP in `~/.claude.json`, CA trust, credentials.env, memory counts
   - `sci verify`: proxied test request showing anonymization pipeline (PII in → anonymized out → deanonymized back)
4. **Write SCI-253** — `install.sh`: unpack tarball, CA trust, launchd plists, MCP register, credentials prompt, proxy config, call `sci status`
5. **Fix SCI-218** — CI macOS-13 runner hangs (needed to produce signed release tarball)
6. **Tag SCI-257** — v0.1.0-alpha GitHub Release with signed tarballs
7. **SCI-250** — tester onboarding

## Context & Gotchas

### Services
```bash
launchctl kickstart -k "gui/$(id -u)/dev.sci.helper"   # Rust helper :3001/:3002
launchctl kickstart -k "gui/$(id -u)/com.sci.agent"    # Node agent :8080
launchctl start dev.sci.bootstrap-identity              # trigger daily pipeline manually
tail -f ~/.sci/bootstrap-identity.log                   # watch pipeline
```

### Storage
- **identity_facts**: 409 rows, no embeddings yet (`embeddings_identity` empty)
- **episodic_memories**: ~43,532 rows
- **SQLite**: `~/.sci/memory/sci.db`

### Codebase conventions
- `packages/cli/` — `@sci/cli`. Add `status` and `verify` subcommands here for SCI-254.
- `packages/mcp/src/` — TypeScript; `npm run build` after edits. `dist/` is gitignored.
- `packages/core/dist/` + `packages/proxy/dist/` + `packages/agent/dist/` — **tracked** (compiled output committed).
- Rust helper: `cargo build --release` from `apps/sci-mac/SciHelper/` (~30s), then kickstart.

### Admin API (`:3002`)
`GET /sci/status` · `GET /sci/recall?query=&limit=` · `GET /sci/identity?query=&category=&limit=` · `POST /sci/memories` · `DELETE /sci/memories/:id` (episodic only)

### Auth
- **OAuth token**: `~/.sci/oauth.json` → `access_token`. Bearer auth only.
- **Console key** (`~/.sci/console-key.env`): no credits — don't use.
- **Agent token**: `~/.sci/agent.token` — control plane (`control.sci.sh`) auth.

### Jira cloud ID
`e04b7caa-9314-439b-9772-d2bf75440183` (caseyzandbergen.atlassian.net)
Done transition ID: `31`
