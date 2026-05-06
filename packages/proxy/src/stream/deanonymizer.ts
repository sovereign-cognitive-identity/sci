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

import type { TokenMap } from '@sci/core'

// Matches a complete token
const COMPLETE_TOKEN_RE = /^\[[A-Z]+_\d+\]/

// Matches the start of a potential token (but not yet complete)
const PARTIAL_TOKEN_RE = /^\[[A-Z]*_?\d*$/

export class DeanonymizingStream {
  private buffer = ''
  private accumulated = ''  // full deanonymized response for storage
  private readonly tokenMap: TokenMap

  constructor(tokenMap: TokenMap) {
    this.tokenMap = tokenMap
  }

  /**
   * Process an incoming text delta from the stream.
   * Returns text safe to forward to the client immediately.
   */
  push(text: string): string {
    this.buffer += text
    return this._flush()
  }

  /**
   * Called at end of stream. Flushes and deanonymizes everything remaining.
   */
  end(): string {
    const remaining = this._deanonymize(this.buffer)
    this.accumulated += remaining
    this.buffer = ''
    return remaining
  }

  /** Full deanonymized response — for memory storage after stream completes. */
  get fullResponse(): string {
    return this.accumulated
  }

  private _flush(): string {
    const lastBracket = this.buffer.lastIndexOf('[')

    if (lastBracket === -1) {
      // No brackets at all — safe to flush everything
      const out = this._deanonymize(this.buffer)
      this.buffer = ''
      return out
    }

    const tail = this.buffer.slice(lastBracket)

    if (COMPLETE_TOKEN_RE.test(tail) || !PARTIAL_TOKEN_RE.test(tail)) {
      // Either a complete token in the tail, or '[' that isn't a token start
      // Either way, safe to flush everything
      const out = this._deanonymize(this.buffer)
      this.buffer = ''
      return out
    }

    // Partial token at the tail — flush everything before it, hold the rest
    const safe = this.buffer.slice(0, lastBracket)
    this.buffer = this.buffer.slice(lastBracket)
    const out = this._deanonymize(safe)
    return out
  }

  private _deanonymize(text: string): string {
    if (!text || this.tokenMap.reverse.size === 0) return text
    let result = text
    // Sort tokens by length descending to avoid partial replacements
    const tokens = [...this.tokenMap.reverse.keys()].sort((a, b) => b.length - a.length)
    for (const token of tokens) {
      const entity = this.tokenMap.reverse.get(token)!
      result = result.split(token).join(entity)
    }
    this.accumulated += result.slice(this.accumulated.length - text.length > 0
      ? this.accumulated.length - text.length
      : 0)
    return result
  }
}

// Simpler accumulated tracking — patch the accounting
export class DeanonymizingStreamV2 {
  private buffer = ''
  private _fullResponse = ''
  private readonly tokenMap: TokenMap

  // Inspector telemetry — counted across all _applyMap calls.
  private _replacementCount = 0
  private readonly _replacedTokens = new Map<string, number>()

  constructor(tokenMap: TokenMap) {
    this.tokenMap = tokenMap
  }

  push(text: string): string {
    this.buffer += text
    const out = this._tryFlush()
    this._fullResponse += out
    return out
  }

  end(): string {
    const out = this._applyMap(this.buffer)
    this._fullResponse += out
    this.buffer = ''
    return out
  }

  get fullResponse(): string {
    return this._fullResponse
  }

  /** Total token replacements performed across the stream. */
  get replacementCount(): number {
    return this._replacementCount
  }

  /**
   * Distinct masked tokens that appeared in the upstream response and
   * were swapped back to their real values, with occurrence counts.
   */
  get replacedTokens(): Array<{ token: string; original: string; count: number }> {
    return [...this._replacedTokens.entries()].map(([token, count]) => ({
      token,
      original: this.tokenMap.reverse.get(token) ?? token,
      count,
    }))
  }

  private _tryFlush(): string {
    const lastBracket = this.buffer.lastIndexOf('[')

    if (lastBracket === -1) {
      const out = this._applyMap(this.buffer)
      this.buffer = ''
      return out
    }

    const tail = this.buffer.slice(lastBracket)

    // Complete token present, or '[' that doesn't start a token → flush all
    if (COMPLETE_TOKEN_RE.test(tail) || !PARTIAL_TOKEN_RE.test(tail)) {
      const out = this._applyMap(this.buffer)
      this.buffer = ''
      return out
    }

    // Partial token at end — flush safe portion
    const safe = this.buffer.slice(0, lastBracket)
    this.buffer = this.buffer.slice(lastBracket)
    return safe.length > 0 ? this._applyMap(safe) : ''
  }

  private _applyMap(text: string): string {
    if (!text || this.tokenMap.reverse.size === 0) return text
    let result = text
    const tokens = [...this.tokenMap.reverse.keys()].sort((a, b) => b.length - a.length)
    for (const token of tokens) {
      // count occurrences before replacing
      const parts = result.split(token)
      const hits = parts.length - 1
      if (hits > 0) {
        this._replacementCount += hits
        this._replacedTokens.set(token, (this._replacedTokens.get(token) ?? 0) + hits)
        result = parts.join(this.tokenMap.reverse.get(token)!)
      }
    }
    return result
  }
}
