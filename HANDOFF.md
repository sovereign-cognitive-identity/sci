# Handoff

_Last updated: 2026-05-23 (evening) — recall dedup, identity pipeline (354 facts), and 4 sync bugs fixed. 3 commits ahead of origin._

## Goal

Sci is a sovereign cognitive identity layer. Data-plane HTTPS proxy anonymizes PII before AI traffic leaves the device, injects recalled memory, and syncs encrypted blobs via a control plane.

## Current Progress

### `27848df7` — Recall content-fingerprint dedup
`core/crates/sci-memory/src/recall.rs`: added a second dedup pass after ID-dedup. Key: first 200 chars of trimmed content. Eliminates the flood of identical chunks that appeared verbatim across 40+ turn groups. Rust helper rebuilt + restarted.

### `8668accd` — Identity facts pipeline (Phase A + B)

**Phase A — `scripts/bootstrap-identity.py`**
- Stdlib only (no deps), auth via OAuth Bearer from `~/.sci/oauth.json`
- Loads ~1300 distinct user-role chunks from episodic_memories (noise-filtered)
- Batches to Claude Haiku (27 × 50 chunks), extracts preference/skill/value/relationship/background facts
- Token-overlap Jaccard > 0.7 → skip duplicates; POST new facts to helper `POST /sci/memories?kind=identity`
- **First run: 354 facts stored** (was 1). Re-runnable safely.

**Phase B — session-end hook in `packages/agent/dist/proxy-server.js`**
- `extractIdentityFacts()` added; called in `closeAdapter()` before sync/disconnect
- 30s hard cap so shutdown never hangs
- Uses `getAccessTokenSafe()` (same OAuth path as proxied calls)
- Fetches last 100 episodic user-role chunks, Claude Haiku extraction, token-overlap conflict check, POSTs new facts

Research basis: TraceMem (arxiv 2602.09712) distillation step + Mem0 CRUD pattern.

### `12c62575` — 4 sync bugs fixed in `packages/agent/dist/storage-sqlite.js`

| Bug | Fix |
|---|---|
| Cursor used `occurred_at` (historical) instead of `created_at` | Changed to `record.created_at` always |
| `identity_facts` SELECT didn't include `created_at` | Added to all 3 SELECTs |
| Truncated batch (>200) still advanced cursor to `now` → remaining items permanently lost | Only advance to `now` when `toUpload.length <= BATCH_LIMIT` |
| SQLite UTC string `'2026-05-24 02:57:37'` parsed as local time by JS (+5h) | Append `'Z'` before `new Date()` |

All 354 identity facts confirmed synced to `control.sci.sh`.

## What Worked

- `cargo build --release` from `apps/sci-mac/SciHelper/` (~30s) + `launchctl kickstart -k gui/$(id -u)/dev.sci.helper`
- `launchctl kickstart -k "gui/$(id -u)/com.sci.agent"` to restart Node agent
- OAuth Bearer auth for direct Anthropic API calls: read `~/.sci/oauth.json` → `access_token`, pass as `Authorization: Bearer <token>` with `anthropic-beta: claude-code-20250219`
- Claude Haiku (`claude-haiku-4-5-20251001`) for batch extraction — fast, cheap, good quality
- Content fingerprint dedup (`first 200 chars`) collapses near-duplicates without semantic similarity

## What Didn't Work

- **Console key (`~/.sci/console-key.env`)** — `ANTHROPIC_CONSOLE_KEY` has no credits. Use OAuth token from `~/.sci/oauth.json` instead.
- **httpx proxy for Python** — `httpx.HTTPTransport(proxy=...)` + Sci CA cert fails SSL tunnel verification. Use direct API + OAuth Bearer instead.
- **`new Date(sqliteTimestamp)` without `'Z'`** — parses as local time on CDT machines, adds +5h offset. Always append `'Z'`.
- **`str.format()` on LLM prompt containing JSON chunks** — chunks contain `{` and `}` → `KeyError`. Use `str.replace('{chunks}', joined)` instead.

## Next Steps

1. **Push to origin** — 3 commits ahead: `git push`
2. **Identity facts quality review** — 354 facts likely has semantic overlap (multiple facts saying similar things). Consider a dedup pass: embed all facts → cluster by cosine similarity → LLM merge near-duplicates.
3. **Bootstrap script as periodic job** — run `scripts/bootstrap-identity.py` on a schedule (weekly?) to keep identity_facts current as new episodic memories accumulate.
4. **Investigate `identity_facts` confidence distribution** — `GET http://127.0.0.1:3002/sci/identity?limit=100` — are confidence scores well-spread or all clustering at 0.8?

## Context & Gotchas

### Storage
- **Sci memory** (episodic/vectors): SQLite at `~/.sci/memory/sci.db` — ~43,331 episodic, embeddings in `embeddings_episodic` (sqlite-vec)
- **identity_facts**: 355 rows (1 original + 354 bootstrapped). Read + written through Rust helper.
- **Sync state**: `~/.sci/sync.json` — `lastSyncAt` is UTC ISO; all 354 identity facts confirmed synced.

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
| `com.sci.agent` (Node proxy + sync) | :8080 | ✅ running (sync bugs fixed) |
| Sci MCP | stdio | ✅ running |

### Codebase conventions
- `packages/mcp/src/` — TypeScript; `npm run build` after edits. `packages/mcp/dist/` is **gitignored** (built locally).
- `packages/core/dist/` + `packages/proxy/dist/` — **tracked** (committed compiled output).
- `packages/agent/dist/` — **tracked** (no src/ directory; dist IS the source of truth).
- `core/crates/sci-memory/` — Rust storage crate. `apps/sci-mac/SciHelper/` — Rust helper. Rebuild + kickstart to deploy.

### Admin API endpoints (`:3002`)
`GET /sci/status` · `GET /sci/recall?query=&profile=&limit=` · `GET /sci/identity?query=&category=&limit=` · `POST /sci/memories` (`{content, kind: "episodic"|"identity", category, confidence}`) · `DELETE /sci/memories/:id` · `GET /sci/audit_turns` · `GET /sci/events` (SSE)

### Sci MCP registration
User-scope entry in `~/.claude.json` (`sci`): node → `packages/mcp/dist/index.js`. Do **not** add a project-scope `.mcp.json` entry (conflicts → connect failure).

### Auth
- **OAuth token**: `~/.sci/oauth.json` → `access_token`. Header: `Authorization: Bearer <token>`, `anthropic-beta: claude-code-20250219`.
- **Console key** (`~/.sci/console-key.env`): no credits — don't use for API calls.
- **Agent token**: `~/.sci/agent.token` — for control plane (`control.sci.sh`) auth.
