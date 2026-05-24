# Handoff

_Last updated: 2026-05-23 (evening) — SCI-240, SCI-241, SCI-242 all closed. No open backlog items._

## Goal

Sci is a sovereign cognitive identity layer. Data-plane HTTPS proxy anonymizes PII before AI traffic leaves the device, injects recalled memory, and syncs encrypted blobs via a control plane.

## Current Progress — All Done This Session

### SCI-240: memory_identity reads routed to Rust helper — DONE (`6d3ffb10`)

`memory_identity` now reads from the Rust helper via `GET /sci/identity?query=&category=&limit=`.
- **Rust**: new `list_identity` handler in `apps/sci-mac/SciHelper/src/admin.rs`. No query → `query_identity_facts()` by confidence. With query → recall(`types=[Identity]`).
- **TS**: `helperIdentity()` in `packages/mcp/src/helper.ts`; `packages/mcp/src/tools/identity.ts` drops adapter dependency.
- **Note**: MCP reads `memory_identity` correctly in next session (current MCP process loaded old dist at startup). Writes were already routed to helper.

### SCI-241: Agent sync scheduled + hnswlib crash fixed — DONE (`68c482a7`)

`packages/agent/dist/proxy-server.js` and `packages/agent/dist/storage-sqlite.js`:
1. **Sync schedule**: `adapter.sync()` on startup + `setInterval(5min)` + final sync in `closeAdapter()`.
2. **hnswlib crash fix**: `_sync()` called `this.index.getPoint()` on the dead hnswlib index → threw "Label not found". Fixed by setting `embedding = null` (vectors are in sqlite-vec; control plane re-embeds from content).
- **Verified**: 200 memories uploaded to `control.sci.sh` on restart; `lastSyncAt` updated.
- **Note**: No TypeScript source in `packages/agent/` — only `dist/`. Edits go directly to compiled JS.

### SCI-242: dist-bundle — closed won't-fix

`packages/agent/dist-bundle/` is a gitignored legacy v0.1.0 artifact. Launchd runs `node packages/agent/dist/index.js` directly. No build script exists.

### recall ranking quality — DONE (`9a554379`)

Content-length informativeness factor added to `core/crates/sci-memory/src/recall.rs`. Heading-only chunks (30 chars) now get ×0.42 score, 150+ char paragraphs get ×1.0. RRF replaced with raw adjusted score.

### memory_recall divergence — DONE (prior session, `88f848f2`)

MCP rerouted from empty hnswlib index → Rust helper's sqlite-vec store.

## What Worked

- `cargo build --release` from `apps/sci-mac/SciHelper/` (~30s) + `launchctl kickstart -k gui/$(id -u)/dev.sci.helper`
- `npm run build` from repo root recompiles all TS packages. `packages/mcp/dist/` is gitignored (rebuilt locally).
- Agent sync verified via `cat ~/.sci/sync.json` and absence of `~/.sci/pending-sync.ndjson`.

## What Didn't Work / Dead Ends

- **CLI sqlite3 can't touch vec stores** — `embeddings_episodic` is a `vec0` virtual table. All vector ops go through the Rust helper.
- **hnswlib index is orphaned** — `sci.idx` is dead. Left in place for profile reads + anonymize token_mappings.
- **`this.index.getPoint()` in `_sync()`** — always throws "Label not found". Fixed by setting `embedding = null`.
- **Rust compiler edition 2024**: `.as_str()` on `String` is unstable. Use `&*string` instead.

## No Open Items

Backlog is clear. Possible next work:
- Populate `identity_facts` by storing identity data via `memory_store_identity` (currently 1 test fact; no real profile built yet)
- Investigate recall ranking further for other query types
- Control plane: check if remaining ~35 memories (after the initial 200 upload) synced on the next 5-minute interval

## Context & Gotchas

### Storage
- **Sci memory** (recall/vectors/episodic): SQLite at `~/.sci/memory/sci.db` — ~43,330 episodic, embeddings in `embeddings_episodic` (sqlite-vec).
- **identity_facts**: 1 row ("Casey prefers concise, direct communication..."). Now read + written through Rust helper.
- **Sync state**: `~/.sci/sync.json` — `lastSyncAt: 2026-05-24T02:14:16Z`, `lastPullAt: 2026-05-22T22:40:12Z`.
- **sci-chat conversations/users**: MongoDB via in-process `mongodb-memory-server`, persisted to `apps/sci-chat/data/mongo/`.

### Starting services
```bash
launchctl kickstart -k "gui/$(id -u)/dev.sci.helper"   # restart Rust helper (proxy :3001 + admin :3002)
launchctl kickstart -k "gui/$(id -u)/com.sci.agent"    # restart Node agent (proxy :8080)
nc -z 127.0.0.1 3001 && nc -z 127.0.0.1 3002 && echo "helper up"
```

### Service state at handoff
| Service | Port | Status |
|---|---|---|
| `dev.sci.helper` (Rust proxy + admin) | :3001 / :3002 | ✅ running |
| `com.sci.agent` (Node proxy + sync) | :8080 | ✅ running (sync every 5min) |
| sci-chat backend | :3080 | unknown |
| Sci MCP | stdio | ✅ running — `memory_identity` uses old code; next session picks up new dist |

### Codebase conventions
- `packages/mcp/src/` — TypeScript; `npm run build` after edits. `packages/mcp/dist/` is **gitignored** (built locally).
- `packages/core/dist/` + `packages/proxy/dist/` — **tracked** (committed compiled output).
- `packages/agent/dist/` — **tracked** (no src/ directory; dist IS the source of truth).
- `core/crates/sci-memory/` — Rust storage crate. `apps/sci-mac/SciHelper/` — Rust helper. `target/` gitignored; rebuild + kickstart to deploy.

### Admin API endpoints (`:3002`)
`GET /sci/status` · `GET /sci/recall?query=&profile=&limit=` · `GET /sci/identity?query=&category=&limit=` · `GET|POST /sci/memories` · `DELETE /sci/memories/:id` · `GET /sci/audit_turns[/:id]` · `GET|POST /sci/profiles` · `GET|POST /sci/active_profile` · `GET /sci/events` (SSE)

### Sci MCP registration
User-scope entry in `~/.claude.json` (`sci`): node → `packages/mcp/dist/index.js`. Honors `SCI_HELPER_URL` (default `http://127.0.0.1:3002`). Do **not** add a project-scope `.mcp.json` entry (conflicts → connect failure).
