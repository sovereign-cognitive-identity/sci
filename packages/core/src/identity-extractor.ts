/**
 * Identity extraction pass — Phase 2
 *
 * Reads episodic memories in batches, sends them to an LLM via OpenRouter,
 * and extracts structured identity facts into identity_facts.
 *
 * Run: SCI_OPENROUTER_KEY=sk-or-... node dist/identity-extractor.js
 */
import { createStorageAdapter } from './storage/index.js'
import { embed } from './embeddings.js'

const OPENROUTER_KEY = requireEnv('SCI_OPENROUTER_KEY')
const MODEL = process.env['SCI_EXTRACT_MODEL'] ?? 'google/gemini-2.0-flash-001'
const BATCH_SIZE = 25
const CONCURRENCY = 3  // parallel batches in flight
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 5000


// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an identity analyst. Given a batch of raw messages a person wrote to an AI assistant, extract durable identity facts about that person.

Output ONLY a JSON array of facts. Each fact:
{
  "content": "one concise sentence stating the fact",
  "category": "skill" | "preference" | "project" | "value" | "relationship" | "context",
  "confidence": 0.0-1.0
}

Rules:
- Only extract facts clearly supported by the messages — never infer
- Skip conversational filler ("thanks", "ok", "yes please")
- Skip questions the person asked (extract only what they reveal about themselves)
- Merge obviously duplicate facts into one
- confidence 0.9+ = explicitly stated, 0.7 = strongly implied, 0.5 = weakly implied
- Aim for 3-8 facts per batch. Return [] if nothing durable can be extracted.
- Return ONLY the JSON array, no other text.`

function buildUserPrompt(messages: string[]): string {
  return `Messages:\n${messages.map((m, i) => `${i + 1}. ${m.slice(0, 300)}`).join('\n')}`
}

// ── OpenRouter call ───────────────────────────────────────────────────────────

interface IdentityFact {
  content: string
  category: string
  confidence: number
}

async function extractFacts(messages: string[], attempt = 0): Promise<IdentityFact[]> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/sovereign-cognitive-identity/sci',
      'X-Title': 'Sci Identity Extractor',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(messages) },
      ],
      temperature: 0.1,
      max_tokens: 1024,
    }),
  })

  if (res.status === 429 || res.status === 504) {
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * (attempt + 1)
      await new Promise(r => setTimeout(r, delay))
      return extractFacts(messages, attempt + 1)
    }
    const err = await res.text()
    throw new Error(`OpenRouter error ${res.status}: ${err}`)
  }

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenRouter error ${res.status}: ${err}`)
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> }
  const raw = data.choices[0]?.message?.content?.trim() ?? '[]'

  // Strip markdown code fences if model wraps output
  const json = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim()

  try {
    const facts = JSON.parse(json) as IdentityFact[]
    return facts.filter(f => f.content && f.category && typeof f.confidence === 'number')
  } catch {
    console.warn('  Failed to parse LLM output:', raw.slice(0, 200))
    return []
  }
}

function isDuplicate(fact: IdentityFact, existing: Set<string>): boolean {
  return existing.has(fact.content.toLowerCase().trim())
}

async function run() {
  console.log(`\n🔍 Sci Identity Extractor`)
  console.log(`   Model: ${MODEL}`)
  console.log(`   Batch size: ${BATCH_SIZE} messages`)

  const adapter = await createStorageAdapter()
  const profiles = await adapter.getProfiles()
  const workProfile = profiles.find(p => p.name === 'work') ?? profiles[0]
  if (!workProfile) throw new Error('No profiles found')

  const allMemories = await adapter.getEpisodicMemoriesInWindow({
    profileId: workProfile.id,
    windowStart: new Date(0),
    windowEnd: new Date(),
    minLength: 20,
    limit: 5000,
  })
  console.log(`   Episodic memories: ${allMemories.length}`)

  const existingFacts = await adapter.queryIdentityFacts({ limit: 5000 })
  const existing = new Set(existingFacts.map(f => f.content.toLowerCase().trim()))
  console.log(`   Existing identity facts: ${existing.size}`)

  const messages = allMemories.map(m => m.content)
  const batches: string[][] = []
  for (let i = 0; i < messages.length; i += BATCH_SIZE) batches.push(messages.slice(i, i + BATCH_SIZE))
  console.log(`   Batches to process: ${batches.length}\n`)

  let totalExtracted = 0, totalSkipped = 0, totalStored = 0

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY)
    const batchNums = chunk.map((_, j) => i + j + 1)

    const results = await Promise.all(
      chunk.map(async (batch, j) => {
        process.stdout.write(`  batch ${batchNums[j]}/${batches.length} → `)
        try {
          const facts = await extractFacts(batch)
          process.stdout.write(`${facts.length} facts extracted`)
          return facts
        } catch (err) {
          process.stdout.write(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
          return []
        }
      })
    )

    for (const facts of results) {
      totalExtracted += facts.length
      let newCount = 0
      for (const fact of facts) {
        if (isDuplicate(fact, existing)) { totalSkipped++; continue }
        const embedding = await embed(fact.content)
        await adapter.storeIdentityFact({
          content: fact.content,
          embedding,
          category: fact.category,
          confidence: fact.confidence,
        })
        existing.add(fact.content.toLowerCase().trim())
        totalStored++
        newCount++
      }
      process.stdout.write(`, ${newCount} new\n`)
    }
  }

  console.log(`\n✓ Extraction complete`)
  console.log(`  extracted: ${totalExtracted} | stored: ${totalStored} | skipped: ${totalSkipped}`)

  const topFacts = await adapter.queryIdentityFacts({ limit: 5 })
  console.log('\nTop facts by confidence:')
  topFacts.forEach(f => console.log(`  [${f.category}] ${f.content} (${f.confidence})`))

  await adapter.disconnect()
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('Fatal:', err); process.exit(1) })

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}
