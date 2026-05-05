# Sci — Architecture

## The three layers

```
┌─────────────────────────────────────────────┐
│  AI Clients (Claude Code, Cursor, Copilot)  │
│            ↕ MCP stdio transport            │
├─────────────────────────────────────────────┤
│  Sci MCP Server  (packages/mcp)             │
│  ┌─────────────────────────────────────┐    │
│  │ Auth middleware (tier enforcement)  │    │
│  │ memory_recall / memory_store        │    │
│  │ memory_identity / memory_status     │    │
│  │ message_anonymize / deanonymize     │    │
│  │ session_inspect / route_query       │    │
│  └──────────────┬──────────────────────┘    │
├─────────────────┼───────────────────────────┤
│  @sci/core      │                           │
│  ┌──────────────▼──────────────────────┐    │
│  │ StorageAdapter (abstract)           │    │
│  │   LocalAdapter  → Postgres+pgvector │    │
│  │   DropboxAdapter→ SQLite+hnswlib    │    │
│  │   S3Adapter     → SQLite+hnswlib    │    │
│  │   iCloudAdapter → SQLite+hnswlib    │    │
│  └─────────────────────────────────────┘    │
│  Embeddings (BGE-base-en-v1.5, local)       │
│  Anonymizer (NER + token substitution)      │
│  Augmentor (write controller, db_writer)    │
└─────────────────────────────────────────────┘
```

## Memory architecture

Three layers, modeled on cognitive science:

| Layer | Scope | Lifecycle | What lives here |
|---|---|---|---|
| **Episodic** | Profile-scoped | Accumulates forever | Raw timestamped events, conversation fragments, decisions |
| **Semantic** | Profile-scoped | Promoted from episodic, Ebbinghaus decay | Durable facts, preferences, project context |
| **Identity** | Global (all profiles) | Stable, confidence-weighted | Who you are: values, skills, relationships |

Nightly consolidation moves signal from episodic → semantic. Decay ensures stale facts fade.

## The anonymization pipeline

```
User message
  → NER entity extraction (compromise.js + custom entities from identity_facts)
  → Token substitution ([PERSON_1], [EMAIL_2], [URL_3], ...)
  → Session entity feedback (entities seen earlier this session)
  → Memory context injection (relevant semantic nodes)
  → Model API call  ← provider sees this, never the original
  → Response deanonymization (token map applied in-memory)
  → Interaction stored raw (pre-anonymization)
  → Token map discarded
```

The token map lives in process memory only. Never written to disk, DB, or network. Session-scoped: when the MCP server process dies, the maps are gone.

**Progressive promotion:** entities that appear in 3+ separate calls are automatically promoted to `identity_facts` so they're caught in future sessions.

## Hybrid retrieval

Every recall query runs two searches in parallel:

1. **Dense (pgvector cosine)** — finds semantically similar content even when exact words differ
2. **Full-text (tsvector + plainto_tsquery)** — exact keyword matching with stemming

Results are merged with **Reciprocal Rank Fusion** (k=60):
```
score(doc) = 1/(rank_dense + 60) + 1/(rank_fts + 60)
```

Dense alone misses exact identifiers. FTS alone misses semantic similarity. RRF gets both.

## Embeddings

The embeddings table is keyed `(memory_type, memory_id, model_id)`. This enables model rollout without migration windows — add rows for a new model alongside old ones, roll out gradually, clean up when done.

Default: `BAAI/bge-base-en-v1.5` (768-dim, runs locally via FastEmbed — no API call, no data exposure).

## Auth model

Three tiers, enforced at the MCP tool level:

| Tier | Token prefix | memory_recall | memory_store | memory_identity | anonymize |
|---|---|---|---|---|---|
| trusted | `sci_t_` | ✓ all profiles | ✓ | ✓ | ✓ |
| standard | `sci_s_` | ✓ own profile | ✓ own profile | ✗ | ✓ |
| public | `sci_p_` | ✓ read-only | ✗ | ✓ preferences | ✗ |

Tokens are 32-byte random hex strings. Only SHA-256 hashes are stored. Plaintext shown once at `sci connect` time.

## Write safety

The `Augmentor` is the only component with `db_writer` access. All other reads use `db_reader`. Neither role has DELETE — soft deletion via metadata where needed. Every write is recorded to `write_queue` as an audit trail.

## Storage backends

Cloud backends use two files:
- `sci.db` — SQLite database (all relational data)
- `sci.idx` — hnswlib HNSW index (vector embeddings)

On `adapter.sync()`, these files are uploaded to the user's chosen cloud. On `adapter.connect()`, the remote is downloaded if it's newer than the local copy. The user controls the storage — Sci never has credentials.

## Nightly consolidation

Runs at 3am via cron. Four jobs in sequence:

1. **Promotion** — batch episodic memories through an LLM, extract durable facts, dedup against existing semantic nodes by embedding similarity (threshold 0.88)
2. **Decay** — Ebbinghaus formula: `score = confidence × e^(−t/S)`, stability S = 1 + access_count × 0.5
3. **Graph** — LLM finds relationships between high-confidence semantic nodes, writes to `semantic_edges`
4. **Digest** — brief daily summary stored as episodic memory + exported to Obsidian vault

## Package structure

```
sci/
├── packages/
│   ├── core/          @sci/core — shared: db, embeddings, anonymizer, augmentor, storage adapters
│   ├── mcp/           @sci/mcp  — stdio MCP server, tool implementations, auth middleware
│   └── cli/           @sci/cli  — sci CLI (status, import, connect, backup, etc.)
├── db/
│   └── init.sql       complete schema — applied automatically on docker compose up
├── demo/
│   └── privacy-demo.mjs   runnable privacy proof
├── tests/
│   └── integration.mjs    17 integration tests
└── docs/
    └── ARCHITECTURE.md    this file
```
