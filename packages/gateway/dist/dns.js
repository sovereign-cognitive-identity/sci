/**
 * Gateway DNS server.
 *
 * Listens on UDP/53 inside the gateway container; advertised to peers via
 * `DNS = 10.13.13.1` in their wireguard configs.
 *
 * Behavior, in order:
 *
 *   1. **Hijack list (Phase 9).** If the queried hostname matches an
 *      AI-provider hostname configured for interception (api.anthropic.com,
 *      claude.ai, etc.), synthesize a response pointing at the proxy's
 *      virtual IP (10.13.13.2 by default). The peer's TLS handshake then
 *      lands on the proxy, which terminates with a Sci-CA leaf cert,
 *      anonymizes the body, and forwards to the real upstream. This
 *      requires the device to trust the Sci CA — see SCI-86.
 *
 *   2. **Forward + observe (Phase 8).** Anything not on the hijack list
 *      is forwarded to a real upstream (Cloudflare 1.1.1.1 by default)
 *      and the answer returned untouched. On the side, the hostname is
 *      matched against the curated exposure-services catalog; matches
 *      are reported to the control plane so the dashboard can surface
 *      them. Unmatched hostnames are NEVER persisted.
 *
 * The hijack list is configured via SCI_DNS_HIJACK env var (comma-separated
 * hostnames). Default: empty (no hijacking; pure observe mode). Phase 9
 * deployments set it to the AI provider list.
 */
import { createSocket } from 'dgram';
import * as dnsPacket from 'dns-packet';
import { matchHostname, } from '@sci/core/exposure-services';
const PORT = parseInt(process.env['SCI_DNS_PORT'] ?? '53');
const UPSTREAM_HOST = process.env['SCI_DNS_UPSTREAM'] ?? '1.1.1.1';
const UPSTREAM_PORT = parseInt(process.env['SCI_DNS_UPSTREAM_PORT'] ?? '53');
const CONTROL_URL = process.env['SCI_CONTROL_URL'] ?? 'http://sci-control:3003';
const INTERNAL_TOKEN = process.env['SCI_INTERNAL_TOKEN'] ?? '';
// Two hijack-target IPs to support BOTH deployment shapes simultaneously:
//
//   - WG peers (queries from 10.13.13.0/24) get PROXY_VIP_WG. Their traffic
//     stays inside the WG tunnel, hits the gateway's DNAT, lands at the proxy.
//   - LAN-direct clients (queries from anywhere else) get PROXY_VIP_LAN. They
//     connect directly to the Hub VM's LAN IP — no tunnel required, and
//     critically, no dependency on macOS WireGuard.app's "supplemental DNS"
//     scoping, which silently bypasses the WG-set DNS for non-search-domain
//     queries (the bug that made `curl claude.ai` go direct on macOS).
//
// PROXY_VIP_LAN is typically the Hub's LAN IP (e.g. 192.168.2.39); when set,
// LAN devices that point their primary DNS at this box (System Settings →
// DNS → 192.168.2.39) get reliable AI-host interception across every app
// regardless of which DNS-resolution path the app uses.
const PROXY_VIP_WG = process.env['SCI_PROXY_VIP'] ?? '10.13.13.2';
const PROXY_VIP_LAN = process.env['SCI_PROXY_VIP_LAN'] ?? PROXY_VIP_WG;
// Phase 9 hijack list. Comma-separated. Leave empty to disable hijack
// entirely (pure Phase-8 observe mode).
const HIJACK_HOSTS = (process.env['SCI_DNS_HIJACK'] ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
const HIJACK_SET = new Set(HIJACK_HOSTS);
function isHijacked(hostname) {
    if (HIJACK_SET.size === 0)
        return false;
    const h = hostname.toLowerCase().replace(/\.$/, '');
    if (HIJACK_SET.has(h))
        return true;
    // Suffix match — e.g. claude.ai matches www.claude.ai too.
    const parts = h.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        const suffix = parts.slice(i).join('.');
        if (HIJACK_SET.has(suffix))
            return true;
    }
    return false;
}
/**
 * Choose which hijack IP to return based on the DNS query's source.
 *
 * 10.13.13.0/24 → WG peer → return WG VIP (traffic stays in tunnel).
 * Everything else → LAN-direct client → return LAN IP.
 */
function pickHijackTarget(srcIp) {
    if (srcIp.startsWith('10.13.13.'))
        return PROXY_VIP_WG;
    return PROXY_VIP_LAN;
}
/** Synthesize an A-record response pointing at the right proxy address for the
 *  query's source. */
function synthesizeHijackReply(query, srcIp) {
    const target = pickHijackTarget(srcIp);
    const reply = {
        type: 'response',
        id: query.id,
        flags: 0x8180, // QR=1, RD=1, RA=1, RCODE=0
        questions: query.questions,
        answers: (query.questions ?? []).flatMap(q => {
            if (q.type === 'A') {
                return [{
                        type: 'A',
                        name: q.name,
                        ttl: 60,
                        class: 'IN',
                        data: target,
                    }];
            }
            // For AAAA we return an empty answer (NODATA). The peer falls back
            // to the A query. Returning a real IPv6 here would force us to
            // also bind the proxy on v6; not worth it now.
            return [];
        }),
    };
    return dnsPacket.encode(reply);
}
/** Best-effort: tell the control plane an exposure occurred. */
async function reportExposure(opts) {
    if (!INTERNAL_TOKEN)
        return;
    try {
        await fetch(`${CONTROL_URL}/api/exposure/log`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${INTERNAL_TOKEN}`,
            },
            body: JSON.stringify(opts),
        });
    }
    catch { /* swallow — DNS path must not fail because logging failed */ }
}
/** Forward a DNS query packet to the upstream resolver and return the
 *  upstream's binary reply. UDP-only — fine for typical queries. */
function forwardQuery(buf, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const sock = createSocket('udp4');
        const timer = setTimeout(() => { sock.close(); reject(new Error('dns upstream timeout')); }, timeoutMs);
        sock.once('message', (reply) => { clearTimeout(timer); sock.close(); resolve(reply); });
        sock.once('error', (err) => { clearTimeout(timer); sock.close(); reject(err); });
        sock.send(buf, UPSTREAM_PORT, UPSTREAM_HOST);
    });
}
function extractAnswerIP(reply) {
    if (!reply.answers)
        return null;
    for (const a of reply.answers) {
        if (a.type === 'A' || a.type === 'AAAA') {
            return typeof a.data === 'string' ? a.data : null;
        }
    }
    return null;
}
export function startDNSServer() {
    const sock = createSocket('udp4');
    if (HIJACK_HOSTS.length) {
        console.log(`[sci-dns] hijack list (${HIJACK_HOSTS.length}): ${HIJACK_HOSTS.join(', ')}`);
        console.log(`[sci-dns] hijack targets: WG peers→${PROXY_VIP_WG}, LAN clients→${PROXY_VIP_LAN}`);
    }
    sock.on('message', async (msg, rinfo) => {
        let parsed = null;
        try {
            parsed = dnsPacket.decode(msg);
        }
        catch { /* malformed */ }
        // ── Phase 9: hijack first ──────────────────────────────────────────
        const firstQ = parsed?.questions?.[0];
        if (parsed && firstQ?.name && isHijacked(firstQ.name)) {
            const target = pickHijackTarget(rinfo.address);
            try {
                sock.send(synthesizeHijackReply(parsed, rinfo.address), rinfo.port, rinfo.address);
            }
            catch (e) {
                console.error('[sci-dns] hijack send failed:', e.message);
            }
            // Still log as an exposure event so the dashboard reflects activity.
            reportExposure({
                peerIp: rinfo.address,
                hostname: firstQ.name.toLowerCase().replace(/\.$/, ''),
                vendorId: 'sci-intercepted',
                queryType: String(firstQ.type),
                resolvedIp: target,
            }).catch(() => { });
            return;
        }
        // ── Phase 8: forward + observe ────────────────────────────────────
        let upstreamReply;
        try {
            upstreamReply = await forwardQuery(msg);
        }
        catch (e) {
            const fail = {
                type: 'response',
                id: parsed?.id ?? 0,
                flags: 0x8002, // SERVFAIL
                questions: parsed?.questions ?? [],
            };
            try {
                sock.send(dnsPacket.encode(fail), rinfo.port, rinfo.address);
            }
            catch { }
            console.error('[sci-dns] upstream failed:', e.message);
            return;
        }
        sock.send(upstreamReply, rinfo.port, rinfo.address);
        if (!parsed?.questions)
            return;
        for (const q of parsed.questions) {
            if (!q.name)
                continue;
            const t = String(q.type);
            if (t !== 'A' && t !== 'AAAA')
                continue;
            let svc = null;
            try {
                svc = matchHostname(q.name);
            }
            catch {
                svc = null;
            }
            if (!svc)
                continue;
            let resolvedIp = null;
            try {
                const reply = dnsPacket.decode(upstreamReply);
                resolvedIp = extractAnswerIP(reply);
            }
            catch { /* ignore */ }
            reportExposure({
                peerIp: rinfo.address,
                hostname: q.name.toLowerCase().replace(/\.$/, ''),
                vendorId: svc.id,
                queryType: q.type,
                resolvedIp,
            }).catch(() => { });
        }
    });
    sock.on('error', (err) => { console.error('[sci-dns] socket error:', err); });
    sock.bind(PORT, '0.0.0.0', () => {
        const addr = sock.address();
        console.log(`[sci-dns] listening on ${addr.address}:${addr.port}, upstream=${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
    });
}
//# sourceMappingURL=dns.js.map