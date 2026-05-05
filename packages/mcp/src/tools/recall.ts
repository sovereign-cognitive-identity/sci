import { embed } from '@sci/core'
import type { StorageAdapter } from '@sci/core'

type MemoryType = 'episodic' | 'semantic' | 'identity'

export async function memoryRecall(
  args: {
    query: string
    profile?: string
    limit?: number
    memory_types?: MemoryType[]
  },
  adapter: StorageAdapter
) {
  const profileName = args.profile ?? 'work'
  const profile = await adapter.getProfile(profileName)
  if (!profile) throw new Error(`Profile not found: ${profileName}`)

  const queryEmbedding = await embed(args.query)

  const results = await adapter.recall({
    queryEmbedding,
    query: args.query,
    profileId: profile.id,
    limit: args.limit ?? 10,
    types: args.memory_types ?? ['episodic', 'semantic', 'identity'],
  })

  return { results }
}
