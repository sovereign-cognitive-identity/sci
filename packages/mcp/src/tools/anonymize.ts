import {
  anonymizeWithSessionAsync,
  deanonymizeWithSession,
  createSession,
  discardSession,
  describeTokenMap,
  getSession,
  drainPendingPromotions,
} from '@sci/core'
import { embed } from '@sci/core'
import type { StorageAdapter } from '@sci/core'

export async function messageAnonymize(
  args: { text: string; session_id?: string },
  adapter: StorageAdapter
): Promise<Record<string, unknown>> {
  const sessionId = args.session_id ?? createSession()
  const result = await anonymizeWithSessionAsync(args.text, sessionId, adapter)

  // Progressive promotion — store newly discovered entities in identity_facts
  const promoted: string[] = []
  const pending = drainPendingPromotions()
  if (pending.length > 0) {
    for (const entity of pending) {
      try {
        const embedding = await embed(
          `The user frequently mentions "${entity.text}" — auto-promoted by anonymizer.`
        )
        await adapter.storeIdentityFact({
          content: `The user frequently mentions "${entity.text}" — auto-promoted by anonymizer.`,
          embedding,
          category: 'project',
          confidence: 0.6,
        })
        promoted.push(entity.text)
      } catch { /* non-fatal */ }
    }
  }

  return {
    text: result.text,
    session_id: sessionId,
    entities_masked: result.detected.length,
    token_map_summary: describeTokenMap(result.tokenMap),
    by_type: result.detected.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1
      return acc
    }, {}),
    ...(promoted.length > 0 ? { auto_promoted: promoted } : {}),
  }
}

export function messageDeanonymize(args: {
  text: string
  session_id: string
  discard_session?: boolean
}) {
  const restored = deanonymizeWithSession(args.text, args.session_id)
  if (args.discard_session) discardSession(args.session_id)
  return { text: restored }
}

export function sessionInspect(args: { session_id: string }) {
  const tokenMap = getSession(args.session_id)
  if (!tokenMap) return { found: false, entities: [] }
  return {
    found: true,
    entities: [...tokenMap.forward.entries()].map(([entity, token]) => ({ entity, token })),
  }
}
