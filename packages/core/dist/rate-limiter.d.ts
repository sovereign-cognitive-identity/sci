/**
 * HTTP rate limiter — token bucket algorithm.
 *
 * This is Sci's local copy of @caseyzandbergen/rate-limiter.
 * Source of truth: ~/src/rate-limiter
 *
 * Sci-specific defaults: envPrefix = 'SCI_RATE_LIMIT'
 *
 * Environment variables (Sci defaults):
 *   SCI_RATE_LIMIT_RPS     — requests per second (default: 10)
 *   SCI_RATE_LIMIT_BURST   — burst capacity in tokens (default: RPS)
 *   SCI_RATE_LIMIT_ENABLED — set to "false" to disable (default: "true")
 *   SCI_RATE_LIMIT_LOG     — set to "true" to enable logging
 */
export interface RateLimiterOptions {
    rpsLimit?: number;
    burst?: number;
    enabled?: boolean;
    /** Env var prefix. Default for Sci: 'SCI_RATE_LIMIT'. Set null to ignore env vars. */
    envPrefix?: string | null;
    log?: boolean;
}
export declare class RateLimiter {
    private tokens;
    private lastRefill;
    private readonly rpsLimit;
    private readonly burst;
    private readonly enabled;
    private readonly log;
    constructor(options?: RateLimiterOptions);
    private refillBucket;
    /** Block until a token is available, then consume it. */
    acquire(): Promise<void>;
    /** Non-blocking: consume a token if available, return false if not. */
    tryAcquire(): boolean;
    /** Current limiter state (for debugging). */
    getStatus(): {
        tokens: number;
        rpsLimit: number;
        burst: number;
        enabled: boolean;
    };
}
/** Wrap a fetch function to apply rate limiting before every request. */
export declare function rateLimitFetch(fetchFn: typeof globalThis.fetch, limiter: RateLimiter): typeof globalThis.fetch;
export declare function getGlobalLimiter(options?: RateLimiterOptions): RateLimiter;
//# sourceMappingURL=rate-limiter.d.ts.map