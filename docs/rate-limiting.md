# Rate Limiting

Sci has **two independent rate limiters**. Don't confuse them — they have different env vars and live in different layers:

| Limiter | Layer | Algorithm | Env vars | Limits |
|---------|-------|-----------|----------|--------|
| **Proxy request limiter** | Rust helper (`sci-handlers`) | Sliding window | `SCI_RATE_LIMIT_MAX`, `SCI_RATE_LIMIT_WINDOW_SECS` | requests per window |
| **Client token bucket** | TypeScript (`@sci/core`) | Token bucket | `SCI_RATE_LIMIT_RPS`, `SCI_RATE_LIMIT_BURST`, `SCI_RATE_LIMIT_ENABLED` | requests per second |

The **proxy limiter** guards the live `sci-helper` proxy — every Claude request routed through Sci passes through it. If it trips, the proxy returns its own `429` with body `rate limit: too many requests in 60s - possible retry storm, check sci-helper logs`. **This is not an Anthropic or subscription limit** — it's Sci's own guard. If agents fail with that exact message, this is the limiter to raise (see below).

The rest of this document covers the **client token bucket** (`@sci/core`).

## Proxy request limiter (Rust helper)

Sliding-window limiter in `core/crates/sci-handlers/src/state.rs`. Defaults are sized for autonomous/parallel **agents**:

- **`SCI_RATE_LIMIT_MAX`** (default: `120`)
  Max requests allowed per window. The previous hardcoded value was `20`, sized for a single ~3/min human session — autonomous Claude Code agents burst far past it and fan-out multiplies it, causing self-inflicted `429`s. `120` keeps retry-storm protection while leaving headroom for parallel agents.

- **`SCI_RATE_LIMIT_WINDOW_SECS`** (default: `60`)
  Sliding window length in seconds.

Set these in the helper's launchd plist (`~/Library/LaunchAgents/dev.sci.helper.plist`, `EnvironmentVariables`) and restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/dev.sci.helper
```

Invalid values fall back to the defaults.

---

The built-in token-bucket rate limiter below prevents API flooding from the TypeScript layer. It's especially useful when running agents or background tasks that make frequent HTTP requests.

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
