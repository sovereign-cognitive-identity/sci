/**
 * .gitignore-aware path filtering for the folder picker.
 *
 * Wraps the `ignore` npm package (the same one eslint, gitbook,
 * and others use; spec-compliant with .gitignore 2.22.1).
 *
 * On top of `.gitignore` contents (when present in the dropped
 * folder), we layer a default safety set so that even a folder
 * without a `.gitignore` doesn't drag in `node_modules` or `.git`.
 * The user can toggle the visibility of ignored files in the
 * picker UI but cannot silently include `node_modules` — that's
 * a foot-gun guard.
 *
 * Paths passed in MUST be relative to the picker root, forward-
 * slashed, and not start with `./` or `/`. See the `ignore`
 * package's "Pathname Conventions" — invalid paths throw.
 */

import ignore from 'ignore';
import type { Ignore } from 'ignore';

/**
 * Hardcoded safety set. Used in addition to any `.gitignore` found
 * in the dropped folder. Trailing slash marks directories.
 *
 * Rationale: these are nearly always huge and nearly never
 * relevant context. They blow the token budget and add noise.
 * Even when a `.gitignore` is missing or short, we don't surface
 * them by default.
 */
const DEFAULT_PATTERNS: string[] = [
  // VCS
  '.git/',
  '.svn/',
  '.hg/',
  // Node
  'node_modules/',
  'npm-debug.log',
  'yarn-error.log',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  // Python
  '__pycache__/',
  '*.pyc',
  '.venv/',
  'venv/',
  '.mypy_cache/',
  '.pytest_cache/',
  // Rust
  'target/',
  // Java / Kotlin / Gradle / Maven
  'build/',
  '.gradle/',
  // JS build
  'dist/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  // IDE
  '.vscode/',
  '.idea/',
  '*.iml',
  // OS
  '.DS_Store',
  'Thumbs.db',
  // Logs
  '*.log',
];

/**
 * Build an `Ignore` matcher from the dropped folder's `.gitignore`
 * contents (may be empty) plus the safety defaults. Returns a
 * predicate that's true when the path should be hidden by default.
 *
 * @param gitignoreText  raw contents of the dropped folder's
 *                       `.gitignore`, or empty string if none.
 */
export function buildIgnore(gitignoreText: string): Ignore {
  const matcher = ignore();
  matcher.add(DEFAULT_PATTERNS);
  if (gitignoreText.trim().length > 0) {
    matcher.add(gitignoreText);
  }
  return matcher;
}

/**
 * Apply an ignore matcher to a path. Returns true if the path should
 * be hidden by default.
 *
 * Normalizes Windows-style separators and strips a leading `./`,
 * which the `ignore` package rejects.
 */
export function isIgnored(matcher: Ignore, relativePath: string): boolean {
  const normalized = relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (normalized === '' || normalized === '.') return false;
  return matcher.ignores(normalized);
}

/**
 * Filter a list of relative paths through an ignore matcher. Helper
 * for batch operations. The `ignore` package's own `.filter()` does
 * the same thing — we wrap it for the normalization pass.
 */
export function filterIgnored(
  matcher: Ignore,
  paths: string[],
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const path of paths) {
    if (isIgnored(matcher, path)) {
      dropped.push(path);
    } else {
      kept.push(path);
    }
  }
  return { kept, dropped };
}
