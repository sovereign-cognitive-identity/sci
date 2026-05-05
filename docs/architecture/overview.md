# Architecture Overview

Sci is built in three packages:

```
@sci/core   — storage adapters, embeddings, anonymizer, consolidation
@sci/mcp    — MCP server, tool implementations, auth middleware
@sci/cli    — sci CLI (status, import, connect, backup, etc.)
```

## System topology

```
┌─────────────────────────────────────────────┐
│  AI Clients (Claude Code, Cursor, Copilot)  │
│            ↕ MCP stdio transport            │
├─────────────────────────────────────────────┤
│  @sci/mcp — MCP Server                      │
│  ┌──────────────────────────────────────┐   │
│  │  Auth middleware (tier enforcement)  │   │
│  │  8 tools: memory_*, message_*, ...   │   │
│  └────────────────┬─────────────────────┘   │
├───────────────────┼─────────────────────────┤
│  @sci/core        │                         │
│  ┌────────────────▼─────────────────────┐   │
│  │  StorageAdapter (abstract interface) │   │
│  │    LocalAdapter  → Postgres+pgvector │   │
│  │    DropboxAdapter→ SQLite+hnswlib    │   │
│  │    S3Adapter     → SQLite+hnswlib    │   │
│  │    iCloudAdapter → SQLite+hnswlib    │   │
│  └──────────────────────────────────────┘   │
│  BGE-base-en embeddings (local, no API)     │
│  Anonymizer (NER + token substitution)      │
└─────────────────────────────────────────────┘
```

## Data flow on a `memory_recall` call

1. Agent calls `memory_recall` via MCP stdio
2. Auth middleware validates token, resolves profile scope
3. `embed(query)` runs locally — BGE-base-en, no external call
4. Dense search + tsvector full-text search fire in parallel against the storage backend
5. RRF (Reciprocal Rank Fusion, k=60) merges ranked lists
6. Top-N results returned

## Data flow on `message_anonymize`

1. Agent calls `message_anonymize` with user message
2. NER pipeline runs (4 layers: regex → compromise NLP → identity_facts custom entities → CamelCase)
3. Token map built in process memory only
4. Anonymized text returned with session_id
5. Agent sends anonymized text to AI provider
6. Agent calls `message_deanonymize` with response + session_id
7. Token map applied to response, then discarded

The token map is **never written to disk, DB, or network.**

## Write safety

The `Augmentor` / `StorageAdapter.storeEpisodic()` is the only write path. Two Postgres roles:
- `db_reader` — SELECT only, used for all reads
- `db_writer` — INSERT/UPDATE on specific tables, used for all writes

No DELETE is granted to either role in the default schema.

## Nightly consolidation flow

See [Nightly Consolidation guide](/guide/consolidation) for the user-facing view.

Technical sequence:
1. `runPromotionPass()` — LLM batches over episodic memories → `adapter.storeSemantic()` or `adapter.reinforceSemantic()`
2. `runDecayPass()` — Ebbinghaus formula → `adapter.updateDecayScore()`
3. `runGraphPass()` — LLM finds relationships → `adapter.insertSemanticEdge()`
4. `runDigestPass()` — LLM summarizes day → `adapter.storeEpisodic()` + vault export
5. `adapter.recordConsolidationRun()` — audit trail

All four jobs use `StorageAdapter` — they work with any backend, not just Postgres.
