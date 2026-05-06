#!/usr/bin/env node
/**
 * One-shot consolidator runner — promotes episodic memories into semantic nodes.
 *
 * Mirrors @sci/core's `runPromotionPass` but calls Anthropic directly via
 * the user's OAuth token (subscription billing) instead of OpenRouter.
 *
 *   node dist/consolidate.js                # promote all user-role episodics
 *   node dist/consolidate.js --since 7d     # only memories from the last 7 days
 *   node dist/consolidate.js --dry          # extract + log, don't write
 *
 * After this runs, `semantic_nodes` will have focused facts ("User attended
 * X University") with their own embeddings. Recall against those will surface
 * specific information that the long-blob episodic embeddings miss.
 */

import { embed, createStorageAdapter, type StorageAdapter, reader } from '@sci/core'
import { getAccessTokenSafe, ANTHROPIC_OAUTH_BETA } from './oauth.js'

// ── Prompt + types — kept in sync with @sci/core/consolidator.ts ─────────────

const PROMOTION_SYSTEM = `You are a knowledge distiller. Given a batch of raw messages a person wrote to AI assistants, extract durable semantic facts worth keeping long-term.

Output ONLY a JSON array. Each item:
{ "content": "concise declarative fact", "category": "fact"|"preference"|"decision"|"project"|"relationship"|"skill", "confidence": 0.5-1.0 }

Extraction rules:
- Be EXHAUSTIVE for long documents (resumes, bios, project lists, professional summaries). For a resume, extract every employer + role + dates, every educational institution (the institution name alone qualifies — degree type and year are bonus, not required), every named field of study or major, every certification, every named project, every named skill area, every patent, plus contact info (email, phone, address, LinkedIn). Aim for 20-60 facts on a full resume.
- Always look for an "Education" section. Even a single line like "University of X — Mathematics" is fact-worthy: extract as "Casey attended University of X studying Mathematics".
- For short conversational turns (a few sentences), aim for 1-3 facts each.
- Omit hedges, questions, and meta-commentary. Only extract clearly stated information.
- Each fact must be self-contained (no pronouns referring to outside context). Use third-person: "Casey attended X University" not "I attended X".
- Preserve specific values verbatim where possible (institution names, job titles, dollar figures, dates, locations).
- If nothing fact-worthy, return [].`

interface LLMFact {
  content:    string
  category:   string
  confidence: number
}

const SIMILARITY_THRESHOLD = 0.88
const BATCH_SIZE           = 20
const MODEL                = process.env['SCI_CONSOLIDATE_MODEL'] ?? 'claude-haiku-4-5-20251001'
const PROFILE_NAME         = 'work'
const MIN_LENGTH           = 20

// ── LLM call — Anthropic /v1/messages with OAuth ─────────────────────────────

async function llmCall(system: string, user: string, token: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization':     `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    ANTHROPIC_OAUTH_BETA,
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:       MODEL,
      system,
      messages:    [{ role: 'user', content: user }],
      // Resumes can produce 20-50 facts × ~50 tokens each. 4K leaves headroom.
      max_tokens:  4096,
      temperature: 0.1,
    }),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 400)}`)
  }
  const data = await res.json() as {
    content: Array<{ type: string; text?: string }>
  }
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim()
}

function parseJson<T>(raw: string): T | null {
  // Strip ```json fences the model sometimes adds despite the system prompt.
  const clean = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim()
  try { return JSON.parse(clean) as T } catch { return null }
}

// ── Episodic enumeration — direct SQL (adapter doesn't expose role filter) ──

interface EpisodicRow {
  id:         string
  content:    string
  occurred_at: Date
  metadata:   { role?: string; conversation_id?: string }
}

async function loadUserEpisodics(profileId: string, sinceMs: number | null): Promise<EpisodicRow[]> {
  const conditions = [
    `profile_id = $1`,
    `length(content) >= ${MIN_LENGTH}`,
    `metadata->>'role' = 'user'`,   // only what the user actually wrote
  ]
  const params: unknown[] = [profileId]
  if (sinceMs !== null) {
    conditions.push(`occurred_at >= $${params.length + 1}`)
    params.push(new Date(sinceMs).toISOString())
  }
  const sql = `
    SELECT id, content, occurred_at, metadata
    FROM episodic_memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY occurred_at ASC
  `
  const result = await reader.query<EpisodicRow>(sql, params)
  return result.rows
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface Args { since: number | null; dry: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { since: null, dry: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dry') out.dry = true
    else if (a === '--since') {
      const v = argv[++i] ?? ''
      const m = v.match(/^(\d+)\s*([dh])?$/i)
      if (!m) throw new Error(`bad --since "${v}"; expected e.g. 7d or 24h`)
      const n = Number.parseInt(m[1]!, 10)
      const ms = (m[2] ?? 'd').toLowerCase() === 'h' ? n * 3600_000 : n * 86400_000
      out.since = Date.now() - ms
    }
  }
  return out
}

async function main(): Promise<void> {
  const args  = parseArgs(process.argv.slice(2))
  const token = await getAccessTokenSafe()
  console.log(`✓ OAuth token ready (model=${MODEL})`)

  const adapter: StorageAdapter = await createStorageAdapter()

  let profile = await adapter.getProfile(PROFILE_NAME)
  if (!profile) profile = await adapter.createProfile(PROFILE_NAME)
  console.log(`✓ profile: ${profile.name} (${profile.id})`)

  const memories = await loadUserEpisodics(profile.id, args.since)
  console.log(`✓ loaded ${memories.length} user-role episodic memories${args.since ? ' (filtered by --since)' : ''}`)
  if (memories.length === 0) {
    console.log('nothing to consolidate.')
    await adapter.disconnect()
    return
  }

  let promoted = 0, reinforced = 0, batches = 0
  const totalBatches = Math.ceil(memories.length / BATCH_SIZE)

  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE)
    // Cap per excerpt at 12KB. Discovered the hard way: a 6636-char resume
    // had its Education section at position 6483 — a 6KB slice was cutting
    // off the most important part. With BATCH_SIZE=20 the worst case is
    // 240KB (~60K tokens), still well inside Haiku's 200K window.
    const userPrompt = batch
      .map((m, j) => `${j + 1}. ${m.content.slice(0, 12000)}`)
      .join('\n\n')

    let facts: LLMFact[] = []
    try {
      const raw = await llmCall(PROMOTION_SYSTEM, userPrompt, token)
      facts = parseJson<LLMFact[]>(raw) ?? []
    } catch (err) {
      console.error(`\n  [batch ${batches + 1}] LLM error:`, (err as Error).message)
    }

    for (const fact of facts) {
      if (!fact.content || typeof fact.confidence !== 'number') continue
      if (args.dry) {
        console.log(`    [dry] ${fact.category ?? 'fact'} (${fact.confidence.toFixed(2)}): ${fact.content}`)
        continue
      }
      const embedding = await embed(fact.content)
      const similar   = await adapter.findSimilarSemanticNode(embedding, profile.id, SIMILARITY_THRESHOLD)
      if (similar) {
        await adapter.reinforceSemantic(similar.id)
        reinforced++
      } else {
        await adapter.storeSemantic({
          content:    fact.content,
          profileId:  profile.id,
          embedding,
          category:   fact.category ?? 'fact',
          confidence: Math.min(1.0, Math.max(0.1, fact.confidence)),
          metadata:   { source: 'consolidate-cli', via: 'oauth' },
        })
        promoted++
      }
    }

    batches++
    process.stdout.write(`\r  ${batches}/${totalBatches} batches — ${promoted} promoted, ${reinforced} reinforced  `)
  }
  process.stdout.write('\n')

  console.log(`\n✓ done — ${promoted} new semantic nodes, ${reinforced} reinforced, across ${batches} batches`)
  if (args.dry) console.log('  (dry run — nothing written)')
  await adapter.disconnect()
}

main().catch((err) => {
  console.error('error:', err.message)
  process.exit(1)
})
