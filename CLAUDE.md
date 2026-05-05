# Sci — Memory Layer

This project has a live memory MCP server (`sci`) connected. Use it.

## On every session start

Call `memory_identity` with no arguments to load Casey's context before doing anything else:
- Preferences, stack choices, active projects, values
- Use this to avoid asking questions already answered

Then call `memory_recall` with a query relevant to the current task:
- "what decisions have been made about [topic]?"
- "what is the current state of [component]?"

## During work

Call `memory_store` when:
- A significant architectural decision is made
- A new approach or pattern is adopted
- Something was tried and failed (store the failure with context)
- A non-obvious constraint or tradeoff is discovered

Keep stored memories concise and factual. One memory per decision. Include the *why*, not just the *what*.

**Example:**
```
memory_store: "Chose BGE-base-en-v1.5 over Voyage AI as default embedding model. 
Reason: sovereignty by default — no per-query data exposure. Voyage AI available 
as Pro tier upgrade."
```

## At session end

Before stopping, store a brief session summary:
```
memory_store: "Session [date]: [what was built/decided]. Next: [what comes next]."
```

## About Sci itself

Sci is a sovereign cognitive identity layer — a TypeScript monorepo at `/Users/caseyzandbergen/src/cognitive-os/sci`.

**Packages:**
- `@sci/core` — db (Postgres + pgvector), embeddings (BGE-base-en-v1.5), Augmentor (write controller)
- `@sci/mcp` — stdio MCP server with four tools: `memory_recall`, `memory_store`, `memory_identity`, `memory_status`
- `@sci/cli` — `sci status`, `sci import --claude <file>`

**Build:** `npm run build` from `/sci`
**DB:** Docker on localhost:5432, `sci` database
**MCP:** Registered globally as `sci` in Claude Code

**Current status:** Phase 0–2 complete. Phase 3 (anonymization) in progress.

## Memory tool reference

| Tool | When to use |
|---|---|
| `memory_recall` | Any time context about past decisions, preferences, or project state would help |
| `memory_store` | After any significant decision, discovery, or session work |
| `memory_identity` | At session start, or when needing to understand Casey's preferences/context |
| `memory_status` | To check DB health and memory counts |
