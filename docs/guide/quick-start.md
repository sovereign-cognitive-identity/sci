# Quick Start

Get Sci running and connected to Claude Code in under 5 minutes.

## Prerequisites

- Docker Desktop
- Node.js 18+
- Claude Code (or any MCP-compatible agent)

## Install

```bash
git clone https://github.com/sovereign-cognitive-identity/sci
cd sci
npm install
```

## Start the database

```bash
docker compose up -d
```

This starts Postgres 16 with pgvector. The schema is applied automatically on first run.

## Build

```bash
npm run build
```

## First-run setup

```bash
sci setup
```

This runs a 4-step wizard:
1. Verifies the database connection
2. Checks the schema
3. Shows current memory counts
4. Generates a trusted token for Claude Code

Copy the `claude mcp add` command it outputs and run it.

## Restart Claude Code

After running `claude mcp add`, restart Claude Code. The `sci` MCP server will be available with four tools:

- `memory_recall` — semantic search across all memory
- `memory_store` — store a new episodic memory
- `memory_identity` — retrieve your identity facts
- `memory_status` — health check

## Seed your memory (optional but recommended)

Export your Claude conversation history from [claude.ai/settings/account](https://claude.ai/settings/account) → Privacy → Export Data.

Then:
```bash
sci import --claude ~/Downloads/conversations.json
```

This seeds episodic memories and runs identity extraction, so Sci immediately knows your projects, preferences, and context.

## Verify the privacy guarantee

Before trusting Sci with real conversations, run:

```bash
node demo/privacy-demo.mjs
```

This proves in under 10 seconds that your real name never appears in outbound text. All 6 checks must pass.

## What's next

- [Connect additional agents](/guide/connecting-agents) — scope Cursor to your work profile, give a third-party agent read-only access
- [Choose a storage backend](/guide/storage) — move your data to Dropbox, S3, or iCloud
- [Set up nightly consolidation](/guide/consolidation) — let Sci learn from your conversations automatically
