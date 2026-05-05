/**
 * LocalAdapter — Postgres + pgvector backend.
 *
 * This is the existing implementation, wrapped in the StorageAdapter interface.
 * Zero behaviour change — just exposes the same operations through the abstract API.
 */
import pg from 'pg'
import type {
  StorageAdapter, Profile, SemanticNode, IdentityFact, RecallResult, StorageStats
} from './interface.js'
import { MODEL_ID } from '../embeddings.js'

const { Pool } = pg

export class LocalAdapter implements StorageAdapter {
  readonly backend = 'postgres'

  private _reader: pg.Pool
  private _writer: pg.Pool

  constructor(readerUrl: string, writerUrl: string) {
    this._reader = new Pool({ connectionString: readerUrl, max: 5 })
    this._writer = new Pool({ connectionString: writerUrl, max: 3 })
  }

  async connect(): Promise<void> {
    await this._reader.query('SELECT 1')
  }

  async disconnect(): Promise<void> {
    await Promise.all([this._reader.end(), this._writer.end()])
  }

  // ── Profiles ──────────────────────────────────────────────────────────────

  async getProfiles(): Promise<Profile[]> {
    const { rows } = await this._reader.query<Profile>(
      'SELECT id, name, created_at FROM profiles ORDER BY name'
    )
    return rows
  }

  async getProfile(name: string): Promise<Profile | null> {
    const { rows } = await this._reader.query<Profile>(
      'SELECT id, name, created_at FROM profiles WHERE name = $1',
      [name]
    )
    return rows[0] ?? null
  }

  async createProfile(name: string): Promise<Profile> {
    const { rows } = await this._writer.query<Profile>(
      'INSERT INTO profiles (name) VALUES ($1) RETURNING id, name, created_at',
      [name]
    )
    return rows[0]!
  }

  // ── Episodic ──────────────────────────────────────────────────────────────

  async storeEpisodic(input: {
    profileId: string; content: string; embedding: number[]
    source?: string; agentId?: string; metadata?: Record<string, unknown>
  }): Promise<{ id: string }> {
    const client = await this._writer.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO episodic_memories (profile_id, content, source, agent_id, metadata)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.profileId, input.content, input.source ?? 'sci',
         input.agentId ?? null, JSON.stringify(input.metadata ?? {})]
      )
      const id = rows[0]!.id
      await client.query(
        `INSERT INTO embeddings (memory_type, memory_id, model_id, embedding)
         VALUES ('episodic', $1, $2, $3)
         ON CONFLICT (memory_type, memory_id, model_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [id, MODEL_ID, JSON.stringify(input.embedding)]
      )
      await client.query('COMMIT')
      return { id }
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  }

  // ── Semantic ──────────────────────────────────────────────────────────────

  async storeSemantic(input: {
    profileId: string; content: string; embedding: number[]
    category?: string; confidence?: number; metadata?: Record<string, unknown>
  }): Promise<{ id: string }> {
    const client = await this._writer.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO semantic_nodes (profile_id, content, category, confidence, metadata)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.profileId, input.content, input.category ?? null,
         input.confidence ?? 1.0, JSON.stringify(input.metadata ?? {})]
      )
      const id = rows[0]!.id
      await client.query(
        `INSERT INTO embeddings (memory_type, memory_id, model_id, embedding)
         VALUES ('semantic', $1, $2, $3)
         ON CONFLICT (memory_type, memory_id, model_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [id, MODEL_ID, JSON.stringify(input.embedding)]
      )
      await client.query('COMMIT')
      return { id }
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  }

  async reinforceSemantic(id: string): Promise<void> {
    await this._writer.query(
      `UPDATE semantic_nodes SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = $1`,
      [id]
    )
  }

  async updateDecayScore(id: string, score: number, flagged: boolean): Promise<void> {
    await this._writer.query(
      `UPDATE semantic_nodes SET decay_score = $1,
       metadata = CASE WHEN $2 THEN metadata || '{"decay_flagged":true}'::jsonb
                       ELSE metadata - 'decay_flagged' END
       WHERE id = $3`,
      [score, flagged, id]
    )
  }

  async getSemanticNodes(profileId: string, options?: {
    minConfidence?: number; minDecay?: number; limit?: number
  }): Promise<SemanticNode[]> {
    const { rows } = await this._reader.query<SemanticNode>(
      `SELECT id, profile_id, content, category, confidence, decay_score,
              access_count, last_accessed_at, created_at, metadata
       FROM semantic_nodes
       WHERE profile_id = $1
         AND confidence >= $2
         AND decay_score >= $3
       ORDER BY created_at DESC LIMIT $4`,
      [profileId, options?.minConfidence ?? 0, options?.minDecay ?? 0, options?.limit ?? 1000]
    )
    return rows
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  async storeIdentityFact(input: {
    content: string; embedding: number[]
    category?: string; confidence?: number; metadata?: Record<string, unknown>
  }): Promise<{ id: string }> {
    const client = await this._writer.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO identity_facts (content, category, confidence, metadata)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.content, input.category ?? null,
         input.confidence ?? 1.0, JSON.stringify(input.metadata ?? {})]
      )
      const id = rows[0]!.id
      await client.query(
        `INSERT INTO embeddings (memory_type, memory_id, model_id, embedding)
         VALUES ('identity', $1, $2, $3)
         ON CONFLICT (memory_type, memory_id, model_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [id, MODEL_ID, JSON.stringify(input.embedding)]
      )
      await client.query('COMMIT')
      return { id }
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  }

  // ── Recall ────────────────────────────────────────────────────────────────

  async recall(input: {
    queryEmbedding: number[]; query: string; profileId: string
    limit: number; types: Array<'episodic' | 'semantic' | 'identity'>
  }): Promise<RecallResult[]> {
    const vectorLiteral = `[${input.queryEmbedding.join(',')}]`
    const fetchN = input.limit * 3
    const results: RecallResult[] = []

    if (input.types.includes('episodic')) {
      const [dense, fts] = await Promise.all([
        this._reader.query<{ id: string; content: string; metadata: Record<string, unknown>; occurred_at: Date; score: number }>(
          `SELECT e.id, e.content, e.metadata, e.occurred_at,
                  1 - (emb.embedding <=> $1::vector) AS score
           FROM episodic_memories e
           JOIN embeddings emb ON emb.memory_id = e.id AND emb.memory_type = 'episodic' AND emb.model_id = $4
           JOIN profiles p ON p.id = e.profile_id AND p.id = $2
           ORDER BY score DESC LIMIT $3`,
          [vectorLiteral, input.profileId, fetchN, MODEL_ID]
        ),
        this._reader.query<{ id: string; content: string; metadata: Record<string, unknown>; occurred_at: Date; rank: number }>(
          `SELECT e.id, e.content, e.metadata, e.occurred_at,
                  ts_rank_cd(e.fts, plainto_tsquery('english', $1)) AS rank
           FROM episodic_memories e
           WHERE e.profile_id = $2 AND e.fts @@ plainto_tsquery('english', $1)
           ORDER BY rank DESC LIMIT $3`,
          [input.query, input.profileId, fetchN]
        ),
      ])
      results.push(
        ...dense.rows.map((r): RecallResult => ({ ...r, type: 'episodic', score: r.score })),
        ...fts.rows.map((r): RecallResult => ({ ...r, type: 'episodic', score: r.rank })),
      )
    }

    if (input.types.includes('semantic')) {
      const [dense, fts] = await Promise.all([
        this._reader.query<{ id: string; content: string; metadata: Record<string, unknown>; score: number }>(
          `SELECT s.id, s.content, s.metadata, 1 - (emb.embedding <=> $1::vector) AS score
           FROM semantic_nodes s
           JOIN embeddings emb ON emb.memory_id = s.id AND emb.memory_type = 'semantic' AND emb.model_id = $4
           WHERE s.profile_id = $2
           ORDER BY score DESC LIMIT $3`,
          [vectorLiteral, input.profileId, fetchN, MODEL_ID]
        ),
        this._reader.query<{ id: string; content: string; metadata: Record<string, unknown>; rank: number }>(
          `SELECT s.id, s.content, s.metadata, ts_rank_cd(s.fts, plainto_tsquery('english', $1)) AS rank
           FROM semantic_nodes s
           WHERE s.profile_id = $2 AND s.fts @@ plainto_tsquery('english', $1)
           ORDER BY rank DESC LIMIT $3`,
          [input.query, input.profileId, fetchN]
        ),
      ])
      results.push(
        ...dense.rows.map((r): RecallResult => ({ ...r, type: 'semantic' })),
        ...fts.rows.map((r): RecallResult => ({ ...r, type: 'semantic', score: r.rank })),
      )
    }

    if (input.types.includes('identity')) {
      const [dense, fts] = await Promise.all([
        this._reader.query<{ id: string; content: string; metadata: Record<string, unknown>; score: number }>(
          `SELECT f.id, f.content, f.metadata, 1 - (emb.embedding <=> $1::vector) AS score
           FROM identity_facts f
           JOIN embeddings emb ON emb.memory_id = f.id AND emb.memory_type = 'identity' AND emb.model_id = $3
           ORDER BY score DESC LIMIT $2`,
          [vectorLiteral, fetchN, MODEL_ID]
        ),
        this._reader.query<{ id: string; content: string; metadata: Record<string, unknown>; rank: number }>(
          `SELECT f.id, f.content, f.metadata, ts_rank_cd(f.fts, plainto_tsquery('english', $1)) AS rank
           FROM identity_facts f
           WHERE f.fts @@ plainto_tsquery('english', $1)
           ORDER BY rank DESC LIMIT $2`,
          [input.query, fetchN]
        ),
      ])
      results.push(
        ...dense.rows.map((r): RecallResult => ({ ...r, type: 'identity' })),
        ...fts.rows.map((r): RecallResult => ({ ...r, type: 'identity', score: r.rank })),
      )
    }

    return rrf(results, input.limit)
  }

  async queryIdentityFacts(options?: {
    query?: string; queryEmbedding?: number[]
    category?: string; limit?: number
  }): Promise<IdentityFact[]> {
    const limit = options?.limit ?? 20
    if (options?.query && options.queryEmbedding) {
      const vectorLiteral = `[${options.queryEmbedding.join(',')}]`
      const { rows } = await this._reader.query<IdentityFact>(
        `SELECT f.id, f.content, f.category, f.confidence, f.created_at, f.metadata,
                1 - (emb.embedding <=> $1::vector) AS score
         FROM identity_facts f
         JOIN embeddings emb ON emb.memory_id = f.id AND emb.memory_type = 'identity' AND emb.model_id = $3
         ${options.category ? 'WHERE f.category = $4' : ''}
         ORDER BY score DESC LIMIT $2`,
        options.category ? [vectorLiteral, limit, MODEL_ID, options.category] : [vectorLiteral, limit, MODEL_ID]
      )
      return rows
    }
    const { rows } = await this._reader.query<IdentityFact>(
      options?.category
        ? `SELECT id, content, category, confidence, created_at, metadata FROM identity_facts WHERE category = $1 ORDER BY confidence DESC LIMIT $2`
        : `SELECT id, content, category, confidence, created_at, metadata FROM identity_facts ORDER BY confidence DESC LIMIT $1`,
      options?.category ? [options.category, limit] : [limit]
    )
    return rows
  }

  // ── Consolidation ─────────────────────────────────────────────────────────

  async getEpisodicMemoriesInWindow(options: {
    profileId: string; windowStart: Date; windowEnd: Date
    minLength?: number; excludeDigests?: boolean; limit?: number
  }): Promise<Array<{ id: string; content: string }>> {
    const { rows } = await this._reader.query<{ id: string; content: string }>(
      `SELECT id, content FROM episodic_memories
       WHERE profile_id = $1 AND occurred_at >= $2 AND occurred_at < $3
         AND length(content) >= $4
         ${options.excludeDigests ? `AND (metadata->>'type' IS NULL OR metadata->>'type' != 'digest')` : ''}
       ORDER BY occurred_at ASC LIMIT $5`,
      [options.profileId, options.windowStart, options.windowEnd,
       options.minLength ?? 20, options.limit ?? 2000]
    )
    return rows
  }

  async countEpisodicMemoriesInWindow(windowStart: Date, windowEnd: Date): Promise<number> {
    const { rows } = await this._reader.query<{ count: string }>(
      `SELECT COUNT(*) FROM episodic_memories
       WHERE occurred_at >= $1 AND occurred_at < $2
         AND (metadata->>'type' IS NULL OR metadata->>'type' != 'digest')`,
      [windowStart, windowEnd]
    )
    return parseInt(rows[0]!.count)
  }

  async findSimilarSemanticNode(
    embedding: number[],
    profileId: string,
    threshold = 0.88
  ): Promise<{ id: string; content: string } | null> {
    const vectorLiteral = `[${embedding.join(',')}]`
    const { rows } = await this._reader.query<{ id: string; content: string; score: number }>(
      `SELECT s.id, s.content, 1 - (emb.embedding <=> $1::vector) AS score
       FROM semantic_nodes s
       JOIN embeddings emb ON emb.memory_id = s.id
         AND emb.memory_type = 'semantic' AND emb.model_id = $3
       WHERE s.profile_id = $2
       ORDER BY score DESC LIMIT 1`,
      [vectorLiteral, profileId, MODEL_ID]
    )
    const row = rows[0]
    return row && row.score >= threshold ? row : null
  }

  async getSemanticNodesForGraph(profileId: string, options?: {
    minConfidence?: number; minDecay?: number; limit?: number
  }): Promise<Array<{ id: string; content: string }>> {
    const { rows } = await this._reader.query<{ id: string; content: string }>(
      `SELECT id, content FROM semantic_nodes
       WHERE profile_id = $1 AND confidence >= $2 AND decay_score >= $3
       ORDER BY created_at DESC LIMIT $4`,
      [profileId, options?.minConfidence ?? 0.6, options?.minDecay ?? 0.3, options?.limit ?? 40]
    )
    return rows
  }

  async getLastEpisodicWrite(): Promise<Date | null> {
    const { rows } = await this._reader.query<{ occurred_at: Date }>(
      'SELECT occurred_at FROM episodic_memories ORDER BY occurred_at DESC LIMIT 1'
    )
    return rows[0]?.occurred_at ?? null
  }

  async insertSemanticEdge(
    sourceId: string, targetId: string, relationship: string, confidence: number
  ): Promise<void> {
    await this._writer.query(
      `INSERT INTO semantic_edges (source_id, target_id, relationship, confidence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_id, target_id, relationship) DO UPDATE SET confidence = EXCLUDED.confidence`,
      [sourceId, targetId, relationship, confidence]
    )
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  async getStats(): Promise<StorageStats> {
    const [e, s, i, emb] = await Promise.all([
      this._reader.query<{ count: string }>('SELECT COUNT(*) FROM episodic_memories'),
      this._reader.query<{ count: string }>('SELECT COUNT(*) FROM semantic_nodes'),
      this._reader.query<{ count: string }>('SELECT COUNT(*) FROM identity_facts'),
      this._reader.query<{ count: string }>('SELECT COUNT(*) FROM embeddings'),
    ])
    return {
      episodic: parseInt(e.rows[0]!.count),
      semantic: parseInt(s.rows[0]!.count),
      identity: parseInt(i.rows[0]!.count),
      embeddings: parseInt(emb.rows[0]!.count),
      backend: 'postgres',
    }
  }

  // ── Write queue ───────────────────────────────────────────────────────────

  async recordWrite(operation: string, payload: Record<string, unknown>): Promise<void> {
    await this._writer.query(
      `INSERT INTO write_queue (operation, payload, status, processed_at) VALUES ($1, $2, 'done', NOW())`,
      [operation, JSON.stringify(payload)]
    )
  }

  // ── Consolidation ─────────────────────────────────────────────────────────

  async getLastConsolidationRun(): Promise<Date | null> {
    const { rows } = await this._reader.query<{ ran_at: Date }>(
      'SELECT ran_at FROM consolidation_runs ORDER BY ran_at DESC LIMIT 1'
    )
    return rows[0]?.ran_at ?? null
  }

  async recordConsolidationRun(data: {
    windowStart: Date; windowEnd: Date; episodicProcessed: number
    semanticPromoted: number; semanticReinforced: number; nodesDecayed: number
    digestId?: string; modelUsed?: string; durationMs: number
  }): Promise<void> {
    await this._writer.query(
      `INSERT INTO consolidation_runs
         (window_start, window_end, episodic_processed, semantic_promoted,
          semantic_reinforced, nodes_decayed, digest_id, model_used, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [data.windowStart, data.windowEnd, data.episodicProcessed,
       data.semanticPromoted, data.semanticReinforced, data.nodesDecayed,
       data.digestId ?? null, data.modelUsed ?? null, data.durationMs]
    )
  }

  // ── Sync (no-op for local) ────────────────────────────────────────────────

  async sync(): Promise<{ uploaded: number; downloaded: number }> {
    return { uploaded: 0, downloaded: 0 }
  }
}

// ── RRF helper ────────────────────────────────────────────────────────────────

function rrf(results: RecallResult[], limit: number, k = 60): RecallResult[] {
  const scores = new Map<string, number>()
  const items = new Map<string, RecallResult>()
  results.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (i + 1 + k))
    if (!items.has(r.id)) items.set(r.id, r)
  })
  return [...items.values()]
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
    .slice(0, limit)
    .map(r => ({ ...r, score: scores.get(r.id) ?? 0 }))
}
