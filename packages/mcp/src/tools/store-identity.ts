import { helperStoreIdentity } from '../helper.js'

export async function memoryStoreIdentity(args: {
  content: string
  category?: string
  confidence?: number
}) {
  return helperStoreIdentity({
    content:    args.content,
    category:   args.category,
    confidence: args.confidence ?? 1.0,
  })
}
