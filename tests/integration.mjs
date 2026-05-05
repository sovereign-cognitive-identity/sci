/**
 * Sci integration tests — run against a live DB.
 * Usage: node tests/integration.mjs
 *
 * Requires: Postgres running, env vars set.
 */

import { createStorageAdapter } from '../packages/core/dist/storage/index.js'
import { embed } from '../packages/core/dist/embeddings.js'
import { anonymize, deanonymize } from '../packages/core/dist/anonymizer.js'
import { calculateDecay } from '../packages/core/dist/decay.js'
import { validateToken, registerAgent, hashToken } from '../packages/core/dist/auth.js'

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
    failed++
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'Assertion failed')
}

// ── Storage adapter ───────────────────────────────────────────────────────────

console.log('\n── Storage adapter (local/Postgres)')

const adapter = await createStorageAdapter()

await test('connect and get stats', async () => {
  const stats = await adapter.getStats()
  assert(stats.backend === 'postgres', `expected postgres, got ${stats.backend}`)
  assert(typeof stats.episodic === 'number', 'episodic count should be a number')
})

await test('get profiles', async () => {
  const profiles = await adapter.getProfiles()
  assert(profiles.length >= 2, `expected at least 2 profiles, got ${profiles.length}`)
  assert(profiles.some(p => p.name === 'work'), 'work profile should exist')
})

await test('store and recall episodic memory', async () => {
  const profile = await adapter.getProfile('work')
  assert(profile, 'work profile not found')

  const content = `Integration test memory — ${Date.now()}`
  const embedding = await embed(content)

  const { id } = await adapter.storeEpisodic({ profileId: profile.id, content, embedding })
  assert(id, 'should return an id')

  const results = await adapter.recall({
    queryEmbedding: embedding,
    query: content,
    profileId: profile.id,
    limit: 1,
    types: ['episodic'],
  })
  assert(results.length > 0, 'recall returned no results')
  assert(results[0].id === id, `expected ${id}, got ${results[0].id}`)
  assert(results[0].content === content, 'content mismatch')
})

await test('store and query identity fact', async () => {
  const content = `Integration test preference — ${Date.now()}`
  const embedding = await embed(content)

  const { id } = await adapter.storeIdentityFact({
    content, embedding, category: 'preference', confidence: 0.8
  })
  assert(id, 'should return an id')

  // Query with embedding to find the specific fact we just stored
  const queryEmb = await embed(content)
  const facts = await adapter.queryIdentityFacts({ query: content, queryEmbedding: queryEmb, limit: 5 })
  const found = facts.find(f => f.id === id)
  assert(found, 'stored identity fact not found in query')
  assert(found.confidence === 0.8, `confidence mismatch: ${found.confidence}`)
})

await test('getLastEpisodicWrite returns a date', async () => {
  const date = await adapter.getLastEpisodicWrite()
  assert(date instanceof Date, 'should return a Date')
  assert(date.getTime() > 0, 'date should be > epoch')
})

await test('findSimilarSemanticNode returns null for dissimilar', async () => {
  const profile = await adapter.getProfile('work')
  const noise = new Array(768).fill(0).map(() => Math.random())
  const result = await adapter.findSimilarSemanticNode(noise, profile.id, 0.99)
  assert(result === null, 'should not find similar node with threshold 0.99 on random embedding')
})

// ── Anonymization ─────────────────────────────────────────────────────────────

console.log('\n── Anonymization')

await test('anonymize masks person name', () => {
  const result = anonymize('My name is Jordan Smith and I live in Denver.')
  assert(!result.text.includes('Jordan Smith'), 'real name should be masked')
  assert(result.text.includes('[PERSON_1]'), 'should contain token')
  assert(result.tokenMap.reverse.get('[PERSON_1]') === 'Jordan Smith', 'token map should map back')
})

await test('deanonymize restores original', () => {
  const original = 'My email is test@example.com and I work at Acme.'
  const anon = anonymize(original)
  const restored = deanonymize(anon.text, anon.tokenMap)
  assert(restored.includes('test@example.com'), 'email should be restored')
})

await test('anonymize masks email', () => {
  const result = anonymize('Contact me at casey.zandbergen@gmail.com')
  assert(!result.text.includes('casey.zandbergen@gmail.com'), 'email should be masked')
  assert(result.detected.some(e => e.type === 'EMAIL'), 'EMAIL entity should be detected')
})

await test('anonymize masks URL', () => {
  const result = anonymize('Check https://openrouter.ai for details')
  assert(!result.text.includes('https://openrouter.ai'), 'URL should be masked')
  assert(result.detected.some(e => e.type === 'URL'), 'URL entity should be detected')
})

await test('anonymize leaves allowlisted tech terms', () => {
  const result = anonymize('I use TypeScript and Docker for development.')
  assert(result.text.includes('TypeScript'), 'TypeScript should not be masked')
  assert(result.text.includes('Docker'), 'Docker should not be masked')
})

// ── Decay math ────────────────────────────────────────────────────────────────

console.log('\n── Decay math')

await test('decay score decreases over time', () => {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 86400_000)
  const lastWeek = new Date(now.getTime() - 7 * 86400_000)

  const scoreYesterday = calculateDecay(1.0, 0, yesterday, now)
  const scoreLastWeek = calculateDecay(1.0, 0, lastWeek, now)

  assert(scoreYesterday > scoreLastWeek, 'score should be higher for more recent access')
  assert(scoreYesterday < 1.0, 'score should be less than 1 after a day')
  assert(scoreLastWeek > 0, 'score should be positive')
})

await test('higher access count slows decay', () => {
  const now = new Date()
  const oneWeekAgo = new Date(now.getTime() - 7 * 86400_000)

  const scoreUnused = calculateDecay(1.0, 0, oneWeekAgo, now)
  const scoreFrequent = calculateDecay(1.0, 20, oneWeekAgo, now)

  assert(scoreFrequent > scoreUnused, 'frequently accessed node should decay slower')
})

// ── Auth tiers ────────────────────────────────────────────────────────────────

console.log('\n── Auth tiers')

await test('valid token resolves to agent context', async () => {
  const result = await registerAgent('test-agent-integration', 'standard', 'work')
  assert(result.token.startsWith('sci_s_'), 'standard token should start with sci_s_')

  const context = await validateToken(result.token)
  assert(context !== null, 'token should be valid')
  assert(context.tier === 'standard', `expected standard tier, got ${context.tier}`)
  assert(context.agentName === 'test-agent-integration', 'agent name mismatch')

  // cleanup
  const { writer: w } = await import('../packages/core/dist/db.js')
  await w.query('DELETE FROM agents WHERE name = $1', ['test-agent-integration'])
})

await test('invalid token returns null', async () => {
  const result = await validateToken('sci_s_notavalidtoken')
  assert(result === null, 'invalid token should return null')
})

await test('trusted token prefix is sci_t_', async () => {
  const { generateToken } = await import('../packages/core/dist/auth.js')
  const token = generateToken('trusted')
  assert(token.startsWith('sci_t_'), 'trusted token prefix wrong')
})

await test('public token prefix is sci_p_', async () => {
  const { generateToken } = await import('../packages/core/dist/auth.js')
  const token = generateToken('public')
  assert(token.startsWith('sci_p_'), 'public token prefix wrong')
})

// ── Summary ───────────────────────────────────────────────────────────────────

await adapter.disconnect()

console.log(`\n${'─'.repeat(40)}`)
console.log(`  ${passed + failed} tests  ·  ${passed} passed  ·  ${failed} failed`)
console.log(`${'─'.repeat(40)}\n`)
if (failed > 0) process.exit(1)
