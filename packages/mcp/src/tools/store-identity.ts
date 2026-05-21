import { embed } from '@sci/core'
import type { StorageAdapter } from '@sci/core'

export async function memoryStoreIdentity(
  args: {
    content: string
    category?: string
    confidence?: number
  },
  adapter: StorageAdapter
) {
  const embedding = await embed(args.content)
  const { id } = await adapter.storeIdentityFact({
    content: args.content,
    embedding,
    category: args.category,
    confidence: args.confidence ?? 1.0,
  })
  return { id, stored: true }
}
