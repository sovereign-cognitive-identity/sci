import { embed } from '@sci/core'
import type { StorageAdapter } from '@sci/core'

export async function memoryStore(
  args: {
    content: string
    profile?: string
    source?: string
    metadata?: Record<string, unknown>
    _profileId?: string  // pre-resolved by auth middleware
  },
  adapter: StorageAdapter
) {
  let profileId = args._profileId
  if (!profileId) {
    const profileName = args.profile ?? 'work'
    const profile = await adapter.getProfile(profileName)
    if (!profile) throw new Error(`Profile not found: ${profileName}`)
    profileId = profile.id
  }

  const embedding = await embed(args.content)

  const { id } = await adapter.storeEpisodic({
    profileId,
    content: args.content,
    embedding,
    source: args.source ?? 'claude',
    metadata: args.metadata,
  })

  await adapter.recordWrite('store_episodic', { id, profile: args.profile ?? 'work' })
  return { id, stored: true }
}
