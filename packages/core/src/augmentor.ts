import pg from 'pg'
import { writer } from './db.js'
import { embed, MODEL_ID } from './embeddings.js'

type Queryable = { query: pg.Pool['query'] }

export interface MemoryInput {
  content: string
  profileId: string
  source?: string
  agentId?: string
  metadata?: Record<string, unknown>
}

export interface SemanticNodeInput {
  content: string
  profileId: string
  category?: string
  confidence?: number
  metadata?: Record<string, unknown>
}

export class Augmentor {
  // Store an episodic memory (timestamped event/conversation)
  async store(input: MemoryInput): Promise<{ id: string }> {
    const client = await writer.connect()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO episodic_memories (profile_id, content, source, agent_id, metadata)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          input.profileId,
          input.content,
          input.source ?? 'claude',
          input.agentId ?? null,
          JSON.stringify(input.metadata ?? {}),
        ]
      )
      const id = rows[0]!.id

      const vector = await embed(input.content)
      await client.query(
        `INSERT INTO embeddings (memory_type, memory_id, model_id, embedding)
         VALUES ('episodic', $1, $2, $3)
         ON CONFLICT (memory_type, memory_id, model_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [id, MODEL_ID, JSON.stringify(vector)]
      )

      await recordQueue(client as unknown as Queryable, 'store_episodic', { id, ...input })
      await client.query('COMMIT')
      return { id }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // Store a promoted semantic node (fact/concept/relationship)
  async storeSemanticNode(input: SemanticNodeInput): Promise<{ id: string }> {
    const client = await writer.connect()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO semantic_nodes (profile_id, content, category, confidence, metadata)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          input.profileId,
          input.content,
          input.category ?? null,
          input.confidence ?? 1.0,
          JSON.stringify(input.metadata ?? {}),
        ]
      )
      const id = rows[0]!.id

      const vector = await embed(input.content)
      await client.query(
        `INSERT INTO embeddings (memory_type, memory_id, model_id, embedding)
         VALUES ('semantic', $1, $2, $3)
         ON CONFLICT (memory_type, memory_id, model_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [id, MODEL_ID, JSON.stringify(vector)]
      )

      await recordQueue(client as unknown as Queryable, 'store_semantic', { id, ...input })
      await client.query('COMMIT')
      return { id }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // Store a global identity fact (cross-profile)
  async storeIdentityFact(
    content: string,
    category: string,
    confidence = 1.0
  ): Promise<{ id: string }> {
    const client = await writer.connect()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO identity_facts (content, category, confidence)
         VALUES ($1, $2, $3) RETURNING id`,
        [content, category, confidence]
      )
      const id = rows[0]!.id

      const vector = await embed(content)
      await client.query(
        `INSERT INTO embeddings (memory_type, memory_id, model_id, embedding)
         VALUES ('identity', $1, $2, $3)
         ON CONFLICT (memory_type, memory_id, model_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [id, MODEL_ID, JSON.stringify(vector)]
      )

      await recordQueue(client as unknown as Queryable, 'store_identity', { id, content, category })
      await client.query('COMMIT')
      return { id }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}

async function recordQueue(
  client: Queryable,
  operation: string,
  payload: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO write_queue (operation, payload, status, processed_at)
     VALUES ($1, $2, 'done', NOW())`,
    [operation, JSON.stringify(payload)]
  )
}
