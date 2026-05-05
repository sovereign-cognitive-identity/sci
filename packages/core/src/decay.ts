import type { StorageAdapter } from './storage/interface.js'

const DECAY_FLAG_THRESHOLD = 0.15

export interface DecayResult {
  updated: number
  flagged: number
  summary: string
}

export function calculateDecay(
  confidence: number,
  accessCount: number,
  lastAccessedAt: Date,
  now = new Date()
): number {
  const daysSinceAccess = (now.getTime() - lastAccessedAt.getTime()) / (1000 * 60 * 60 * 24)
  const stability = 1 + accessCount * 0.5
  const retention = Math.exp(-daysSinceAccess / stability)
  return Math.max(0, confidence * retention)
}

export async function runDecayPass(adapter: StorageAdapter): Promise<DecayResult> {
  const now = new Date()
  const profiles = await adapter.getProfiles()
  let updated = 0
  let flagged = 0

  for (const profile of profiles) {
    const nodes = await adapter.getSemanticNodes(profile.id, {})
    for (const node of nodes) {
      const newScore = calculateDecay(
        node.confidence,
        node.access_count,
        new Date(node.last_accessed_at),
        now
      )
      const nowFlagged = newScore < DECAY_FLAG_THRESHOLD
      const wasFlagged = node.decay_score < DECAY_FLAG_THRESHOLD
      await adapter.updateDecayScore(node.id, newScore, nowFlagged)
      updated++
      if (nowFlagged && !wasFlagged) flagged++
    }
  }

  return {
    updated,
    flagged,
    summary: `Decay pass: ${updated} nodes updated, ${flagged} newly flagged (score < ${DECAY_FLAG_THRESHOLD})`,
  }
}
