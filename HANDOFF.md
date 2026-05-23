# Handoff

_Last updated: 2026-05-23 — SCI-150 shipped; sci-chat round-trip verified; SCI-151 (sidebar) is next_

---

## Goal

Sci is a sovereign cognitive identity layer. Data-plane HTTPS proxy anonymizes PII before AI traffic leaves the device, injects recalled memory, and syncs encrypted blobs via a control plane.

**Current focus:** sci-chat — LibreChat fork wired through the sci proxy.

---

## Current Progress

### Completed this session

- **SCI-150 ✅** — first real end-to-end chat round-trip verified:
  - `🔒 masked 2: [URL_1]←"openclaw.dev"  [PERSON_1]←"Casey"`
  - `🧠 injected 1 memory context items (~92 tokens)`
  - `→ api.anthropic.com` → `✓ complete in 1114ms, storing to memory`
- Committed fix `cd420904`: when the proxy injects OAuth Bearer for sci-chat's sentinel key (`sci_t_chat_local`), it now also deletes `x-api-key` — Anthropic was rejecting on the stale sentinel key even though a valid Bearer was present.

### Storage clarification (asked this session)

- **Sci memory layer** (recall, vectors, episodic): **SQLite** at `~/.sci/memory/sci.db` — 43k memories
- **sci-chat conversations/users**: **MongoDB** in-process via `mongodb-memory-server`, persisted to `apps/sci-chat/data/mongo/` (wiredTiger, survives restarts)
- No Postgres anywhere — was dropped in SCI-225

---

## What Worked

- Node agent (`com.sci.agent`, `:8080`) handles OAuth fallthrough cleanly — use this, not the Rust helper
- sci-chat API: `POST /api/agents/chat/anthropic` + `GET /api/agents/chat/stream/:streamId` (SSE)
- Browser UA header required (`User-Agent: Mozilla/5.0...`) — `uaParser` middleware rejects curl without it
- Login: `sci@local.host` / `sci-chat-dev` (original seed user — NOT Casey's email even though .env has it)

---

## What Didn't Work

- **Rust helper (`:3001`)** — cache_control ordering bug (SCI-239); both sci-claude and sci-chat now route to `:8080` instead
- **`/api/ask/anthropic`** — doesn't exist in LibreChat v0.8.5; correct endpoint is `/api/agents/chat/:endpoint`
- **`conversationId: null`** — pass `"new"` for first message, not null

---

## Next Steps

1. **SCI-151 — Sci sidebar** in sci-chat (highest value; makes anonymization visible)
   - Start in `apps/sci-chat/client/src/components/Sci/` — scaffolding already exists (`types.ts`, `hooks.ts`, `ProfileSelector.tsx`)
   - The proxy emits SSE events that ride inside LibreChat's existing stream:
     - `event: sci.anonymized` → `{reqId, masked: [{token, original}]}`
     - `event: sci.memory` → `{reqId, items: [{score, text}]}`
     - `event: sci.deanonymized` → `{reqId, tokensReplaced, replaced}`
   - Look at `apps/sci-chat/client/src/components/Chat/ContextBar.tsx` for the EventSource pattern
   - Right-panel card per turn: entities masked, memory recalled, latency

2. **SCI-239** — root-cause the Rust helper's `cache_control` bug (lower priority while `:8080` is the workaround)

3. **Pending-sync retry** — drain `~/.sci/pending-sync.ndjson` at top of `_sync()` in `packages/agent/dist/storage-sqlite.js`

4. **Bun binary rebuild** — `dist-bundle/` is stale vs `dist/`

---

## Context & Gotchas

### Starting services

```bash
# Proxy (launchd; auto-restarts):
launchctl load ~/Library/LaunchAgents/com.sci.agent.plist   # if not loaded
nc -z 127.0.0.1 8080 && echo up                            # verify

# sci-chat (manual; dies when terminal closes):
cd apps/sci-chat && npm run dev
# Backend :3080, frontend :3090

# Health:
bash scripts/sci-up.sh

# Watch proxy:
tail -f ~/.sci/sci.log | grep -E "🔒|🧠|✓|error"
```

### Service state at handoff

| Service | Port | Status |
|---|---|---|
| `com.sci.agent` (Node proxy) | :8080 | ✅ running (launchd) |
| `dev.sci.helper` (Rust proxy) | :3001 | ❌ down (SCI-239 bug) |
| sci-chat backend | :3080 | ✅ running (manual) |
| sci-chat frontend | :3090 | ❌ not running |
| MCP sci server | — | ⚠️ check sidebar |

### Codebase conventions

- `packages/agent/dist/` and `packages/control/dist/` — **compiled JS, no TS source**. Edit `.js` directly.
- `packages/mcp/src/` and `packages/core/src/` — TypeScript; run `npm run build` after edits.
- `apps/sci-chat/packages/api/src/` — TypeScript; all new backend code goes here.
- `apps/sci-chat/.env` — gitignored; proxy port is `HTTPS_PROXY=http://127.0.0.1:8080` (was fixed from 3001 this session).

### Key files

| Path | Purpose |
|---|---|
| `packages/agent/dist/proxy-server.js` | Proxy core — OAuth injection, handler dispatch |
| `packages/proxy/dist/handlers/anthropic.js` | Anonymize → Anthropic → deanonymize |
| `apps/sci-chat/sci-bootstrap.js` | MongoDB, undici proxy setup, user seed |
| `apps/sci-chat/client/src/components/Sci/` | **SCI-151 target** — sidebar scaffold |
| `apps/sci-chat/client/src/components/Chat/ContextBar.tsx` | EventSource pattern to copy |
| `apps/sci-chat/NIGHT.md` | Night-build report — good background on sci-chat architecture |
