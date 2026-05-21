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
import type { StorageAdapter, TokenMap } from '@sci/core';
import type { OpenRouterMessage } from '../openrouter.js';
/**
 * Inspector telemetry for the memory injection step. Surfaced to the UI as
 * the `sci.memory` SSE event so users can see what was recalled and what
 * actually made it into the system prompt.
 */
export interface MemoryInspectorData {
    /** The text fed into the recall (truncated to 500 chars). */
    query: string;
    /** Top-N results from `adapter.recall()`. */
    results: Array<{
        id: string;
        type: 'episodic' | 'semantic' | 'identity';
        content: string;
        score: number;
    }>;
    /** Whether anything was actually prepended to the system prompt. */
    injected: boolean;
    /** The exact text added to the system prompt (or null if nothing). */
    contextBlock: string | null;
    /** Rough token count of the injected block (chars / 4 heuristic). */
    approxTokensAdded: number;
    /** Recall config for transparency. */
    config: {
        limit: number;
        types: string[];
    };
}
export interface InjectMemoryResult {
    messages: OpenRouterMessage[];
    /** null when injection couldn't run (no profile, message too short, error). */
    inspector: MemoryInspectorData | null;
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
export declare function injectMemoryContext(messages: OpenRouterMessage[], adapter: StorageAdapter, sessionTokenMap?: TokenMap): Promise<InjectMemoryResult>;
export declare function storeInteraction(userMessage: string, assistantResponse: string, adapter: StorageAdapter): Promise<void>;
//# sourceMappingURL=memory.d.ts.map