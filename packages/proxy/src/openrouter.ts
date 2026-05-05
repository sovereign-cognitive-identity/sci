/**
 * OpenRouter client — streams responses back as an async generator of text deltas.
 *
 * All models (Claude, GPT-4, Gemini, etc.) are accessed via OpenRouter's
 * OpenAI-compatible API. The proxy translates Anthropic/OpenAI client formats
 * to OpenAI format here, and translates responses back in the handlers.
 */

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OpenRouterRequest {
  model: string
  messages: OpenRouterMessage[]
  max_tokens?: number
  temperature?: number
  stream: true
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export async function* streamFromOpenRouter(
  req: OpenRouterRequest,
  apiKey: string
): AsyncGenerator<string> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/sovereign-cognitive-identity/sci',
      'X-Title': 'Sci Proxy',
    },
    body: JSON.stringify(req),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenRouter ${response.status}: ${err}`)
  }

  if (!response.body) throw new Error('No response body from OpenRouter')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // Process complete SSE lines
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''  // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === ':') continue          // heartbeat/empty
      if (trimmed === 'data: [DONE]') return            // stream complete

      if (trimmed.startsWith('data: ')) {
        const jsonStr = trimmed.slice(6)
        try {
          const chunk = JSON.parse(jsonStr) as {
            choices?: Array<{
              delta?: { content?: string | null }
              finish_reason?: string | null
            }>
          }
          const delta = chunk.choices?.[0]?.delta?.content
          if (delta) yield delta
        } catch { /* skip malformed chunks */ }
      }
    }
  }

  // Flush any remaining buffer content
  if (buffer.trim() && buffer.trim() !== 'data: [DONE]') {
    const jsonStr = buffer.trim().startsWith('data: ')
      ? buffer.trim().slice(6)
      : buffer.trim()
    try {
      const chunk = JSON.parse(jsonStr) as { choices?: Array<{ delta?: { content?: string } }> }
      const delta = chunk.choices?.[0]?.delta?.content
      if (delta) yield delta
    } catch { /* ignore */ }
  }
}
