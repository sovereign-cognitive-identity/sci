# Rate Limiting

Sci provides a built-in token-bucket rate limiter to prevent API flooding. It's especially useful when running agents or background tasks that make frequent HTTP requests.

## Quick Start

```typescript
import { RateLimiter, rateLimitFetch } from '@sci/core'

// Create a limiter (10 RPS by default, or set via environment)
const limiter = new RateLimiter()

// Wrap fetch to apply rate limiting
const fetch = rateLimitFetch(globalThis.fetch, limiter)

// All HTTP requests now respect the limit
const res = await fetch('https://api.example.com/data')
```

## Configuration

Control the rate limiter with environment variables:

- **`SCI_RATE_LIMIT_ENABLED`** (default: `true`)  
  Set to `"false"` to disable rate limiting entirely (useful for development).

- **`SCI_RATE_LIMIT_RPS`** (default: `10`)  
  Requests per second allowed. For example, `5` allows 5 requests per second.

- **`SCI_RATE_LIMIT_BURST`** (default: same as `SCI_RATE_LIMIT_RPS`)  
  Maximum tokens in the bucket. Allows short bursts above the steady-state rate. For example, `SCI_RATE_LIMIT_RPS=5 SCI_RATE_LIMIT_BURST=20` allows up to 20 requests immediately, then throttles back to 5 RPS.

- **`SCI_LOG_RATELIMIT`** (default: `false`)  
  Set to `"true"` to see rate limiter debug logs.

## Examples

**Allow 20 requests per second with 100-request burst:**
```bash
export SCI_RATE_LIMIT_RPS=20
export SCI_RATE_LIMIT_BURST=100
```

**Disable rate limiting (development only):**
```bash
export SCI_RATE_LIMIT_ENABLED=false
```

**Enable debug logging:**
```bash
export SCI_LOG_RATELIMIT=true
```

## API Reference

### `new RateLimiter(config?: Partial<Config>)`

Create a new rate limiter instance. Configuration can be passed directly or via environment variables.

```typescript
const limiter = new RateLimiter({ rpsLimit: 5, burst: 20, enabled: true })
```

### `limiter.acquire(): Promise<void>`

Block until a token is available, then consume it. Use this before making HTTP requests.

```typescript
await limiter.acquire()
const res = await fetch(url)
```

### `limiter.tryAcquire(): boolean`

Non-blocking check. Returns `true` if a token is available without waiting.

```typescript
if (limiter.tryAcquire()) {
  // make request immediately
} else {
  // queue request for later
}
```

### `limiter.getStatus(): { tokens, rpsLimit, burst, enabled }`

Get current limiter status for debugging.

```typescript
console.log(limiter.getStatus())
// { tokens: 8.5, rpsLimit: 10, burst: 10, enabled: true }
```

### `rateLimitFetch(fetch, limiter): typeof fetch`

Wrap the native `fetch` function to apply rate limiting automatically.

```typescript
const limitedFetch = rateLimitFetch(globalThis.fetch, limiter)
const res = await limitedFetch(url)
```

### `getGlobalLimiter(): RateLimiter`

Get or create the singleton global rate limiter (useful for reusing across modules).

```typescript
const limiter = getGlobalLimiter()
await limiter.acquire()
```

## Implementation Notes

- Uses a **token bucket algorithm** — tokens accumulate at a fixed rate and are consumed on each request.
- **Thread-safe** in single-threaded JavaScript (but note: `async` operations between `acquire()` and actual HTTP request are not atomic).
- **Non-blocking for available tokens** — if tokens are available, `acquire()` returns immediately; otherwise it sleeps until the next token is available.
- **Transparent** — disable via env var without changing code.
