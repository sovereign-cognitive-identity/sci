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
  rpsLimit: number  // tokens per second
  burst: number     // max tokens in bucket
  enabled: boolean
}

export class RateLimiter {
  private tokens: number
  private lastRefill: number
  private config: Config
  private readonly log = process.env['SCI_LOG_RATELIMIT'] === 'true'

  constructor(config?: Partial<Config>) {
    this.config = {
      rpsLimit: parseFloat(process.env['SCI_RATE_LIMIT_RPS'] ?? '10'),
      burst: parseInt(process.env['SCI_RATE_LIMIT_BURST'] ?? '', 10),
      enabled: process.env['SCI_RATE_LIMIT_ENABLED'] !== 'false',
    }
    // Default burst = RPS if not specified
    if (!this.config.burst) this.config.burst = this.config.rpsLimit

    Object.assign(this.config, config)

    this.tokens = this.config.burst
    this.lastRefill = Date.now()

    if (this.log && this.config.enabled) {
      console.log(
        `[rate-limiter] enabled: ${this.config.rpsLimit} RPS, burst: ${this.config.burst}`
      )
    }
  }

  /**
   * Refill tokens based on elapsed time since last refill.
   * Token generation rate = rpsLimit tokens/second.
   */
  private refillBucket(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000 // seconds
    const tokensToAdd = elapsed * this.config.rpsLimit

    this.tokens = Math.min(this.config.burst, this.tokens + tokensToAdd)
    this.lastRefill = now
  }

  /**
   * Block until a token is available, then consume it.
   * If rate limiting is disabled, returns immediately.
   */
  async acquire(): Promise<void> {
    if (!this.config.enabled) return

    // Fast path: token available
    this.refillBucket()
    if (this.tokens >= 1) {
      this.tokens -= 1
      if (this.log) {
        console.log(`[rate-limiter] acquired, tokens left: ${Math.floor(this.tokens)}`)
      }
      return
    }

    // Slow path: wait for next token
    const tokensNeeded = 1 - this.tokens
    const waitMs = (tokensNeeded / this.config.rpsLimit) * 1000

    if (this.log) {
      console.log(`[rate-limiter] waiting ${waitMs.toFixed(0)}ms for token`)
    }

    await new Promise(resolve => setTimeout(resolve, waitMs))
    this.refillBucket()
    this.tokens -= 1
  }

  /**
   * Non-blocking check. Returns true if a token is available without waiting.
   */
  tryAcquire(): boolean {
    if (!this.config.enabled) return true

    this.refillBucket()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }

  /**
   * Get current token count (for debugging).
   */
  getStatus(): { tokens: number; rpsLimit: number; burst: number; enabled: boolean } {
    this.refillBucket()
    return {
      tokens: this.tokens,
      rpsLimit: this.config.rpsLimit,
      burst: this.config.burst,
      enabled: this.config.enabled,
    }
  }
}

/**
 * Wrap fetch to apply rate limiting.
 *
 * Usage:
 *   const limiter = new RateLimiter()
 *   const limitedFetch = rateLimitFetch(fetch, limiter)
 *   await limitedFetch('https://api.example.com/endpoint')
 */
export function rateLimitFetch(
  fetchFn: typeof global.fetch,
  limiter: RateLimiter
): typeof global.fetch {
  return async (...args: Parameters<typeof global.fetch>): Promise<Response> => {
    await limiter.acquire()
    return fetchFn(...args)
  }
}

// Create a singleton instance for convenience
let _globalLimiter: RateLimiter | null = null

export function getGlobalLimiter(): RateLimiter {
  if (!_globalLimiter) {
    _globalLimiter = new RateLimiter()
  }
  return _globalLimiter
}
