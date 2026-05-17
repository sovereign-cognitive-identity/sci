/**
 * Token estimate for attached files.
 *
 * Per ticket, accuracy isn't critical here — we just want a "this
 * is going to be a 4k vs 40k prompt" signal in the chip row so the
 * user doesn't blow past the context window by surprise.
 *
 * Heuristic: ~4 characters per token. Matches the rough industry
 * convention for English-leaning code + prose; tokenizers actually
 * vary, but the ratio is in the right ballpark.
 *
 * Per-file estimate also accounts for the markdown wrapper bytes
 * we'll add when formatting (the `## file:` header + fence). For
 * a typical file that's an extra ~20 chars, negligible vs the
 * content, but we include it for correctness.
 */

const CHARS_PER_TOKEN = 4;

/** Wrapper overhead per file: `## file: <path>\n```lang\n` + `\n```\n`. */
const WRAPPER_CHARS = 30;

export function estimateTokens(content: string): number {
  return Math.ceil((content.length + WRAPPER_CHARS) / CHARS_PER_TOKEN);
}

export function sumTokens(files: { tokenEstimate: number }[]): number {
  let total = 0;
  for (const file of files) {
    total += file.tokenEstimate;
  }
  return total;
}

/**
 * Render a token count as a short human-readable string.
 * 0..999 -> "123 tokens"
 * 1000..  -> "1.2k tokens"
 */
export function formatTokenCount(count: number): string {
  if (count < 1000) {
    return `${count} tokens`;
  }
  const k = (count / 1000).toFixed(1);
  return `${k}k tokens`;
}

/**
 * Warning level for a token total. Drives the chip-row color.
 *   green:  <  8,000  - normal
 *   yellow: < 32,000  - getting heavy
 *   red:    >= 32,000 - likely near context cap
 *
 * Thresholds chosen to land comfortably inside typical Claude
 * context windows (200k) — they're warnings about prompt waste,
 * not hard caps. Tune if dogfood shows they fire too often.
 */
export type TokenWarnLevel = 'green' | 'yellow' | 'red';

const YELLOW_AT = 8_000;
const RED_AT = 32_000;

export function tokenWarnLevel(count: number): TokenWarnLevel {
  if (count >= RED_AT) return 'red';
  if (count >= YELLOW_AT) return 'yellow';
  return 'green';
}
