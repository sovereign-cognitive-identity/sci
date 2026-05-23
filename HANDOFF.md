# Handoff

_Last updated: 2026-05-23 (pm) — Fixed memory_recall returning empty: converged MCP onto the Rust helper's sqlite-vec store (Option A)_

---

## Latest session: memory_recall divergence fix

**Root cause:** Two divergent vector stores on one `sci.db`. The MCP (`@sci/core` `CloudAdapter`) read an **hnswlib** index (`sci.idx`, 96-byte empty file, ~308 stale `vector_map` entries) while the live **42,998** embeddings live in the Rust helper's **sqlite-vec** table (`embeddings_episodic`). MCP `memory_recall` → `_searchIndex` (empty hnswlib) → `[]`.

**Fix (Option A — converge on the Rust helper as single source of truth):**
- **Rust:** added `POST /sci/memories` to `apps/sci-mac/SciHelper/src/admin.rs` — embeds via `handler_state.embedder`, stores via `store_episodic` (default) or `store_identity_fact` (`kind:"identity"`). Auto-creates profile by name. Rebuilt + reloaded `dev.sci.helper`.
- **MCP:** new `packages/mcp/src/helper.ts` HTTP client (`SCI_HELPER_URL`, default `http://127.0.0.1:3002`). Rerouted `recall.ts`, `store.ts`, `status.ts`, `store-identity.ts` to the helper. Updated `index.ts` call sites (pass profile **name**, not id — Rust resolves/creates by name). `memory_identity` (read) left on the adapter — identity_facts is empty so it's not broken; the broken hnswlib branch only matters once identity facts exist.

**Verified** (via rebuilt `dist/` against live helper): `memory_status` → 42,999 embeddings (was 308); `memory_recall` employment query returns real hits (was `[]`); `memory_store` round-trips and is instantly recallable.

**⚠️ Requires fresh Claude session** — the MCP server process in the session that made this fix still runs old code. New session reloads `dist/`.

**Also added:** `DELETE /sci/memories/:id` (admin.rs) + `LocalAdapter::delete_episodic` (sci-memory crate) — removes episodic row + vec0 vector (vec0 `memory_id` is auxiliary/non-filterable, so it deletes by `rowid` found via scan). Used it to clean the two smoke-test rows; verified counts dropped and re-delete 404s.

**Cleanup / follow-ups:**
- **Open: recall ranking quality** — recall surfaces near-identical stored *questions* over *answers*, all at RRF floor (~0.0164). Separate from the divergence bug. Investigate `recall.rs` scoring in `core/crates/sci-memory`.
- Changed files (uncommitted): `apps/sci-mac/SciHelper/src/admin.rs`, `core/crates/sci-memory/src/adapter.rs`, `packages/mcp/src/{helper.ts,index.ts,tools/{recall,store,status,store-identity}.ts}` + rebuilt `dist/` + Rust binary.

---

## Goal

Sci is a sovereign cognitive identity layer. Data-plane HTTPS proxy anonymizes PII before AI traffic leaves the device, injects recalled memory, and syncs encrypted blobs via a control plane.

**Current focus:** sci-chat — LibreChat fork wired through the sci proxy. Inspector sidebar showing live turn data.

---

## Current Progress

### Completed this session

- **SCI-239 ✅** — Rebuilt Rust helper binary (`cargo build --release` in `apps/sci-mac/SciHelper/`)
  - The `mark_cache_control` / `strip_message_cache_controls` fix was already in source (commits b4d6419c + 7b92f829) — binary was just stale
  - `:3001` proxy verified working (no 400s), `:3002` admin API up with live audit turns
  - `bin/sci-claude` and `apps/sci-chat/.env` flipped back from `:8080` to `:3001`
  - `NODE_EXTRA_CA_CERTS` in sci-chat `.env` updated to `ca-bundle.crt` (both CAs)

- **SCI-151 ✅ (frontend)** — Inspector components wired and TS-clean
  - `App.jsx` already had `InspectorContext.Provider` + `<SciInspectorPanel />` mounted — only blocker was `:3002` being down
  - Fixed 8 TS errors in `ProfileSelector.tsx`, `ProjectSelector.tsx`, `RecallPreview.tsx`:
    - `.error &&` → `.isError &&` (TanStack Query v4: `error` is `unknown`, not usable as JSX boolean)
    - `.isPending` → `.isLoading` (`.isPending` is TQ v5 API)
  - Admin API returning real data: 43,299 episodic memories, 9,296 audit turns

- **Sci MCP fixed** — Removed conflicting project-scope definition from `.mcp.json`
  - Was: user-scope (full path + env vars) + project-scope (relative path, no env vars) → conflict caused connect failure
  - Now: user-scope only. Needs fresh Claude session to reconnect.

- **Decided: skip Postgres→SQLite migration** — Docker VM disk exists (460GB, May 22) but risks (duplicates, pre-SCI-194 garbage, embedding format mismatch, stale context) outweigh value. SQLite already has 43k high-quality proxy-agent memories.

### Storage (unchanged)

- **Sci memory** (recall, vectors, episodic): **SQLite** at `~/.sci/memory/sci.db` — 43,299 episodic
- **sci-chat conversations/users**: **MongoDB** in-process via `mongodb-memory-server`, persisted to `apps/sci-chat/data/mongo/`

---

## What Worked

- `cargo build --release` from `apps/sci-mac/SciHelper/` — takes ~30s, binary goes to `target/release/sci-helper`
- `launchctl load ~/Library/LaunchAgents/dev.sci.helper.plist` — starts helper after rebuild
- `bash scripts/sci-up.sh` — comprehensive health check including live `:3001` test
- `curl -s http://127.0.0.1:3002/sci/status` — quick admin API health check
- TanStack Query v4: use `.isError` (boolean) not `.error` (unknown) for JSX boolean guards; use `.isLoading` not `.isPending` for mutations

---

## What Didn't Work

- **Project-scope `.mcp.json` sci entry** — had relative path `node packages/mcp/dist/index.js` without env vars → `SCI_DB_READER_URL` missing → connect failure. Fixed by removing project-scope entry.
- **Root.tsx as InspectorPanel mount** — unnecessary; `App.jsx` already mounts it above the RouterProvider. Don't add it again.

---

## Next Steps

1. **Start fresh Claude session** → Sci MCP will connect (`memory_recall`, `memory_store` etc. available)
2. **Smoke-test inspector** — start sci-chat frontend (`npm run frontend:dev` in `apps/sci-chat`), hit `http://localhost:3091`, click 🔒 Sci button → should show live turns from `:3002`
3. **Pending-sync retry** — drain `~/.sci/pending-sync.ndjson` at top of `_sync()` in `packages/agent/dist/storage-sqlite.js`
4. **Bun binary rebuild** — `dist-bundle/` is stale vs `dist/`
5. **SCI-239 Rust flip for sci-claude** — already done; monitor for any cache_control regressions

---

## Context & Gotchas

### Starting services

```bash
# Rust helper (launchd):
launchctl load ~/Library/LaunchAgents/dev.sci.helper.plist   # if not loaded
nc -z 127.0.0.1 3001 && echo "proxy up" && nc -z 127.0.0.1 3002 && echo "admin up"

# Node agent (launchd, fallback):
launchctl load ~/Library/LaunchAgents/com.sci.agent.plist

# sci-chat (manual):
cd apps/sci-chat && npm run dev          # backend :3080
npm run frontend:dev                     # frontend :3090 (or :3091 if taken)

# Health:
bash scripts/sci-up.sh
```

### Service state at handoff

| Service | Port | Status |
|---|---|---|
| `dev.sci.helper` (Rust proxy) | :3001 | ✅ running (launchd) |
| `dev.sci.helper` (admin API) | :3002 | ✅ running (same process) |
| `com.sci.agent` (Node proxy) | :8080 | ✅ running (launchd) |
| sci-chat backend | :3080 | ✅ running (manual) |
| sci-chat frontend | :3090/:3091 | ❌ not running |
| Sci MCP | stdio | ❌ needs fresh session |

### Codebase conventions

- `packages/agent/dist/` — **compiled JS, no TS source**. Edit `.js` directly.
- `packages/mcp/src/` and `packages/core/src/` — TypeScript; run `npm run build` after edits.
- `apps/sci-chat/packages/api/src/` — TypeScript; all new backend code goes here.
- `apps/sci-chat/.env` — gitignored; proxy is `HTTPS_PROXY=http://127.0.0.1:3001`.

### Key files

| Path | Purpose |
|---|---|
| `apps/sci-mac/SciHelper/` | Rust helper source — `cargo build --release` to rebuild |
| `apps/sci-mac/SciHelper/src/admin.rs` | Admin API on :3002 — all `/sci/*` endpoints |
| `packages/agent/dist/proxy-server.js` | Node proxy — OAuth injection, handler dispatch |
| `apps/sci-chat/client/src/App.jsx` | Inspector mounted here (InspectorContext.Provider + SciInspectorPanel) |
| `apps/sci-chat/client/src/components/Sci/` | All inspector components |
| `apps/sci-chat/client/src/components/Sci/api.ts` | Hits `http://127.0.0.1:3002` |
| `bin/sci-claude` | Launch Claude Code through Rust proxy |

### Sci MCP registration

User-scope entry in `~/.claude.json` (correct):
```json
"sci": {
  "type": "stdio",
  "command": "/opt/homebrew/Cellar/node/26.0.0/bin/node",
  "args": ["/Users/caseyzandbergen/src/cognitive-os/sci/packages/mcp/dist/index.js"],
  "env": {
    "SCI_STORAGE_BACKEND": "sqlite",
    "SCI_LOCAL_DIR": "/Users/caseyzandbergen/.sci/memory",
    "SCI_CONFIG_DIR": "/Users/caseyzandbergen/.sci",
    "SCI_FASTEMBED_CACHE_DIR": "/Users/caseyzandbergen/.sci/fastembed",
    "HOME": "/Users/caseyzandbergen"
  }
}
```
Project-scope entry in `.mcp.json` removed (was conflicting). If it comes back, remove it again with `claude mcp remove sci -s project`.
