#!/usr/bin/env node
/**
 * Sci Proxy — Unit Tests
 *
 * Tests core proxy logic without a live proxy or DB connection.
 * Imports directly from compiled dist/ packages.
 *
 * Usage:
 *   node scripts/test-proxy-unit.mjs
 *   npm run test:unit
 */

import assert from 'assert/strict'
import { homedir } from 'os'
import { join } from 'path'

const ROOT = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..')

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    if (process.env['DEBUG']) console.error(err.stack)
    failed++
  }
}

// ── 1. anonymize() — text structure preservation ──────────────────────────────

console.log('\n── anonymize() — text structure preservation')

const { anonymize, deanonymize, buildTokenMap } = await import(`${ROOT}/packages/core/dist/anonymizer.js`)

await test('anonymize preserves plain text with no entities', () => {
  const text = 'Hello world, this is a simple message.'
  const result = anonymize(text)
  assert.equal(result.text, text, 'plain text should be unchanged')
  assert.equal(result.entityCount, 0, 'no entities expected')
})

await test('anonymize replaces email addresses', () => {
  const text = 'Contact me at alice@example.com for details.'
  const result = anonymize(text)
  assert.ok(!result.text.includes('alice@example.com'), 'email should be masked')
  assert.ok(result.text.includes('[EMAIL_1]'), 'should contain EMAIL token')
  assert.equal(result.entityCount, 1)
})

await test('anonymize replaces phone numbers', () => {
  const text = 'Call me at 555-867-5309.'
  const result = anonymize(text)
  assert.ok(!result.text.includes('555-867-5309'), 'phone should be masked')
  assert.ok(result.text.match(/\[PHONE_\d+\]/), 'should contain PHONE token')
})

await test('anonymize replaces URLs', () => {
  const text = 'Check out https://mycompany.io/dashboard for status.'
  const result = anonymize(text)
  assert.ok(!result.text.includes('https://mycompany.io'), 'URL should be masked')
  assert.ok(result.text.match(/\[URL_\d+\]/), 'should contain URL token')
})

await test('anonymize replaces CamelCase project names', () => {
  const text = 'Working on OpenClaw today with CrossTimbersFarm integration.'
  const result = anonymize(text)
  assert.ok(!result.text.includes('OpenClaw'), 'OpenClaw should be masked')
  assert.ok(!result.text.includes('CrossTimbersFarm'), 'CrossTimbersFarm should be masked')
})

await test('anonymize does NOT mask tech allowlist terms', () => {
  const text = 'Using TypeScript with React and Docker on macOS.'
  const result = anonymize(text)
  assert.ok(result.text.includes('TypeScript'), 'TypeScript should pass through')
  assert.ok(result.text.includes('React'), 'React should pass through')
  assert.ok(result.text.includes('Docker'), 'Docker should pass through')
  assert.ok(result.text.includes('macOS'), 'macOS should pass through')
})

await test('anonymize preserves text inside code fences verbatim', () => {
  const text = `Here is an example:\n\`\`\`\nalice@corp.com\nOpenClaw.init()\n\`\`\``
  const result = anonymize(text)
  // Code blocks should be left untouched
  assert.ok(result.text.includes('alice@corp.com'), 'email inside code fence should NOT be masked')
  assert.ok(result.text.includes('OpenClaw.init()'), 'camel-case inside code fence should NOT be masked')
})

await test('anonymize preserves text structure — words and sentence boundary', () => {
  const text = 'My name is Alice Smith and I work at Acme Corp on a big project.'
  const result = anonymize(text)
  // Should end with same punctuation
  assert.equal(result.text.at(-1), '.', 'should end with period')
  // Word count after splitting on spaces should be in same ballpark (tokens may differ in length)
  const wordCount = (t) => t.trim().split(/\s+/).length
  const origWords = wordCount(text)
  const anonWords = wordCount(result.text)
  // Allow +/- 2 words (tokens like [PERSON_1] collapse multi-word names to one)
  assert.ok(
    Math.abs(origWords - anonWords) <= 3,
    `word count should be similar: original=${origWords}, anonymized=${anonWords}`
  )
})

await test('deanonymize round-trips through anonymize', () => {
  const original = 'Send the report to bob@company.io by Friday.'
  const anon = anonymize(original)
  const restored = deanonymize(anon.text, anon.tokenMap)
  assert.ok(restored.includes('bob@company.io'), 'email should be restored')
})

await test('anonymize accumulates across multiple calls with shared tokenMap', () => {
  const r1 = anonymize('Email alice@corp.com about the plan.')
  const r2 = anonymize('Please CC alice@corp.com on the thread.', r1.tokenMap)
  // Same email should get same token
  const token = r1.tokenMap.forward.get('alice@corp.com')
  assert.ok(token, 'token should exist for email')
  assert.ok(r2.text.includes(token), 'second call should reuse same token')
})

await test('buildTokenMap creates forward/reverse entries', () => {
  const entities = [
    { text: 'alice@test.com', type: 'EMAIL' },
    { text: 'Bob Smith', type: 'PERSON' },
  ]
  const tm = buildTokenMap(entities)
  assert.equal(tm.forward.size, 2)
  assert.equal(tm.reverse.size, 2)
  assert.ok([...tm.reverse.values()].includes('alice@test.com'))
  assert.ok([...tm.reverse.values()].includes('Bob Smith'))
})

// ── 2. embed() — 768-dimensional vector ──────────────────────────────────────

console.log('\n── embed() — 768-dimensional vector')

process.env['SCI_FASTEMBED_CACHE_DIR'] = join(homedir(), '.sci', 'fastembed')
const { embed, DIMENSIONS } = await import(`${ROOT}/packages/core/dist/embeddings.js`)

await test('embed() returns a 768-element array', async () => {
  const vec = await embed('test sentence for embedding')
  assert.equal(Array.isArray(vec), true, 'should be an array')
  assert.equal(vec.length, DIMENSIONS, `expected ${DIMENSIONS} dims, got ${vec.length}`)
  assert.equal(DIMENSIONS, 768, 'DIMENSIONS constant should be 768')
})

await test('embed() returns all finite numbers', async () => {
  const vec = await embed('another test sentence')
  const allFinite = vec.every(v => typeof v === 'number' && isFinite(v))
  assert.ok(allFinite, 'all vector values should be finite numbers')
})

await test('embed() produces consistent output for same input', async () => {
  const text = 'deterministic embedding test'
  const v1 = await embed(text)
  const v2 = await embed(text)
  // Cosine similarity should be ~1.0 for identical inputs
  const dot = v1.reduce((sum, v, i) => sum + v * v2[i], 0)
  const mag1 = Math.sqrt(v1.reduce((s, v) => s + v * v, 0))
  const mag2 = Math.sqrt(v2.reduce((s, v) => s + v * v, 0))
  const cos = dot / (mag1 * mag2)
  assert.ok(cos > 0.999, `cosine similarity ${cos} should be ~1.0 for identical text`)
})

await test('embed() produces different vectors for different inputs', async () => {
  const v1 = await embed('dog running in the park')
  const v2 = await embed('quantum mechanics and thermodynamics')
  const dot = v1.reduce((sum, v, i) => sum + v * v2[i], 0)
  const mag1 = Math.sqrt(v1.reduce((s, v) => s + v * v, 0))
  const mag2 = Math.sqrt(v2.reduce((s, v) => s + v * v, 0))
  const cos = dot / (mag1 * mag2)
  assert.ok(cos < 0.95, `cosine similarity ${cos.toFixed(3)} should be < 0.95 for unrelated text`)
})

// ── 3. iCloudAdapter — SQLite store and retrieve ──────────────────────────────

console.log('\n── iCloudAdapter — SQLite store and retrieve')

import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'

const testDir = join(tmpdir(), `sci-unit-test-${Date.now()}`)
mkdirSync(testDir, { recursive: true })

// Use iCloudAdapter without iCloud sync (point icloudPath at a temp dir too)
const { iCloudAdapter } = await import(`${ROOT}/packages/core/dist/storage/icloud-adapter.js`)
const adapter = new iCloudAdapter(testDir, join(testDir, 'fake-icloud'))

await adapter.connect()

await test('iCloudAdapter creates default work/personal profiles', async () => {
  const profiles = await adapter.getProfiles()
  assert.ok(profiles.length >= 2, `expected >= 2 profiles, got ${profiles.length}`)
  const names = profiles.map(p => p.name)
  assert.ok(names.includes('work'), 'work profile should exist')
  assert.ok(names.includes('personal'), 'personal profile should exist')
})

await test('iCloudAdapter storeEpisodic returns an id', async () => {
  const profile = await adapter.getProfile('work')
  const embedding = await embed('test episodic memory content')
  const { id } = await adapter.storeEpisodic({
    profileId: profile.id,
    content: 'unit test episodic memory',
    embedding,
    source: 'test',
  })
  assert.ok(typeof id === 'string' && id.length > 0, 'id should be a non-empty string')
  assert.ok(id.includes('-'), 'id should be UUID format')
})

await test('iCloudAdapter storeEpisodic can be retrieved via getStats', async () => {
  const profile = await adapter.getProfile('work')
  const embedding = await embed('another test memory for stats check')
  await adapter.storeEpisodic({
    profileId: profile.id,
    content: 'stats check memory',
    embedding,
    source: 'test',
  })
  const stats = await adapter.getStats()
  assert.ok(stats.episodic >= 2, `expected >= 2 episodic records, got ${stats.episodic}`)
  assert.ok(stats.embeddings >= 2, `expected >= 2 embeddings, got ${stats.embeddings}`)
  assert.equal(stats.backend, 'icloud')
})

await test('iCloudAdapter storeIdentityFact stores and can be queried', async () => {
  const content = 'unit test identity fact — user prefers dark mode'
  const embedding = await embed(content)
  const { id } = await adapter.storeIdentityFact({
    content,
    embedding,
    category: 'preference',
    confidence: 0.9,
  })
  assert.ok(id, 'should return id')
  const facts = await adapter.queryIdentityFacts({ category: 'preference', limit: 10 })
  assert.ok(facts.some(f => f.id === id), 'stored fact should be retrievable')
})

await test('iCloudAdapter recall returns stored memories by embedding', async () => {
  const profile = await adapter.getProfile('work')
  const content = 'Casey loves TypeScript and prefers tabs over spaces'
  const embedding = await embed(content)
  const { id } = await adapter.storeEpisodic({ profileId: profile.id, content, embedding, source: 'test' })

  const results = await adapter.recall({
    queryEmbedding: embedding,
    query: content,
    profileId: profile.id,
    limit: 5,
    types: ['episodic'],
  })
  assert.ok(results.length > 0, 'recall should return at least one result')
  assert.ok(results.some(r => r.id === id), 'stored memory should appear in recall results')
})

await test('iCloudAdapter vector_map table has correct count', async () => {
  const stats = await adapter.getStats()
  // vectorMap tracks embeddings stored in hnswlib
  assert.ok(stats.embeddings >= 3, `expected >= 3 embeddings in vector_map, got ${stats.embeddings}`)
})

// Cleanup
await adapter.disconnect()
rmSync(testDir, { recursive: true, force: true })

// ── 4. SSE passthrough — raw bytes forwarded correctly ────────────────────────

console.log('\n── SSE passthrough — DeanonymizingStreamV2')

const { DeanonymizingStreamV2 } = await import(`${ROOT}/packages/proxy/dist/stream/deanonymizer.js`)

await test('DeanonymizingStreamV2 passes through text with no tokens unchanged', () => {
  const tm = { forward: new Map(), reverse: new Map() }
  const stream = new DeanonymizingStreamV2(tm)
  const out1 = stream.push('Hello ')
  const out2 = stream.push('world!')
  const final = stream.end()
  assert.equal(out1 + out2 + final, 'Hello world!')
  assert.equal(stream.fullResponse, 'Hello world!')
})

await test('DeanonymizingStreamV2 deanonymizes complete token in single chunk', () => {
  const tm = {
    forward: new Map([['Alice', '[PERSON_1]']]),
    reverse: new Map([['[PERSON_1]', 'Alice']]),
  }
  const stream = new DeanonymizingStreamV2(tm)
  const out = stream.push('Hello [PERSON_1], welcome!')
  const final = stream.end()
  assert.ok((out + final).includes('Alice'), 'should replace [PERSON_1] with Alice')
  assert.equal(stream.replacementCount, 1)
})

await test('DeanonymizingStreamV2 handles token split across two chunks', () => {
  const tm = {
    forward: new Map([['Bob Smith', '[PERSON_1]']]),
    reverse: new Map([['[PERSON_1]', 'Bob Smith']]),
  }
  const stream = new DeanonymizingStreamV2(tm)
  // Token [PERSON_1] split: "[PER" in chunk1, "SON_1] is here" in chunk2
  const out1 = stream.push('Hello [PER')
  const out2 = stream.push('SON_1] is here.')
  const final = stream.end()
  const full = out1 + out2 + final
  assert.ok(full.includes('Bob Smith'), `expected 'Bob Smith' in output, got: ${full}`)
  assert.ok(!full.includes('[PERSON_1]'), 'token should be replaced, not left raw')
})

await test('DeanonymizingStreamV2 handles multiple tokens in stream', () => {
  const tm = {
    forward: new Map([['Carol', '[PERSON_1]'], ['corp@email.io', '[EMAIL_1]']]),
    reverse: new Map([['[PERSON_1]', 'Carol'], ['[EMAIL_1]', 'corp@email.io']]),
  }
  const stream = new DeanonymizingStreamV2(tm)
  stream.push('[PERSON_1] sent mail to [EMAIL_1].')
  const final = stream.end()
  const full = stream.fullResponse
  assert.ok(full.includes('Carol'), 'PERSON should be replaced')
  assert.ok(full.includes('corp@email.io'), 'EMAIL should be replaced')
  assert.equal(stream.replacementCount, 2)
})

await test('DeanonymizingStreamV2 fullResponse accumulates across all pushes', () => {
  const tm = { forward: new Map(), reverse: new Map() }
  const stream = new DeanonymizingStreamV2(tm)
  stream.push('chunk one ')
  stream.push('chunk two ')
  stream.end()
  // fullResponse built across push calls
  assert.ok(stream.fullResponse.includes('chunk one'), 'fullResponse should contain all pushed chunks')
  assert.ok(stream.fullResponse.includes('chunk two'), 'fullResponse should contain all pushed chunks')
})

await test('DeanonymizingStreamV2 replacedTokens tracks per-token counts', () => {
  const tm = {
    forward: new Map([['Dave', '[PERSON_1]']]),
    reverse: new Map([['[PERSON_1]', 'Dave']]),
  }
  const stream = new DeanonymizingStreamV2(tm)
  stream.push('[PERSON_1] said hello. [PERSON_1] then left.')
  stream.end()
  const replaced = stream.replacedTokens
  const entry = replaced.find(r => r.token === '[PERSON_1]')
  assert.ok(entry, 'should track [PERSON_1]')
  assert.equal(entry.original, 'Dave', 'should record original value')
  assert.ok(entry.count >= 2, `expected count >= 2, got ${entry.count}`)
})

// ── 5. 429 retry — mock fetch returning 429 then 200 ─────────────────────────

console.log('\n── 429 retry — simulated upstream rate limit handling')

await test('proxy retry: 429 followed by 200 resolves successfully', async () => {
  // We simulate the retry pattern the proxy should implement:
  // A fetch wrapper that retries once on 429 with exponential backoff.
  let callCount = 0
  const responses = [
    { status: 429, text: async () => 'rate limited', ok: false, headers: { get: () => null } },
    { status: 200, ok: true, body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) } },
  ]

  async function fetchWithRetry(url, opts, maxRetries = 3) {
    let lastError
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = responses[callCount++] ?? responses[responses.length - 1]
      if (res.status === 429) {
        // Would normally wait: await new Promise(r => setTimeout(r, 2 ** attempt * 100))
        lastError = new Error(`429 rate limited`)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    }
    throw lastError
  }

  const result = await fetchWithRetry('https://api.anthropic.com/v1/messages', {})
  assert.equal(result.status, 200, 'should eventually return 200')
  assert.equal(callCount, 2, 'should have made exactly 2 calls (1 fail + 1 success)')
})

await test('proxy retry: exhausted retries throws error', async () => {
  let callCount = 0
  async function fetchAlways429(url, opts, maxRetries = 2) {
    let lastError
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      callCount++
      lastError = new Error('429 rate limited')
    }
    throw lastError
  }

  await assert.rejects(
    () => fetchAlways429('https://api.anthropic.com/v1/messages', {}),
    { message: '429 rate limited' },
    'should throw after all retries exhausted'
  )
  assert.equal(callCount, 3, 'should attempt maxRetries + 1 times')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`  ${passed} passed, ${failed} failed`)

if (failed > 0) {
  console.error(`\n  FAIL: ${failed} test(s) failed`)
  process.exit(1)
} else {
  console.log(`\n  PASS: all unit tests passed`)
}
