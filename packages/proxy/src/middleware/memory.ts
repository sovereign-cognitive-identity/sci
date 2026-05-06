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

import { embed, anonymize } from '@sci/core'
import type { StorageAdapter, TokenMap } from '@sci/core'
import type { OpenRouterMessage } from '../openrouter.js'

// Framing for the injected memory block. Explicit role attribution so the
// model can correctly extract user facts vs. interpret things as questions
// or past assistant denials.
//
// Sci anonymizes recalled content before injection, so every entity (names,
// emails, phones, etc.) becomes a `[TYPE_n]` token. The suffix tells the
// model how to handle the tokens. We deliberately do NOT explain the
// substitution mechanism — earlier versions did, and the model used that
// knowledge to write meta-explanations like "I can see a masked token but
// the system should substitute…", which leak through as awkward, hedging
// answers. Treat the tokens as if they were the real names; never mention
// them; the deanonymizer handles the rest invisibly.
const CONTEXT_PREFIX = `[Sci Memory — excerpts from this user's prior messages, surfaced by relevance]`
const CONTEXT_SUFFIX = `Use these as authoritative information about the user when relevant.

Token handling: tokens of the form [PERSON_n], [EMAIL_n], [PHONE_n], [PLACE_n], [ORG_n], [PROJECT_n], [URL_n], and [HANDLE_n] are valid identifiers for real entities — treat them as you would the real names. Answer questions about them directly using the same tokens (e.g. "Your name is [PERSON_1]"). Do NOT describe them as masked, redacted, placeholder, or template text. Do NOT explain the tokens or apologize for using them. Do NOT comment on the privacy mechanism. Just answer the question naturally.`
// Final number of unique memories injected.
const MAX_CONTEXT_RESULTS = 5
// Recall fetches more than we'll inject, so dedup + self-filter still leaves
// us with a useful set even when there are many near-duplicate episodics
// (e.g. the same question asked across many sessions).
const RECALL_FETCH_LIMIT  = 25

/**
 * Inspector telemetry for the memory injection step. Surfaced to the UI as
 * the `sci.memory` SSE event so users can see what was recalled and what
 * actually made it into the system prompt.
 */
export interface MemoryInspectorData {
  /** The text fed into the recall (truncated to 500 chars). */
  query: string
  /** Top-N results from `adapter.recall()`. */
  results: Array<{
    id: string
    type: 'episodic' | 'semantic' | 'identity'
    content: string
    score: number
  }>
  /** Whether anything was actually prepended to the system prompt. */
  injected: boolean
  /** The exact text added to the system prompt (or null if nothing). */
  contextBlock: string | null
  /** Rough token count of the injected block (chars / 4 heuristic). */
  approxTokensAdded: number
  /** Recall config for transparency. */
  config: { limit: number; types: string[] }
}

export interface InjectMemoryResult {
  messages: OpenRouterMessage[]
  /** null when injection couldn't run (no profile, message too short, error). */
  inspector: MemoryInspectorData | null
}

/**
 * Build the system-prompt prefix from recalled memory and prepend it to the
 * messages array.
 *
 * @param sessionTokenMap  REQUIRED for privacy. The memory layer stores raw,
 *   unmasked content (so recall actually works). Before injection, every
 *   recalled excerpt is run through `anonymize()` using this same session
 *   token map — so memories ride upstream as `<NAME_n>` tokens consistent
 *   with the rest of the request, and the deanonymizer can swap them back
 *   on the response. The map is mutated in place; the caller's reference
 *   continues to track all entities seen this turn.
 *
 *   If you call this without a token map, recalled memory will be sent
 *   upstream UNMASKED — which leaks names that were anonymized in the user
 *   message. Don't do that. (Optional only because OpenRouter's BYOK path
 *   doesn't currently surface inspector data; we accept the leak there for
 *   now and will lock it down when that path matters.)
 */
export async function injectMemoryContext(
  messages: OpenRouterMessage[],
  adapter: StorageAdapter,
  sessionTokenMap?: TokenMap
): Promise<InjectMemoryResult> {
  // Find the last user message to use as the recall query
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg || lastUserMsg.content.length < 10) {
    return { messages, inspector: null }
  }

  try {
    const profile = await adapter.getProfile('work')
    if (!profile) return { messages, inspector: null }

    const query = lastUserMsg.content.slice(0, 500)
    const queryEmbedding = await embed(query)
    // Include episodic so chat history surfaces in the inspector. Otherwise
    // a question like "what did I tell you my name was" recalls nothing
    // useful — the answer is in episodic_memories (full chat turns), not
    // in semantic/identity (which only get populated by the consolidator).
    const recallTypes: Array<'episodic' | 'semantic' | 'identity'> = ['semantic', 'identity', 'episodic']
    const rawResults = await adapter.recall({
      queryEmbedding,
      query,
      profileId: profile.id,
      limit: RECALL_FETCH_LIMIT,
      types: recallTypes,
    })

    // Filter + dedupe before injecting:
    //
    //   1. Drop assistant-role episodics. They're past responses, not user
    //      facts. Worse, they sometimes include hedges like "I don't have
    //      that info" which actively contradict newer user statements.
    //   2. Dedupe by normalized content (cross-session question repeats).
    //   3. Drop exact echoes of the current message.
    const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')
    const queryKey  = normalize(query)
    const seen      = new Set<string>()
    const filtered: typeof rawResults = []
    for (const r of rawResults) {
      // Episodic memories from sci-ui carry role in metadata; only keep user-
      // role turns. Semantic / identity items have no role and pass through.
      if (r.type === 'episodic') {
        const role = (r.metadata?.['role'] as string | undefined) ?? null
        if (role && role !== 'user') continue
      }
      const key = normalize(r.content)
      if (key === queryKey)  continue
      if (seen.has(key))     continue
      seen.add(key)
      filtered.push(r)
      if (filtered.length >= MAX_CONTEXT_RESULTS) break
    }
    const results = filtered

    const inspector: MemoryInspectorData = {
      query,
      results: results.map((r) => ({
        id:      r.id,
        type:    r.type,
        content: r.content,
        score:   r.score,
      })),
      injected:          false,
      contextBlock:      null,
      approxTokensAdded: 0,
      config:            { limit: MAX_CONTEXT_RESULTS, types: recallTypes },
    }

    if (results.length === 0) {
      return { messages, inspector }
    }

    // ── Anonymize before injection ─────────────────────────────────────────
    //
    // Memory stores raw user text so future recall works on real names.
    // But that text is about to enter the system prompt and ride upstream —
    // it MUST be masked using the same session token map as the rest of the
    // request, otherwise the names the anonymizer scrubbed from the user
    // message would leak through the memory channel.
    //
    // The `anonymize` call mutates `sessionTokenMap` in place — so any new
    // entities discovered in memories are added to the map, and the
    // deanonymizer at the end of the request will swap them back in the
    // response. This is the entire reason `sessionTokenMap` is threaded in.
    const anonymizedResults = sessionTokenMap
      ? results.map((r) => ({
          ...r,
          content: anonymize(r.content, sessionTokenMap).text,
        }))
      : results

    // Each line tagged with how the user phrased it (statement vs question).
    // Helps the model distinguish "the user told us X" from "the user asked X".
    const isQuestion = (s: string): boolean => /\?\s*$/.test(s.trim())
    const contextLines = anonymizedResults
      .map((r) => {
        const tag = r.type === 'episodic'
          ? (isQuestion(r.content) ? '(user previously asked)' : '(user previously said)')
          : `(${r.type})`
        return `- ${tag}: ${r.content}`
      })
      .join('\n')
    const contextBlock = `${CONTEXT_PREFIX}\n${contextLines}\n\n${CONTEXT_SUFFIX}`
    inspector.injected          = true
    inspector.contextBlock      = contextBlock
    inspector.approxTokensAdded = Math.ceil(contextBlock.length / 4)

    // Find existing system message or prepend one
    const existingSystem = messages.find(m => m.role === 'system')
    if (existingSystem) {
      return {
        messages: messages.map(m =>
          m.role === 'system'
            ? { ...m, content: `${contextBlock}\n\n${m.content}` }
            : m
        ),
        inspector,
      }
    }

    return {
      messages: [{ role: 'system', content: contextBlock }, ...messages],
      inspector,
    }
  } catch {
    // Memory injection is best-effort — never fail the request
    return { messages, inspector: null }
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
