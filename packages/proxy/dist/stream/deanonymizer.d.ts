/**
 * DeanonymizingStream — sliding window SSE deanonymizer.
 *
 * The AI responds using tokens like [PERSON_1], [EMAIL_2].
 * These tokens may arrive split across SSE chunks:
 *   chunk 1: "Hello [PER"
 *   chunk 2: "SON_1] how"
 *
 * Algorithm:
 *   1. Append incoming text to buffer
 *   2. Find the last '[' that might start an incomplete token
 *   3. Flush everything before it (deanonymized) — safe to stream
 *   4. Hold the potential partial token
 *   5. On stream end, flush and deanonymize everything remaining
 *
 * Token pattern: [UPPERCASE_DIGITS] e.g. [PERSON_1], [EMAIL_3], [PROJECT_12]
 * Max token length: ~16 chars — the hold zone is never more than that.
 */
import type { TokenMap } from '@sci/core';
export declare class DeanonymizingStream {
    private buffer;
    private accumulated;
    private readonly tokenMap;
    constructor(tokenMap: TokenMap);
    /**
     * Process an incoming text delta from the stream.
     * Returns text safe to forward to the client immediately.
     */
    push(text: string): string;
    /**
     * Called at end of stream. Flushes and deanonymizes everything remaining.
     */
    end(): string;
    /** Full deanonymized response — for memory storage after stream completes. */
    get fullResponse(): string;
    private _flush;
    private _deanonymize;
}
export declare class DeanonymizingStreamV2 {
    private buffer;
    private _fullResponse;
    private readonly tokenMap;
    private _replacementCount;
    private readonly _replacedTokens;
    constructor(tokenMap: TokenMap);
    push(text: string): string;
    end(): string;
    get fullResponse(): string;
    /** Total token replacements performed across the stream. */
    get replacementCount(): number;
    /**
     * Distinct masked tokens that appeared in the upstream response and
     * were swapped back to their real values, with occurrence counts.
     */
    get replacedTokens(): Array<{
        token: string;
        original: string;
        count: number;
    }>;
    private _tryFlush;
    private _applyMap;
}
//# sourceMappingURL=deanonymizer.d.ts.map