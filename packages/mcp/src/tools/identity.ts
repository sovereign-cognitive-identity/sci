import { embed } from '@sci/core'
import type { StorageAdapter } from '@sci/core'

export async function memoryIdentity(
  args: {
    query?: string
    category?: string
    limit?: number
  },
  adapter: StorageAdapter
) {
  const limit = args.limit ?? 20

  const facts = await adapter.queryIdentityFacts({
    query: args.query,
    queryEmbedding: args.query ? await embed(args.query) : undefined,
    category: args.category,
    limit,
  })

  return { facts }
}
