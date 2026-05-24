/**
 * HTTP rate limiter using token bucket algorithm.
 *
 * Environment variables:
 *   SCI_RATE_LIMIT_RPS     — requests per second (default: 10)
 *   SCI_RATE_LIMIT_BURST   — burst capacity in tokens (default: RPS)
 *   SCI_RATE_LIMIT_ENABLED — set to "false" to disable (default: "true")
 *
 * Usage:
 *   const limiter = new RateLimiter()
 *   await limiter.acquire()  // blocks until token available
 *   // make HTTP request
 */
interface Config {
    rpsLimit: number;
    burst: number;
    enabled: boolean;
}
export declare class RateLimiter {
    private tokens;
    private lastRefill;
    private config;
    private readonly log;
    constructor(config?: Partial<Config>);
    /**
     * Refill tokens based on elapsed time since last refill.
     * Token generation rate = rpsLimit tokens/second.
     */
    private refillBucket;
    /**
     * Block until a token is available, then consume it.
     * If rate limiting is disabled, returns immediately.
     */
    acquire(): Promise<void>;
    /**
     * Non-blocking check. Returns true if a token is available without waiting.
     */
    tryAcquire(): boolean;
    /**
     * Get current token count (for debugging).
     */
    getStatus(): {
        tokens: number;
        rpsLimit: number;
        burst: number;
        enabled: boolean;
    };
}
/**
 * Wrap fetch to apply rate limiting.
 *
 * Usage:
 *   const limiter = new RateLimiter()
 *   const limitedFetch = rateLimitFetch(fetch, limiter)
 *   await limitedFetch('https://api.example.com/endpoint')
 */
export declare function rateLimitFetch(fetchFn: typeof global.fetch, limiter: RateLimiter): typeof global.fetch;
export declare function getGlobalLimiter(): RateLimiter;
export {};
//# sourceMappingURL=rate-limiter.d.ts.map