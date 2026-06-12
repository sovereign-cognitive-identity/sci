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

Sci is a sovereign cognitive identity layer — a TypeScript monorepo (packages in `packages/`, Rust core in `core/`, macOS app in `apps/sci-mac/`). Embeddings default to BGE-base-en-v1.5 (sovereignty by default — no per-query data exposure).

The `sci` MCP exposes four tools: `memory_recall`, `memory_store`, `memory_identity`, `memory_status`.
