# Nightly Consolidation

Sci processes your memories every night — promoting signal, fading noise, and generating a digest. Like sleep for your AI context.

## What it does

Four jobs run in sequence:

### 1. Episodic → Semantic promotion

Reads today's raw conversation fragments and asks an LLM: *what durable facts can be extracted from these?*

```
"I think we should use tsvector instead of a dedicated search service — simpler ops"
                              ↓
"Prefers tsvector over dedicated search services for simplicity of operations"
  category: preference  confidence: 0.85
```

New facts are deduplicated against existing semantic nodes by embedding similarity (threshold: 0.88). If a similar node already exists, it gets reinforced instead of duplicated.

### 2. Ebbinghaus decay

Every semantic node gets a decay score recalculated:

```
score = confidence × e^(−days_since_access / stability)
stability = 1 + (access_count × 0.5)
```

A fact you've seen 10 times is stable. One you mentioned once six months ago fades. Below 0.15, a node is flagged — it won't be deleted, but it's deprioritized in retrieval.

### 3. Knowledge graph

A second LLM pass finds relationships between high-confidence semantic nodes:

```
"Prefers TypeScript"  → relates_to →  "Building Sci"
"Values sovereignty"  → motivates  →  "Chose local embeddings over Voyage AI"
```

### 4. Nightly digest

A brief summary of the day's activity is stored as an episodic memory and exported to your Obsidian vault (if configured).

## Setup

### Schedule (recommended)

Add to your crontab (`crontab -e`):

```bash
0 3 * * * cd /path/to/sci && \
  SCI_OPENROUTER_KEY=sk-or-... \
  SCI_DB_READER_URL=postgresql://sci_reader:sci_reader_local@localhost:5432/sci \
  SCI_DB_WRITER_URL=postgresql://sci_writer:sci_writer_local@localhost:5432/sci \
  SCI_EMBED_MODEL=BAAI/bge-base-en-v1.5 \
  npm run consolidate -w packages/core >> ~/Vault/sci/consolidation.log 2>&1
```

### Run manually

```bash
SCI_OPENROUTER_KEY=sk-or-... npm run consolidate -w packages/core
```

To process the last 7 days instead of just today:

```bash
SCI_OPENROUTER_KEY=sk-or-... SCI_CONSOLIDATION_WINDOW_DAYS=7 npm run consolidate -w packages/core
```

## Cost

Consolidation uses an LLM for the promotion and graph passes. With `google/gemini-2.5-flash-lite` (the default), a typical daily run over 50-100 new memories costs under $0.01.

## Obsidian export

If you have an Obsidian vault, set `SCI_VAULT_PATH` and digests are written to `~/Vault/sci/digests/YYYY-MM-DD-digest.md` automatically.

The digest format is compatible with Syncthing — files appear on your phone within minutes.
