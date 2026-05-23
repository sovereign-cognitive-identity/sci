import { helperStoreEpisodic } from '../helper.js'

export async function memoryStore(args: {
  content: string
  profile?: string
  source?: string
  metadata?: Record<string, unknown>
}) {
  return helperStoreEpisodic({
    content:  args.content,
    profile:  args.profile ?? 'work',
    source:   args.source ?? 'claude',
    metadata: args.metadata,
  })
}
