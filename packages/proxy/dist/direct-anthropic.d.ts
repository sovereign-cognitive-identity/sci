/**
 * Direct Anthropic forwarding — preserves your claude.ai subscription.
 *
 * In 'direct' mode the proxy:
 *   1. Anonymizes messages
 *   2. Injects memory context
 *   3. Forwards to api.anthropic.com with the ORIGINAL Authorization header
 *   4. Streams back Anthropic SSE verbatim, patching only text_delta events
 *      to deanonymize
 *   5. Stores interaction to memory
 *
 * No OpenRouter involved. Your subscription usage counts normally.
 * You lose multi-model routing — everything stays on the Claude model requested.
 */
import http2 from 'http2';
export declare function getH2Client(): http2.ClientHttp2Session;
/** Async generator of text deltas from a direct Anthropic SSE stream. */
export declare function streamFromAnthropic(path: string, body: unknown, originalHeaders: Record<string, string>): AsyncGenerator<string>;
/**
 * Re-stream a direct Anthropic response as Anthropic SSE with deanonymization.
 *
 * Passes through the raw Anthropic SSE stream verbatim, only patching
 * `content_block_delta` events with `text_delta` type to deanonymize text.
 * All other events (tool_use, input_json_delta, message_start with real IDs,
 * token counts, stop_reason, etc.) are forwarded unchanged.
 *
 * On upstream error (4xx/5xx) returns a Response with the actual HTTP status
 * so the SDK can parse it correctly. The SDK chokes on `event: error` carried
 * inside an HTTP 200 body.
 *
 * `extra.prelude` is emitted BEFORE the first Anthropic event.
 * `extra.postlude` is emitted AFTER message_stop.
 */
export declare function streamDirectAnthropic(path: string, requestBody: unknown, originalHeaders: Record<string, string>, deanonPush: (text: string) => string | undefined, deanonEnd: () => string | undefined, onComplete: () => void, extra?: {
    prelude?: string;
    postlude?: () => string;
}): Promise<ReadableStream | Response>;
//# sourceMappingURL=direct-anthropic.d.ts.map