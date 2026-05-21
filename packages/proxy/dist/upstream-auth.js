/**
 * Upstream auth — reads the cached Anthropic OAuth token from ~/.sci/oauth.json
 * (written by `docker compose --profile setup run sci-auth`) and refreshes it
 * via the public Claude OAuth refresh endpoint when within 5 minutes of expiry.
 *
 * The proxy uses this to substitute the Authorization header before forwarding
 * to api.anthropic.com. The client side keeps using its sci_<tier>_<hex> token
 * — that's validated by middleware/auth.ts and never leaves the proxy.
 *
 * This file is a pared-down re-implementation of the same logic that lives in
 * @sci/ui/oauth.ts. Duplicated rather than cross-imported because pulling
 * @sci/ui into @sci/proxy creates an awkward dependency edge.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
const CACHE_PATH = process.env['SCI_OAUTH_CACHE_PATH']
    ?? join(homedir(), '.sci', 'oauth.json');
const REFRESH_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // refresh if <5 min remaining
let inflight = null;
function readCache() {
    if (!existsSync(CACHE_PATH))
        return null;
    try {
        return JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
    }
    catch {
        return null;
    }
}
function writeCache(data) {
    const dir = dirname(CACHE_PATH);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}
async function refresh(refreshToken) {
    const body = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
    });
    const res = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
    });
    if (!res.ok) {
        console.error(`[upstream-auth] refresh failed: ${res.status} ${await res.text()}`);
        return null;
    }
    const j = await res.json();
    const next = {
        access_token: j.access_token,
        refresh_token: j.refresh_token ?? refreshToken,
        expires_at_ms: j.expires_in ? Date.now() + (j.expires_in * 1000) : undefined,
        scope: j.scope,
    };
    writeCache(next);
    return next;
}
/**
 * Returns a usable Anthropic access token, refreshing if needed. Returns null
 * if no cache exists at all (caller should error out — user must run
 * `docker compose --profile setup run --rm --service-ports sci-auth`).
 */
export async function getAnthropicAccessToken() {
    if (inflight)
        return inflight;
    inflight = (async () => {
        try {
            const cache = readCache();
            if (!cache)
                return null;
            const now = Date.now();
            const expired = cache.expires_at_ms && cache.expires_at_ms - now < REFRESH_THRESHOLD_MS;
            if (expired && cache.refresh_token) {
                const next = await refresh(cache.refresh_token);
                return next?.access_token ?? cache.access_token;
            }
            return cache.access_token;
        }
        finally {
            inflight = null;
        }
    })();
    return inflight;
}
//# sourceMappingURL=upstream-auth.js.map