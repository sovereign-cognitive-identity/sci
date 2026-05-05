# Hybrid Retrieval

Every `memory_recall` runs two searches in parallel and merges them with RRF.

## Why hybrid?

Dense vector search and full-text search fail in complementary ways:

**Dense (pgvector cosine) fails when:**
The query contains specific identifiers — names, project codes, version numbers — that embeddings "smear" across the vector space. `memory_recall("Threadline auth bug")` might not surface memories that mention `Threadline` by name.

**Full-text (tsvector) fails when:**
The query is conceptual. `memory_recall("how did I handle authentication?")` won't match memories using different terminology like "login flow" or "JWT tokens."

## Reciprocal Rank Fusion

Results from both searches are merged with RRF:

```
score(doc) = 1/(rank_dense + 60) + 1/(rank_fts + 60)
```

**k=60** is the standard constant from the original 2009 RRF paper. It dampens the influence of rank-1 outliers without losing top-ranked signal.

A document that ranks 1st in dense and 5th in FTS will score:
```
1/(1+60) + 1/(5+60) = 0.0164 + 0.0154 = 0.0318
```

A document that ranks 1st in dense but not in FTS at all:
```
1/(1+60) + 0 = 0.0164
```

## Implementation

```typescript
// Both searches fire in parallel
const [dense, fts] = await Promise.all([
  reader.query(`
    SELECT id, content, 1 - (emb.embedding <=> $1::vector) AS score
    FROM episodic_memories e
    JOIN embeddings emb ON emb.memory_id = e.id
    WHERE e.profile_id = $2
    ORDER BY score DESC LIMIT $3
  `, [vectorLiteral, profileId, fetchN]),

  reader.query(`
    SELECT id, content, ts_rank_cd(fts, plainto_tsquery('english', $1)) AS rank
    FROM episodic_memories
    WHERE profile_id = $2 AND fts @@ plainto_tsquery('english', $1)
    ORDER BY rank DESC LIMIT $3
  `, [query, profileId, fetchN]),
])

// RRF merge
const scores = new Map<string, number>()
const addRanks = (rows) => rows.forEach((r, i) => {
  scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (i + 1 + 60))
})
addRanks(dense.rows)
addRanks(fts.rows)
```

## Fetch multiplier

Each type (episodic, semantic, identity) fetches `limit × 3` candidates before RRF merge. This ensures the best results from each source have a chance to appear in the final top-N, even if they rank differently in dense vs FTS.

## Full-text indexes

The `fts` column on each memory table is a generated `tsvector`:

```sql
fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
```

GIN indexes are created automatically. Updates to `content` automatically update `fts` — no manual maintenance.

## Cloud backends

The cloud backends (SQLite + hnswlib) use hnswlib for dense search and a keyword boost heuristic (substring match on the lowercased query) instead of SQL full-text search. Quality is slightly lower than the Postgres backend, which is an acceptable tradeoff for the storage sovereignty.

Full-text search via SQLite FTS5 is a planned improvement.
