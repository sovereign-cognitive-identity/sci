/**
 * Nightly consolidation entry point — Phase 4
 * Now uses StorageAdapter — works with all backends (local, dropbox, s3, icloud).
 */
import { createStorageAdapter } from './storage/index.js'
import { runDecayPass } from './decay.js'
import { runPromotionPass, runGraphPass } from './consolidator.js'
import { runDigestPass } from './digest.js'

const OPENROUTER_KEY = requireEnv('SCI_OPENROUTER_KEY')
const MODEL = process.env['SCI_CONSOLIDATION_MODEL'] ?? 'google/gemini-2.5-flash-lite'
const WINDOW_DAYS = parseInt(process.env['SCI_CONSOLIDATION_WINDOW_DAYS'] ?? '1')

async function run() {
  const startTime = Date.now()
  console.log(`\n🌙 Sci Nightly Consolidation`)
  console.log(`   Model: ${MODEL}`)

  const adapter = await createStorageAdapter()

  const windowEnd = new Date()
  const lastRun = await adapter.getLastConsolidationRun()
  const windowStart = lastRun
    ? new Date(Math.min(lastRun.getTime(), windowEnd.getTime() - WINDOW_DAYS * 86400_000))
    : new Date(windowEnd.getTime() - WINDOW_DAYS * 86400_000)

  console.log(`   Window: ${windowStart.toISOString().slice(0, 16)} → ${windowEnd.toISOString().slice(0, 16)}`)

  const profiles = await adapter.getProfiles()
  console.log(`   Profiles: ${profiles.map(p => p.name).join(', ')}\n`)

  let totalPromoted = 0, totalReinforced = 0, totalDecayed = 0, totalEdges = 0

  console.log('── Job 1: Episodic → Semantic promotion')
  for (const profile of profiles) {
    process.stdout.write(`  [${profile.name}] `)
    const result = await runPromotionPass(windowStart, windowEnd, profile.id, OPENROUTER_KEY, MODEL, adapter)
    if (result.batches === 0) console.log('no new memories in window')
    else console.log(`${result.promoted} promoted, ${result.reinforced} reinforced across ${result.batches} batches`)
    totalPromoted += result.promoted
    totalReinforced += result.reinforced
  }

  console.log('\n── Job 2: Ebbinghaus decay pass')
  const decayResult = await runDecayPass(adapter)
  console.log(`  ${decayResult.summary}`)
  totalDecayed = decayResult.flagged

  console.log('\n── Job 3: Knowledge graph')
  for (const profile of profiles) {
    const graphResult = await runGraphPass(profile.id, OPENROUTER_KEY, MODEL, adapter)
    console.log(`  [${profile.name}] ${graphResult.edges_created} edges created`)
    totalEdges += graphResult.edges_created
  }

  console.log('\n── Job 4: Nightly digest')
  const episodicNew = await adapter.countEpisodicMemoriesInWindow(windowStart, windowEnd)
  const digestResult = await runDigestPass(
    windowStart, windowEnd, profiles[0]!.id,
    { episodic_new: episodicNew, semantic_promoted: totalPromoted,
      semantic_reinforced: totalReinforced, nodes_decayed: totalDecayed },
    OPENROUTER_KEY, MODEL, adapter
  )
  console.log(`  Stored: ${digestResult.memory_id ?? 'failed'}`)
  if (digestResult.exported_to) console.log(`  Exported: ${digestResult.exported_to}`)

  const duration = Date.now() - startTime
  await adapter.recordConsolidationRun({
    windowStart, windowEnd,
    episodicProcessed: episodicNew,
    semanticPromoted: totalPromoted,
    semanticReinforced: totalReinforced,
    nodesDecayed: totalDecayed,
    digestId: digestResult.memory_id ?? undefined,
    modelUsed: MODEL,
    durationMs: duration,
  })

  console.log(`\n✓ Consolidation complete in ${(duration / 1000).toFixed(1)}s`)
  console.log(`  promoted: ${totalPromoted} | reinforced: ${totalReinforced} | edges: ${totalEdges} | decayed: ${totalDecayed}`)

  if (digestResult.markdown) {
    console.log('\n── Digest preview ──')
    console.log(digestResult.markdown.split('\n').slice(0, 12).join('\n'))
  }

  await adapter.disconnect()
}

run()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Fatal:', err)
    process.exit(1)
  })

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}
