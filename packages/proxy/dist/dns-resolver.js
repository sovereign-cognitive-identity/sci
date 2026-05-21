/**
 * Real-IP resolver for outbound connections.
 *
 * When we redirect api.anthropic.com → 127.0.0.1 in /etc/hosts, our own
 * outbound connections would loop back to ourselves. We need to bypass
 * the redirect and connect to the real upstream IPs.
 *
 * Strategy: resolve AI endpoint IPs BEFORE the /etc/hosts redirect is
 * active, cache them, and use those IPs for all outbound connections.
 * If the cache is cold (first run after install), do a system DNS lookup
 * that skips /etc/hosts by querying a public resolver directly.
 */
import { resolve4, Resolver } from 'dns';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
const resolve4Async = promisify(resolve4);
// A resolver that queries 8.8.8.8 directly, bypassing /etc/resolver/ entries.
// Used in TUN mode so our proxy's outbound connections don't hit the fake DNS.
const _directResolver = new Resolver();
_directResolver.setServers(['8.8.8.8:53', '1.1.1.1:53']);
const resolve4Direct = promisify(_directResolver.resolve4.bind(_directResolver));
/**
 * Resolve a hostname using a real public DNS (8.8.8.8), bypassing any
 * /etc/resolver/ or /etc/hosts overrides. Safe to call from inside the
 * TUN-mode proxy where api.anthropic.com would otherwise resolve to a fake IP.
 */
// Reverse lookup: real IP → hostname. Populated as resolveRealDirect succeeds.
// Lets us recognize real AI IPs when they arrive at the SOCKS5 server (e.g.
// because Chromium has them cached internally and bypasses /etc/hosts).
const _realIPToHost = new Map();
export function lookupHostnameByRealIP(ip) {
    return _realIPToHost.get(ip);
}
/** Returns all known real IPs (for routing them through the TUN). */
export function listKnownRealIPs() {
    return [..._realIPToHost.entries()].map(([ip, hostname]) => ({ ip, hostname }));
}
export async function resolveRealDirect(hostname) {
    try {
        const addrs = await resolve4Direct(hostname);
        if (addrs[0]) {
            _realIPToHost.set(addrs[0], hostname);
            return addrs[0];
        }
    }
    catch (err) {
        process.stderr.write(`[dns] direct resolve failed for ${hostname}: ${err}\n`);
    }
    // Fallback to hardcoded IPs
    const fallback = {
        'api.anthropic.com': '160.79.104.10',
        'api.openai.com': '104.18.6.192',
        'openrouter.ai': '104.21.63.72',
    };
    if (fallback[hostname]) {
        _realIPToHost.set(fallback[hostname], hostname);
        return fallback[hostname];
    }
    throw new Error(`Cannot resolve real IP for ${hostname}`);
}
/**
 * Pre-resolve all known AI hostnames so the real-IP-to-hostname map is
 * populated at startup. Returns the resolved real IPs for routing.
 */
export async function warmRealIPCache(hostnames) {
    const results = [];
    for (const h of hostnames) {
        try {
            const ip = await resolveRealDirect(h);
            results.push({ hostname: h, ip });
            process.stderr.write(`[dns] real IP cached: ${h} → ${ip}\n`);
        }
        catch (err) {
            process.stderr.write(`[dns] real IP resolution failed for ${h}: ${err}\n`);
        }
    }
    return results;
}
const CACHE_PATH = join(homedir(), '.sci', 'dns-cache.json');
// Known AI API endpoints we intercept
export const AI_ENDPOINTS = {
    'api.anthropic.com': '',
    'api.openai.com': '',
    'generativelanguage.googleapis.com': '',
    'openrouter.ai': '',
};
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
function loadCache() {
    if (!existsSync(CACHE_PATH))
        return {};
    try {
        return JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
    }
    catch {
        return {};
    }
}
function saveCache(cache) {
    const dir = join(homedir(), '.sci');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}
const _memCache = loadCache();
/** Resolve a hostname to its real IP, bypassing /etc/hosts. */
export async function resolveReal(hostname) {
    const now = Date.now();
    const cached = _memCache[hostname];
    if (cached && now - cached.resolvedAt < TTL_MS) {
        return cached.ip;
    }
    // Use Google's DNS (8.8.8.8) directly to bypass /etc/hosts
    // Node's dns.resolve4 already bypasses /etc/hosts on most systems,
    // but we make it explicit by using a custom resolver
    try {
        const addrs = await resolve4Async(hostname);
        if (addrs[0]) {
            _memCache[hostname] = { ip: addrs[0], resolvedAt: now };
            saveCache(_memCache);
            return addrs[0];
        }
    }
    catch (err) {
        console.warn(`[dns] Failed to resolve ${hostname}:`, err);
    }
    // Fallback: hardcoded IPs for known endpoints (last resort)
    const fallback = {
        'api.anthropic.com': '160.79.104.10',
        'api.openai.com': '104.18.6.192',
        'openrouter.ai': '104.21.63.72',
    };
    if (fallback[hostname])
        return fallback[hostname];
    throw new Error(`Cannot resolve real IP for ${hostname}`);
}
/** Pre-resolve all AI endpoints and warm the cache. Called at proxy startup. */
export async function warmDNSCache() {
    console.log('[dns] Warming DNS cache for AI endpoints...');
    const results = await Promise.allSettled(Object.keys(AI_ENDPOINTS).map(async (host) => {
        const ip = await resolveReal(host);
        console.log(`[dns]   ${host} → ${ip}`);
        return { host, ip };
    }));
    const resolved = results.filter(r => r.status === 'fulfilled').length;
    console.log(`[dns] Cached ${resolved}/${Object.keys(AI_ENDPOINTS).length} endpoints`);
}
//# sourceMappingURL=dns-resolver.js.map