#!/usr/bin/env node
/**
 * Sci Gateway
 *
 * The wireguard headend. Runs as a Docker container with `wireguard-go`
 * (userspace WG, no kernel module needed) and `wg` from wireguard-tools.
 *
 * Responsibilities:
 *   1. On boot: fetch the server key + peer list from the control plane,
 *      bring up the wg0 interface with `wg-quick up`.
 *   2. Periodically (every 10s, or on POST /reload) re-fetch peers and
 *      apply diffs via `wg syncconf`.
 *   3. NAT traffic from the wg subnet out via the container's default
 *      interface so peers can reach the internet through the tunnel.
 *   4. Expose a small HTTP control surface on port 3004:
 *        GET  /health
 *        POST /reload
 *
 * Container image: alpine + wireguard-tools + wireguard-go + node, see
 * Dockerfile in this package.
 */
import { spawnSync } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
// Import from the dedicated subpath so we don't drag in the embedding
// model + tokenizer native deps that @sci/core's main entrypoint pulls in.
import { renderServerConfig } from '@sci/core/wireguard';
import { startDNSServer } from './dns.js';
const CONTROL_URL = process.env['SCI_CONTROL_URL'] ?? 'http://sci-control:3003';
const INTERNAL_TOKEN = process.env['SCI_INTERNAL_TOKEN'] ?? '';
const SYNC_INTERVAL_MS = parseInt(process.env['SCI_GATEWAY_SYNC_MS'] ?? '10000');
const HTTP_PORT = parseInt(process.env['SCI_GATEWAY_HTTP_PORT'] ?? '3004');
const WG_INTERFACE = process.env['SCI_WG_INTERFACE'] ?? 'wg0';
const WG_CONF_PATH = `/etc/wireguard/${WG_INTERFACE}.conf`;
const SKIP_NETWORK = process.env['SCI_GATEWAY_SKIP_NETWORK'] === 'true';
if (!INTERNAL_TOKEN) {
    console.error('[sci-gateway] FATAL: SCI_INTERNAL_TOKEN must be set');
    process.exit(2);
}
let lastSnapshot = null;
let lastSyncAt = null;
let lastSyncError = null;
let syncing = false;
async function fetchPeers() {
    const res = await fetch(`${CONTROL_URL}/api/gateway/peers`, {
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    if (!res.ok)
        throw new Error(`control plane returned ${res.status}`);
    return res.json();
}
function sh(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: 'utf-8' });
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
// Apply iptables DNAT so traffic from peers to the proxy "virtual IP"
// (10.13.13.2:3001) lands on the sci-proxy container — wherever Docker
// happened to schedule it on its private bridge network.
//
// The proxy is on the same docker network as the gateway; we resolve its
// hostname to a current IP at sync time and re-apply rules. Idempotent:
// `iptables -C` checks for existing rules before adding.
const PROXY_VIP_DEFAULT = '10.13.13.2';
const PROXY_HOST_DEFAULT = 'sci-proxy';
const PROXY_PORT_DEFAULT = 3001;
const TLS_INTERCEPT_PORT_DEFAULT = 8443;
// Phase 9.1: catch apps that bypass system DNS by intercepting at L3/L4.
// Default ON for full-tunnel deployments — without it, Claude Desktop's
// Bun subprocess (and similar) escape interception by resolving via their
// own DNS resolvers and connecting to real provider IPs.
const SCI_UNIVERSAL_TLS_INTERCEPT = process.env['SCI_UNIVERSAL_TLS_INTERCEPT'] !== 'false';
const SCI_BLOCK_QUIC = process.env['SCI_BLOCK_QUIC'] !== 'false';
const WG_SUBNET = process.env['SCI_WG_SUBNET'] ?? '10.13.13.0/24';
function applyProxyDnat(proxyVip) {
    if (SKIP_NETWORK)
        return;
    const host = process.env['SCI_PROXY_HOST'] ?? PROXY_HOST_DEFAULT;
    const httpPort = parseInt(process.env['SCI_PROXY_PORT_INTERNAL'] ?? String(PROXY_PORT_DEFAULT));
    const tlsPort = parseInt(process.env['SCI_PROXY_TLS_PORT_INTERNAL'] ?? String(TLS_INTERCEPT_PORT_DEFAULT));
    // Resolve sci-proxy → IP via the container's resolver
    const lookup = sh('getent', ['hosts', host]);
    if (lookup.code !== 0) {
        console.warn(`[sci-gateway] could not resolve ${host}; skipping DNAT`);
        return;
    }
    const ip = lookup.stdout.trim().split(/\s+/)[0];
    if (!ip)
        return;
    const ensure = (table, chain, args) => {
        const checkArgs = ['-t', table, '-C', chain, ...args];
        const addArgs = ['-t', table, '-A', chain, ...args];
        if (sh('iptables', checkArgs).code !== 0) {
            const r = sh('iptables', addArgs);
            if (r.code !== 0)
                console.warn(`[sci-gateway] iptables -A ${chain} failed: ${r.stderr}`);
        }
    };
    // (1) HTTP path: peer hits 10.13.13.2:3001 → proxy:3001
    ensure('nat', 'PREROUTING', ['-i', WG_INTERFACE, '-d', proxyVip, '-p', 'tcp', '--dport', String(httpPort),
        '-j', 'DNAT', '--to-destination', `${ip}:${httpPort}`]);
    ensure('nat', 'POSTROUTING', ['-d', ip, '-p', 'tcp', '--dport', String(httpPort), '-j', 'MASQUERADE']);
    // (2) TLS path (Phase 9, explicit VIP): peer hits 10.13.13.2:443 → proxy:8443
    // Kept for back-compat / explicit scenarios. Largely subsumed by rule (3).
    ensure('nat', 'PREROUTING', ['-i', WG_INTERFACE, '-d', proxyVip, '-p', 'tcp', '--dport', '443',
        '-j', 'DNAT', '--to-destination', `${ip}:${tlsPort}`]);
    ensure('nat', 'POSTROUTING', ['-d', ip, '-p', 'tcp', '--dport', String(tlsPort), '-j', 'MASQUERADE']);
    // (3) UNIVERSAL TLS interception (Phase 9.1): every TCP/443 packet
    //     arriving on wg0 — regardless of destination IP — is redirected to
    //     the proxy. This catches apps that bypass system DNS (e.g. Claude
    //     Desktop's Bun subprocess), since their packets still traverse wg0
    //     in full-tunnel mode. The proxy's SNI sniffer routes by hostname:
    //     known AI hosts get anonymized; others passthrough transparently.
    //
    //     We exclude the wg subnet itself (10.13.13.0/24) so internal
    //     services on gateway/proxy can still talk to themselves on :443
    //     without being looped.
    if (SCI_UNIVERSAL_TLS_INTERCEPT) {
        ensure('nat', 'PREROUTING', ['-i', WG_INTERFACE, '!', '-d', WG_SUBNET, '-p', 'tcp', '--dport', '443',
            '-j', 'DNAT', '--to-destination', `${ip}:${tlsPort}`]);
    }
    // (4) Block UDP/443 from peers — forces QUIC-capable apps to fall back
    //     to TCP, where rule (3) catches them. Without this, apps that
    //     prefer HTTP/3 (Chrome, some clients) would silently send UDP that
    //     bypasses our TCP-only DNAT.
    if (SCI_BLOCK_QUIC) {
        ensure('filter', 'FORWARD', ['-i', WG_INTERFACE, '-p', 'udp', '--dport', '443', '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable']);
    }
    console.log(`[sci-gateway] DNAT installed: ${proxyVip}:${httpPort} → ${ip}:${httpPort}, ${proxyVip}:443 → ${ip}:${tlsPort}` +
        (SCI_UNIVERSAL_TLS_INTERCEPT ? `, *:443 (wg0) → ${ip}:${tlsPort}` : '') +
        (SCI_BLOCK_QUIC ? ', UDP/443 blocked' : ''));
}
function configureNetwork(snap) {
    if (SKIP_NETWORK)
        return;
    const conf = renderServerConfig({
        privateKey: snap.server.privateKey,
        serverIp: snap.server.serverIp,
        subnet: snap.server.subnet,
        listenPort: snap.server.listenPort,
        peers: snap.peers.map(p => ({
            publicKey: p.publicKey,
            presharedKey: p.presharedKey,
            allowedIp: `${p.assignedIp}/32`,
            comment: `Device: ${p.deviceName} (${p.deviceId})`,
        })),
        postUp: 'iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE; iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT',
        postDown: 'iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE; iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT',
    });
    writeFileSync(WG_CONF_PATH, conf, { mode: 0o600 });
    const ipCheck = sh('ip', ['link', 'show', WG_INTERFACE]);
    if (ipCheck.code !== 0) {
        const up = sh('wg-quick', ['up', WG_INTERFACE]);
        if (up.code !== 0)
            throw new Error(`wg-quick up failed: ${up.stderr}`);
        console.log(`[sci-gateway] interface ${WG_INTERFACE} up with ${snap.peers.length} peers`);
        applyProxyDnat(PROXY_VIP_DEFAULT);
        return;
    }
    // Re-apply DNAT every sync — cheap, idempotent, survives sci-proxy
    // restarts (which change its docker IP).
    applyProxyDnat(PROXY_VIP_DEFAULT);
    const stripped = conf
        .split('\n')
        .filter(l => !/^Address|^PostUp|^PostDown|^DNS/i.test(l.trim()))
        .join('\n');
    const tempPath = `/tmp/${WG_INTERFACE}.sync.conf`;
    writeFileSync(tempPath, stripped, { mode: 0o600 });
    const sync = sh('wg', ['syncconf', WG_INTERFACE, tempPath]);
    if (sync.code !== 0)
        throw new Error(`wg syncconf failed: ${sync.stderr}`);
    console.log(`[sci-gateway] synced ${snap.peers.length} peers`);
}
async function syncOnce() {
    if (syncing)
        return;
    syncing = true;
    try {
        const snap = await fetchPeers();
        configureNetwork(snap);
        lastSnapshot = snap;
        lastSyncAt = new Date();
        lastSyncError = null;
    }
    catch (e) {
        lastSyncError = e.message;
        console.error('[sci-gateway] sync failed:', lastSyncError);
    }
    finally {
        syncing = false;
    }
}
async function syncLoop() {
    while (true) {
        await syncOnce();
        await new Promise(r => setTimeout(r, SYNC_INTERVAL_MS));
    }
}
const app = new Hono();
app.get('/', (c) => c.json({ name: 'sci-gateway', version: '0.1.0' }));
app.get('/health', (c) => c.json({
    ok: !lastSyncError && !!lastSnapshot,
    interface: WG_INTERFACE,
    peers: lastSnapshot?.peers.length ?? 0,
    lastSyncAt,
    lastSyncError,
    server: lastSnapshot ? {
        publicKey: lastSnapshot.server.publicKey,
        listenPort: lastSnapshot.server.listenPort,
        subnet: lastSnapshot.server.subnet,
    } : null,
}));
app.post('/reload', async (c) => {
    const auth = c.req.header('authorization');
    if (auth !== `Bearer ${INTERNAL_TOKEN}`)
        return c.json({ error: 'forbidden' }, 403);
    await syncOnce();
    return c.json({ ok: true, peers: lastSnapshot?.peers.length ?? 0 });
});
// Live peer state. Parses `wg show wg0 dump` (tab-separated machine output):
//   line 0: <priv> <pub> <port> <fwmark>
//   line 1+: <pub> <psk> <endpoint> <allowed-ips> <last-handshake-epoch> <rx> <tx> <keepalive>
app.get('/peers/state', async (c) => {
    const auth = c.req.header('authorization');
    if (auth !== `Bearer ${INTERNAL_TOKEN}`)
        return c.json({ error: 'forbidden' }, 403);
    if (SKIP_NETWORK) {
        return c.json({
            interface: WG_INTERFACE,
            lastSyncAt,
            lastSyncError,
            peers: lastSnapshot?.peers.map(p => ({
                publicKey: p.publicKey, deviceName: p.deviceName, deviceId: p.deviceId,
                assignedIp: p.assignedIp, online: false,
                lastHandshake: null, rxBytes: 0, txBytes: 0, endpoint: null,
            })) ?? [],
        });
    }
    const dump = sh('wg', ['show', WG_INTERFACE, 'dump']);
    if (dump.code !== 0) {
        return c.json({ error: `wg show failed: ${dump.stderr}`, peers: [] }, 500);
    }
    const lines = dump.stdout.trim().split('\n');
    const peerLines = lines.slice(1); // skip the interface line
    const now = Math.floor(Date.now() / 1000);
    const ONLINE_THRESHOLD_S = 180; // peer is "online" if handshaked in last 3 min
    const wgPeers = peerLines.map(line => {
        const [pubkey, _psk, endpoint, _allowed, lastHs, rx, tx, _ka] = line.split('\t');
        const lastHandshakeEpoch = parseInt(lastHs ?? '0', 10) || 0;
        return {
            publicKey: pubkey ?? '',
            endpoint: endpoint && endpoint !== '(none)' ? endpoint : null,
            lastHandshakeEpoch,
            lastHandshake: lastHandshakeEpoch ? new Date(lastHandshakeEpoch * 1000).toISOString() : null,
            online: lastHandshakeEpoch > 0 && (now - lastHandshakeEpoch) < ONLINE_THRESHOLD_S,
            rxBytes: parseInt(rx ?? '0', 10) || 0,
            txBytes: parseInt(tx ?? '0', 10) || 0,
        };
    });
    // Join with the device names we know about from the last snapshot
    const byKey = new Map(wgPeers.map(p => [p.publicKey, p]));
    const peers = (lastSnapshot?.peers ?? []).map(p => {
        const wg = byKey.get(p.publicKey) ?? {
            endpoint: null, lastHandshake: null, online: false,
            rxBytes: 0, txBytes: 0,
        };
        return {
            publicKey: p.publicKey,
            deviceName: p.deviceName,
            deviceId: p.deviceId,
            assignedIp: p.assignedIp,
            online: wg.online,
            lastHandshake: wg.lastHandshake,
            endpoint: wg.endpoint,
            rxBytes: wg.rxBytes,
            txBytes: wg.txBytes,
        };
    });
    return c.json({
        interface: WG_INTERFACE,
        lastSyncAt,
        lastSyncError,
        server: lastSnapshot ? {
            publicKey: lastSnapshot.server.publicKey,
            listenPort: lastSnapshot.server.listenPort,
            subnet: lastSnapshot.server.subnet,
        } : null,
        peers,
    });
});
console.log(`[sci-gateway] starting; control=${CONTROL_URL} interface=${WG_INTERFACE} skip-network=${SKIP_NETWORK}`);
syncLoop();
// Start the DNS server alongside the wireguard sync loop. Listens on UDP/53
// inside the container (root-bound, no perms issue since we run as root).
const DNS_ENABLED = process.env['SCI_DNS_ENABLED'] !== 'false';
if (DNS_ENABLED) {
    try {
        startDNSServer();
    }
    catch (e) {
        console.error('[sci-gateway] DNS server failed to start:', e.message);
    }
}
serve({ fetch: app.fetch, port: HTTP_PORT, hostname: '0.0.0.0' }, (info) => {
    console.log(`[sci-gateway] http on http://0.0.0.0:${info.port}`);
});
process.on('SIGTERM', () => {
    if (!SKIP_NETWORK && existsSync(WG_CONF_PATH)) {
        sh('wg-quick', ['down', WG_INTERFACE]);
    }
    process.exit(0);
});
//# sourceMappingURL=index.js.map