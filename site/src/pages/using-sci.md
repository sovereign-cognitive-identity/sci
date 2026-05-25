---
layout: ../layouts/Base.astro
title: Using Sci
description: How to use Sci day-to-day — what happens automatically, checking status, and asking Claude to recall or store memory.
---

# Using Sci

Once installed, most of what Sci does is invisible — the proxy runs in the background and memory flows automatically. You keep using Claude Code exactly as before. Below is what's happening underneath, and the few things worth doing deliberately.

## Your first session, end to end

1. Open a **new** terminal (so the proxy environment is inherited) and run `claude` in any project.
2. Work normally. Behind the scenes, every request is routed through Sci, anonymized, and the reply de-anonymized — you won't notice a thing except, on the very first request, a brief pause while the embedding model downloads.
3. Tell Claude something worth keeping: *"Remember we're standardizing on Vitest for this repo."*
4. Tomorrow, open a session in a **different** directory and ask: *"What testing framework are we using?"* The answer is already there. That's memory injection — the moment it becomes visible.

## What happens automatically

Every time you run `claude` in a terminal:

1. **Proxy intercepts the session.** Claude Code's `HTTPS_PROXY` is set to `http://127.0.0.1:3001`, so all requests route through Sci before reaching Anthropic.
2. **PII is anonymized outbound** and **restored inbound** — you never see the substitution.
3. **Memory tools are available** to Claude over MCP: `memory_recall`, `memory_store`, `memory_identity`, `memory_status`.

You don't need to do anything for this to work.

## Confirming it's active

```bash
sci status     # ok: true, plus memory counts
sci verify     # live before/after privacy check
```

## Asking Claude to recall context

Claude won't call memory tools unless instructed. At the start of a session, ask:

> "Check what you know about me and my active projects."

For automatic recall on every session, add this to `~/.claude/CLAUDE.md`:

```markdown
## Memory
At the start of each session, call `memory_recall` with a query relevant
to the current task, and `memory_identity` with no arguments.
```

## Storing memories

Ask Claude directly:

> "Remember that we chose SQLite over Postgres for the alpha."

Claude calls `memory_store`; the memory is embedded locally and persisted.

## Seeding from past conversations

```bash
# Export from claude.ai → Settings → Privacy → Export Data
sci import --claude ~/Downloads/conversations.json
```

## The four MCP tools

| Tool | Ask Claude to… | Use when |
|------|----------------|----------|
| `memory_recall` | "Search your memory for X" | Retrieving past decisions, context |
| `memory_store` | "Remember that X" | Capturing a decision or insight |
| `memory_identity` | "What do you know about me?" | Loading your profile and projects |
| `memory_status` | "Check memory status" | Verifying the system is healthy |

---

See [What to test](/what-to-test) for the specific things we'd love feedback on.
