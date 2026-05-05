# Memory Layers

Sci uses three memory layers modeled on cognitive science.

## The three layers

| Layer | Scope | Lifecycle | What lives here |
|---|---|---|---|
| **Episodic** | Profile-scoped | Accumulates; decay doesn't apply | Raw timestamped events, conversation fragments, decisions |
| **Semantic** | Profile-scoped | Promoted from episodic; Ebbinghaus decay | Durable facts, preferences, project context |
| **Identity** | Global (all profiles) | Stable; confidence-weighted | Values, skills, relationships — who you are |

## The profiles model

One person, multiple contexts. Think Safari browser profiles.

```
Identity (global)
  ├── preferences, values, cognitive style
  ├── relationships (exist across all profiles)
  └── Profiles
        ├── work    ← Claude Code, Cursor, Copilot
        ├── personal ← Claude.ai
        └── project:X ← (power users)
```

Default for new users: `work` + `personal`. Agents are assigned to a profile at connection time.

## Episodic → Semantic promotion

Nightly consolidation lifts high-signal episodic memories into semantic nodes:

```
"I think we should use tsvector instead of dedicated search" (episodic)
                        ↓ nightly LLM pass
"Prefers tsvector for search — values operational simplicity" (semantic)
```

Promotion uses embedding similarity to deduplicate — if a similar semantic node already exists (cosine > 0.88), it gets reinforced instead of duplicated.

## Ebbinghaus decay

Every semantic node has a `decay_score` recalculated nightly:

```
score = confidence × e^(−t / S)
  t = days since last access
  S = 1 + (access_count × 0.5)   (stability)
```

A note you've referenced 10 times has stability 6 — halved every ~6 days without access.
A note you mentioned once has stability 1.5 — halved every ~1.5 days.

Nodes below 0.15 are flagged in metadata. They're not deleted — just deprioritized in retrieval.

## The embeddings table

```sql
CREATE TABLE embeddings (
  memory_type  TEXT,     -- 'episodic', 'semantic', 'identity'
  memory_id    UUID,
  model_id     TEXT,     -- 'BAAI/bge-base-en-v1.5', 'voyage-3-lite', ...
  embedding    vector(768),
  UNIQUE (memory_type, memory_id, model_id)
);
```

Keyed by `(type, id, model)`. This enables:
- **Model migration without downtime** — add rows for the new model alongside old ones
- **A/B testing** — compare retrieval quality between models on the same corpus
- **Multiple dimensions** — BGE (768-dim) and Voyage (512-dim) coexist

## Retrieval

See [Hybrid Retrieval](/architecture/retrieval) for how recall searches across all three layers.
