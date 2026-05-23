import { helperRecall } from '../helper.js'

type MemoryType = 'episodic' | 'semantic' | 'identity'

export async function memoryRecall(args: {
  query: string
  profile?: string
  limit?: number
  memory_types?: MemoryType[]
}) {
  const results = await helperRecall(args.query, args.profile ?? 'work', args.limit ?? 10)
  const filtered = args.memory_types
    ? results.filter(r => args.memory_types!.includes(r.type))
    : results
  return { results: filtered }
}
