import { helperIdentity } from '../helper.js'

export async function memoryIdentity(args: {
  query?: string
  category?: string
  limit?: number
}) {
  const facts = await helperIdentity({
    query:    args.query,
    category: args.category,
    limit:    args.limit ?? 20,
  })
  return { facts }
}
