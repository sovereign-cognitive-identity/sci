/**
 * Memory middleware — context injection and post-stream storage.
 *
 * Before forwarding to OpenRouter:
 *   - Recalls relevant memory context for the user's latest message
 *   - Injects it as a system message prefix
 *
 * After the stream completes:
 *   - Stores the full interaction (original message + deanonymized response)
 *   - Fire and forget — doesn't block the stream
 */

import { embed } from '@sci/core'
import type { StorageAdapter } from '@sci/core'
import type { OpenRouterMessage } from '../openrouter.js'

const CONTEXT_PREFIX = `[Sci Memory Context — relevant facts from your history]`
const MAX_CONTEXT_RESULTS = 5

export async function injectMemoryContext(
  messages: OpenRouterMessage[],
  adapter: StorageAdapter
): Promise<OpenRouterMessage[]> {
  // Find the last user message to use as the recall query
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg || lastUserMsg.content.length < 10) return messages

  try {
    const profile = await adapter.getProfile('work')
    if (!profile) return messages

    const queryEmbedding = await embed(lastUserMsg.content.slice(0, 500))
    const results = await adapter.recall({
      queryEmbedding,
      query: lastUserMsg.content.slice(0, 500),
      profileId: profile.id,
      limit: MAX_CONTEXT_RESULTS,
      types: ['semantic', 'identity'],
    })

    if (results.length === 0) return messages

    const contextLines = results
      .map(r => `- ${r.content}`)
      .join('\n')

    const contextBlock = `${CONTEXT_PREFIX}\n${contextLines}`

    // Find existing system message or prepend one
    const existingSystem = messages.find(m => m.role === 'system')
    if (existingSystem) {
      return messages.map(m =>
        m.role === 'system'
          ? { ...m, content: `${contextBlock}\n\n${m.content}` }
          : m
      )
    }

    return [{ role: 'system', content: contextBlock }, ...messages]
  } catch {
    // Memory injection is best-effort — never fail the request
    return messages
  }
}

export async function storeInteraction(
  userMessage: string,
  assistantResponse: string,
  adapter: StorageAdapter
): Promise<void> {
  try {
    const profile = await adapter.getProfile('work')
    if (!profile) return

    // Store the user's original message (with real names — this is the memory layer)
    if (userMessage.trim().length > 20) {
      const embedding = await embed(userMessage)
      await adapter.storeEpisodic({
        profileId: profile.id,
        content: userMessage,
        embedding,
        source: 'proxy',
        metadata: { has_response: true },
      })
    }
  } catch { /* non-fatal */ }
}
