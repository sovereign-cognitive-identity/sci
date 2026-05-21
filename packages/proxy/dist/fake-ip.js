/**
 * Fake IP registry for TUN-mode interception.
 *
 * AI hostnames are assigned IPs in 198.18.0.0/15 (RFC 2544 benchmarking
 * range — not routable on the public internet). Traffic to these IPs is
 * routed to the TUN device. Our proxy's outbound connections use the REAL
 * IPs obtained via DNS, which are NOT in 198.18.0.0/15 — no routing loop.
 *
 * Registry is pre-populated at startup for known endpoints. New hostnames
 * can be assigned dynamically if needed.
 */
export const FAKE_IP_CIDR = '198.18.0.0/15'; // /15 = 198.18.0.0 – 198.19.255.255
// Octets for the fake IP range: 198.18.x.y
const BASE_A = 198;
const BASE_B = 18;
// Counter starts at 1 (198.18.0.1); increments per hostname
let _counter = 1;
const _hostToIp = new Map();
const _ipToHost = new Map();
/** AI hostnames we intercept. */
export const AI_HOSTNAMES = [
    'api.anthropic.com',
    'api.openai.com',
    'openrouter.ai',
    'generativelanguage.googleapis.com',
];
/** Assign a fake IP to a hostname (idempotent). */
export function assignFakeIP(hostname) {
    const existing = _hostToIp.get(hostname);
    if (existing)
        return existing;
    const c = _counter++;
    const ip = `${BASE_A}.${BASE_B}.${Math.floor(c / 256)}.${c % 256}`;
    _hostToIp.set(hostname, ip);
    _ipToHost.set(ip, hostname);
    return ip;
}
/** Reverse lookup: fake IP → hostname. Returns undefined for non-fake IPs. */
export function lookupByFakeIP(ip) {
    return _ipToHost.get(ip);
}
/** Returns the fake IP for a hostname, or undefined if not registered. */
export function lookupFakeIP(hostname) {
    return _hostToIp.get(hostname);
}
/** Returns true if the hostname is a known AI endpoint. */
export function isAIHostname(hostname) {
    return AI_HOSTNAMES.includes(hostname);
}
/** Returns true if the IP is in the fake IP range (198.18.0.0/15). */
export function isFakeIP(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4)
        return false;
    const a = parseInt(parts[0]);
    const b = parseInt(parts[1]);
    // 198.18.0.0/15 covers 198.18.x.x and 198.19.x.x
    return a === 198 && (b === 18 || b === 19);
}
/** Pre-populate the registry for all known AI endpoints. */
export function warmFakeIPs() {
    for (const hostname of AI_HOSTNAMES) {
        assignFakeIP(hostname);
        process.stderr.write(`[fakeip] ${hostname} → ${_hostToIp.get(hostname)}\n`);
    }
}
/** Returns all current mappings (for diagnostics). */
export function listFakeIPs() {
    return [..._hostToIp.entries()].map(([hostname, ip]) => ({ hostname, ip }));
}
//# sourceMappingURL=fake-ip.js.map