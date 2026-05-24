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
  rpsLimit?: number
  burst?: number
  enabled?: boolean
  /** Env var prefix. Default for Sci: 'SCI_RATE_LIMIT'. Set null to ignore env vars. */
  envPrefix?: string | null
  log?: boolean
}

export class RateLimiter {
  private tokens: number
  private lastRefill: number
  private readonly rpsLimit: number
  private readonly burst: number
  private readonly enabled: boolean
  private readonly log: boolean

  constructor(options: RateLimiterOptions = {}) {
    const prefix = options.envPrefix !== undefined ? options.envPrefix : 'SCI_RATE_LIMIT'
    const env = (key: string): string | undefined =>
      prefix != null ? process.env[`${prefix}_${key}`] : undefined

    const rpsLimit = options.rpsLimit ?? parseFloat(env('RPS') ?? '10')
    const burst = options.burst ?? (parseInt(env('BURST') ?? '', 10) || rpsLimit)
    const enabled = options.enabled ?? env('ENABLED') !== 'false'
    const log = options.log ?? env('LOG') === 'true'

    this.rpsLimit = rpsLimit
    this.burst = burst
    this.enabled = enabled
    this.log = log
    this.tokens = burst
    this.lastRefill = Date.now()

    if (this.log && this.enabled) {
      console.log(`[rate-limiter] enabled: ${this.rpsLimit} RPS, burst: ${this.burst}`)
    }
  }

  private refillBucket(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    const added = elapsed * this.rpsLimit
    this.tokens = Math.min(this.burst, this.tokens + added)
    this.lastRefill = now
  }

  /** Block until a token is available, then consume it. */
  async acquire(): Promise<void> {
    if (!this.enabled) return

    this.refillBucket()
    if (this.tokens >= 1) {
      this.tokens -= 1
      if (this.log) {
        console.log(`[rate-limiter] acquired, tokens left: ${Math.floor(this.tokens)}`)
      }
      return
    }

    const tokensNeeded = 1 - this.tokens
    const waitMs = (tokensNeeded / this.rpsLimit) * 1000
    if (this.log) {
      console.log(`[rate-limiter] waiting ${waitMs.toFixed(0)}ms for token`)
    }
    await new Promise(resolve => setTimeout(resolve, waitMs))
    this.refillBucket()
    this.tokens -= 1
  }

  /** Non-blocking: consume a token if available, return false if not. */
  tryAcquire(): boolean {
    if (!this.enabled) return true
    this.refillBucket()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }

  /** Current limiter state (for debugging). */
  getStatus(): { tokens: number; rpsLimit: number; burst: number; enabled: boolean } {
    this.refillBucket()
    return { tokens: this.tokens, rpsLimit: this.rpsLimit, burst: this.burst, enabled: this.enabled }
  }
}

/** Wrap a fetch function to apply rate limiting before every request. */
export function rateLimitFetch(
  fetchFn: typeof globalThis.fetch,
  limiter: RateLimiter
): typeof globalThis.fetch {
  return async (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
    await limiter.acquire()
    return fetchFn(...args)
  }
}

let _globalLimiter: RateLimiter | null = null

export function getGlobalLimiter(options?: RateLimiterOptions): RateLimiter {
  if (!_globalLimiter) _globalLimiter = new RateLimiter(options)
  return _globalLimiter
}
