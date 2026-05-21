/**
 * Direct Anthropic forwarding — preserves your claude.ai subscription.
 *
 * In 'direct' mode the proxy:
 *   1. Anonymizes messages
 *   2. Injects memory context
 *   3. Forwards to api.anthropic.com with the ORIGINAL Authorization header
 *   4. Streams back Anthropic SSE, deanonymizes text deltas on the fly
 *   5. Stores interaction to memory
 *
 * No OpenRouter involved. Your subscription usage counts normally.
 * You lose multi-model routing — everything stays on the Claude model requested.
 */
/** Async generator of text deltas from a direct Anthropic SSE stream. */
export declare function streamFromAnthropic(path: string, body: unknown, originalHeaders: Record<string, string>): AsyncGenerator<string>;
/**
 * Re-stream a direct Anthropic response as Anthropic SSE with deanonymization.
 *
 * `extra.prelude` is emitted as raw SSE bytes BEFORE message_start. We use
 * this to surface Sci-specific transparency events (`sci.anonymized`, etc.)
 * that downstream Anthropic-compatible clients ignore. Standards-compliant
 * SSE parsers skip events whose `event:` name they don't recognise.
 *
 * `extra.postlude` is called once the deanonymizer has fully drained — its
 * return value is emitted before content_block_stop. This is where we put
 * `sci.deanonymized` since the replacement counts only exist after the
 * stream completes.
 */
export declare function streamDirectAnthropic(path: string, requestBody: unknown, originalHeaders: Record<string, string>, deanonPush: (text: string) => string, deanonEnd: () => string, onComplete: () => void, extra?: {
    prelude?: string;
    postlude?: () => string;
}): Promise<ReadableStream>;
//# sourceMappingURL=direct-anthropic.d.ts.map