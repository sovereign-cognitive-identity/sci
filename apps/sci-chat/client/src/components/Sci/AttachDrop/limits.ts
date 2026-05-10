/**
 * Size + binary + extension policy for the SCI-166 snapshot-attach
 * feature. All thresholds and the language map live here so the UI,
 * the picker, and the read pipeline share one source of truth.
 */

/** Hard reject above this size (per ticket). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Soft warn above this size (per ticket). */
export const WARN_FILE_BYTES = 100 * 1024;

/**
 * Bytes scanned for the binary sniff. UTF-8 text rarely contains
 * NUL bytes; their presence in the first 4 KB is a robust binary
 * heuristic and matches what `git`, `grep`, and `file(1)` do.
 */
const BINARY_SNIFF_BYTES = 4096;

/**
 * Synchronous binary sniff for an already-decoded string. Returns
 * true iff the first 4 KB contains a NUL byte or > 30% non-printable
 * characters. We call this after `file.text()` has produced a UTF-8
 * string; mojibake from a misdetected binary will trip the second
 * heuristic.
 *
 * Pure function — no I/O.
 */
export function isLikelyBinary(content: string): boolean {
  const sample = content.slice(0, BINARY_SNIFF_BYTES);
  if (sample.includes('\u0000')) return true;

  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0xfffd) {
      // U+FFFD REPLACEMENT CHARACTER — emitted by UTF-8 decode when
      // it hits bytes that don't form a valid sequence. Strong signal
      // the file isn't actually text.
      nonPrintable++;
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      // Control char other than tab / LF / CR.
      nonPrintable++;
    }
  }
  return sample.length > 0 && nonPrintable / sample.length > 0.3;
}

/**
 * Maps file extensions and known basenames to the language tag we
 * write into the markdown code fence. Empty string means "no fence
 * info string" — still valid markdown, no language hint.
 *
 * Coverage focuses on programmer-relevant text formats. Anything
 * not mapped here still attaches successfully (we don't gate on the
 * map); it just lands with a bare ```` ``` ```` fence.
 *
 * Ordering note: basename match (e.g. `Dockerfile`) takes precedence
 * over extension match (no extension to match anyway). We check
 * basename first in `inferLanguage`.
 */
const BASENAME_LANGUAGE: Record<string, string> = {
  'Dockerfile': 'dockerfile',
  'dockerfile': 'dockerfile',
  'Makefile': 'makefile',
  'makefile': 'makefile',
  'Rakefile': 'ruby',
  'Gemfile': 'ruby',
  '.gitignore': '',
  '.dockerignore': '',
  '.env': 'bash',
  '.env.example': 'bash',
  '.env.local': 'bash',
};

const EXT_LANGUAGE: Record<string, string> = {
  // Web
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
  // Backend
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.scala': 'scala',
  '.cs': 'csharp',
  '.php': 'php',
  '.pl': 'perl',
  // Systems
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.hh': 'cpp',
  '.m': 'objc',
  '.mm': 'objc',
  '.zig': 'zig',
  // Shell + config
  '.sh': 'bash',
  '.zsh': 'bash',
  '.bash': 'bash',
  '.fish': 'fish',
  '.ps1': 'powershell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.xml': 'xml',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': '',
  // Docs / data
  '.md': 'md',
  '.mdx': 'mdx',
  '.txt': '',
  '.csv': 'csv',
  '.tsv': '',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
  // Build files
  '.gradle': 'groovy',
  '.cmake': 'cmake',
};

/**
 * Infer a markdown code-fence language for a filename. Returns '' if
 * we don't have a confident match — caller writes a bare fence.
 *
 * Lowercases the basename for the basename-map lookup so `DOCKERFILE`,
 * `Dockerfile`, `dockerfile` all match.
 */
export function inferLanguage(filename: string): string {
  const lastSlash = filename.lastIndexOf('/');
  const base = lastSlash >= 0 ? filename.slice(lastSlash + 1) : filename;

  if (base in BASENAME_LANGUAGE) return BASENAME_LANGUAGE[base];
  if (base.toLowerCase() in BASENAME_LANGUAGE) {
    return BASENAME_LANGUAGE[base.toLowerCase()];
  }

  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = base.slice(dot).toLowerCase();
  return EXT_LANGUAGE[ext] ?? '';
}

/**
 * Classify a file by size. Used by the read pipeline to decide
 * accept / warn / reject before we even touch the contents.
 */
export type SizeVerdict = 'ok' | 'warn' | 'reject';

export function sizeVerdict(size: number): SizeVerdict {
  if (size > MAX_FILE_BYTES) return 'reject';
  if (size > WARN_FILE_BYTES) return 'warn';
  return 'ok';
}
