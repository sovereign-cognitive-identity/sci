/**
 * Per-user allowlist — terms the user explicitly does NOT want masked (SCI-149).
 *
 * Mirrors the Rust `UserAllowlist` in `core/crates/sci-anonymizer/src/user_allowlist.rs`.
 * When a detected entity matches the allowlist, it is excluded from the token map
 * and left verbatim in the outbound text (allowlist takes precedence over detection).
 */

/** Per-user allowlist of terms that should never be masked (case-insensitive). */
export type UserAllowlist = Set<string>

/**
 * Create a new allowlist from an array of terms.
 * Terms are normalized to lowercase for case-insensitive matching.
 */
export function createUserAllowlist(terms: string[]): UserAllowlist {
  const allowlist = new Set<string>()
  for (const term of terms) {
    allowlist.add(term.toLowerCase())
  }
  return allowlist
}

/**
 * Check if a term is allowlisted (case-insensitive exact match).
 * Returns true if the term is in the allowlist.
 */
export function isUserAllowlisted(term: string, allowlist: UserAllowlist): boolean {
  return allowlist.has(term.toLowerCase())
}
