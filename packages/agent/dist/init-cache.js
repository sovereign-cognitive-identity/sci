/**
 * Caches Anthropic init request responses to avoid rate limiting.
 * Each Claude Code session start sends ~15 GET requests to anthropic.com
 * (bootstrap, account/settings, mcp-registry, etc.) — caching means only
 * the first session per TTL pays the API cost; subsequent sessions are free.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CACHE_DIR = join(homedir(), '.sci', 'cache');
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BODY_BYTES = 1024 * 1024;    // 1 MB — don't cache large responses

const CACHE_TTLS = {
  '/api/claude_code_grove': 60 * 60 * 1000,         // 1 hour
  '/api/claude_code_penguin_mode': 60 * 60 * 1000,  // 1 hour
  '/api/oauth/account/settings': 5 * 60 * 1000,     // 5 min
  '/api/claude_cli/bootstrap': 2 * 60 * 1000,       // 2 min
  '/mcp-registry/v0/servers': 5 * 60 * 1000,        // 5 min
  '/v1/mcp_servers': 2 * 60 * 1000,                 // 2 min
  '/api/eval/': 60 * 60 * 1000,                     // 1 hour (prefix match)
};

/**
 * Returns the cache key filename (no extension) for a method+url pair.
 * Query params are stripped — they're pagination, not content-changing.
 * All non-alphanumeric characters (including slashes and colons) are
 * replaced with underscores so the result is a single flat filename.
 */
function cacheKey(method, url) {
  const path = url.split('?')[0];
  // Replace every non-alphanumeric char (including / and :) with _
  return (method + '_' + path).replace(/[^a-z0-9_\-]/gi, '_');
}

/**
 * Returns the TTL in ms for the given URL path.
 * Uses prefix matching against CACHE_TTLS entries; falls back to DEFAULT_TTL_MS.
 */
function getTTL(url) {
  const path = url.split('?')[0];
  for (const [prefix, ttl] of Object.entries(CACHE_TTLS)) {
    if (path.startsWith(prefix)) return ttl;
  }
  return DEFAULT_TTL_MS;
}

/**
 * Check the disk cache for a prior response.
 * Returns the cached entry { status, headers, body, expiresAt } or null.
 * Only GET requests are ever cached.
 */
export function getCached(method, url) {
  if (method !== 'GET') return null;
  const key = cacheKey(method, url);
  const file = join(CACHE_DIR, key + '.json');
  if (!existsSync(file)) return null;
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() > entry.expiresAt) return null;
    return entry; // { status, headers, body (base64), expiresAt }
  } catch {
    return null;
  }
}

/**
 * Write a response to the disk cache.
 * Silently skips non-GET requests, error responses, and bodies > 1 MB.
 * `headers` should be a plain object (string→string).
 * `body` should be a Buffer.
 */
export function setCached(method, url, status, headers, body) {
  if (method !== 'GET') return;
  if (status < 200 || status >= 400) return;
  if (body.length > MAX_BODY_BYTES) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const key = cacheKey(method, url);
    const file = join(CACHE_DIR, key + '.json');
    const entry = {
      status,
      headers,
      body: body.toString('base64'),
      expiresAt: Date.now() + getTTL(url),
    };
    writeFileSync(file, JSON.stringify(entry));
  } catch (err) {
    process.stderr.write(`[sci-cache] write error for ${url}: ${err.message}\n`);
  }
}
