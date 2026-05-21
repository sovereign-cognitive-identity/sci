#!/usr/bin/env node
/**
 * Sci Control Plane
 *
 * The control plane is the API layer the dashboard, CLI, and gateway sync
 * against. It owns:
 *   - User accounts (signup/login, sessions)
 *   - Profiles (memory boundaries)
 *   - Devices (wireguard peers + sci agent tokens)
 *   - Audit log
 *   - Gateway peer export (for sci-gateway to fetch)
 *
 * It does NOT touch the data plane (proxy, anonymization, recall). Those
 * live in @sci/proxy. This separation is what makes the OSS → managed
 * product playbook viable: someone running the OSS data plane can swap
 * the control plane for their own.
 *
 * Default port: 3003.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { audit, authenticate, createDevice, createUser, createUserSession, ensureGatewayState, getGatewayState, listActivePeers, listDevices, queryAudit, reader, writer, renderClientConfig, revokeDevice, revokeSession, setExternalEndpoint, userCount, validateSession, adoptOrphanProfiles, } from '@sci/core';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
const PORT = parseInt(process.env['SCI_CONTROL_PORT'] ?? '3003');
const PROXY_INTERNAL_TOKEN = process.env['SCI_INTERNAL_TOKEN'] ?? '';
const PROXY_API_BASE = process.env['SCI_PROXY_API_BASE'] ?? 'http://10.13.13.2:3001';
const COOKIE_NAME = 'sci_session';
const COOKIE_SECURE = process.env['SCI_COOKIE_SECURE'] === 'true';
const app = new Hono();
app.use('*', cors({
    origin: (origin) => origin ?? '*',
    credentials: true,
}));
const authed = new Hono();
async function loadUser(c) {
    const cookie = getCookie(c, COOKIE_NAME);
    const header = c.req.header('authorization');
    const headerToken = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const token = cookie ?? headerToken;
    if (!token)
        return null;
    return validateSession(token);
}
authed.use('*', async (c, next) => {
    const user = await loadUser(c);
    if (!user)
        return c.json({ error: 'unauthorized' }, 401);
    c.set('user', user);
    await next();
});
// ── Health + setup status ─────────────────────────────────────────────────
app.get('/', (c) => c.json({
    name: 'sci-control',
    version: '0.1.0',
    endpoints: [
        'GET /api/setup/status',
        'POST /api/setup/init',
        'POST /api/auth/login',
        'POST /api/auth/logout',
        'GET  /api/me',
        'GET  /api/profiles',
        'POST /api/profiles',
        'GET  /api/devices',
        'POST /api/devices',
        'DELETE /api/devices/:id',
        'GET  /api/audit',
        'GET  /api/gateway/peers (internal)',
    ],
}));
// ── Phase 9: Sci CA cert download (SCI-86) ────────────────────────────
// Public — no session required. The CA is meant to be installed in the
// device's trust store, and serving it doesn't disclose anything sensitive
// (it's a public-key cert; the corresponding private key is never exposed).
const CA_CERT_PATH = process.env['SCI_CA_CERT_PATH']
    ?? join(homedir(), '.sci', 'certs', 'ca.crt');
// Private key path — only served to authenticated, enrolled devices.
const CA_KEY_PATH = process.env['SCI_CA_KEY_PATH']
    ?? join(homedir(), '.sci', 'certs', 'ca.key');
app.get('/api/ca/cert', (c) => {
    if (!existsSync(CA_CERT_PATH)) {
        return c.json({ error: 'CA cert not yet generated. Start sci-proxy with SCI_TLS_INTERCEPT=true and try again.' }, 503);
    }
    const pem = readFileSync(CA_CERT_PATH, 'utf-8');
    return new Response(pem, {
        status: 200,
        headers: {
            'content-type': 'application/x-x509-ca-cert',
            'content-disposition': 'attachment; filename="sci-ca.crt"',
        },
    });
});
// Authenticated — enrolled devices pull the CA private key during setup so they
// can sign leaf certs for TLS MITM. Never served without a valid session.
authed.get('/api/ca/key', (c) => {
    if (!existsSync(CA_KEY_PATH)) {
        return c.json({ error: 'CA key not found on control plane.' }, 503);
    }
    const pem = readFileSync(CA_KEY_PATH, 'utf-8');
    return new Response(pem, {
        status: 200,
        headers: {
            'content-type': 'application/x-pem-file',
            'content-disposition': 'attachment; filename="sci-ca.key"',
        },
    });
});
app.get('/api/ca/install-instructions', (c) => {
    return c.json({
        macos: {
            gui: [
                'Download sci-ca.crt',
                'Double-click → Keychain Access opens',
                'Find "Sci Local CA" → right-click → Get Info',
                'Expand "Trust" → set "When using this certificate" to "Always Trust"',
                'Close → enter macOS password to confirm',
            ],
            cli: 'sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/sci-ca.crt',
        },
        ios: [
            'AirDrop or email sci-ca.crt to your iPhone',
            'Tap to open → install profile via Settings',
            'Settings → General → VPN & Device Management → install',
            'CRITICAL: Settings → General → About → Certificate Trust Settings → toggle "Enable full trust for root certificates"',
            '(Without the last step, SSL still fails.)',
        ],
        windows: 'certutil -addstore -f "ROOT" sci-ca.crt   (run as Administrator)',
        linux: {
            debian_ubuntu: 'sudo cp sci-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates',
            fedora_rhel: 'sudo cp sci-ca.crt /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust',
            note: 'Node and Python ignore the system trust store by default. For Node, set NODE_EXTRA_CA_CERTS=/path/to/sci-ca.crt. For Python, set SSL_CERT_FILE.',
        },
    });
});
app.get('/health', async (c) => {
    try {
        await reader.query('SELECT 1');
        const gw = await getGatewayState();
        return c.json({ ok: true, db: true, gateway: !!gw });
    }
    catch (e) {
        return c.json({ ok: false, error: e.message }, 500);
    }
});
app.get('/api/setup/status', async (c) => {
    const count = await userCount();
    const gw = await getGatewayState();
    return c.json({
        initialized: count > 0,
        userCount: count,
        gateway: gw ? {
            publicKey: gw.wgPublicKey,
            listenPort: gw.wgListenPort,
            subnet: gw.wgSubnet,
            externalEndpoint: gw.externalEndpoint,
        } : null,
    });
});
// ── Setup: first-run initialization ───────────────────────────────────────
app.post('/api/setup/init', async (c) => {
    const existingCount = await userCount();
    if (existingCount > 0)
        return c.json({ error: 'already initialized' }, 409);
    const body = await c.req.json().catch(() => ({}));
    if (!body.email || !body.password)
        return c.json({ error: 'email and password required' }, 400);
    if (body.password.length < 8)
        return c.json({ error: 'password must be 8+ chars' }, 400);
    // Bootstrap admin user
    const user = await createUser({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
        isAdmin: true,
    });
    // Adopt any orphan profiles (pre-multi-tenant 'work' / 'personal')
    await adoptOrphanProfiles(user.id);
    // Create a default profile if none exist for this user
    const { rows: profCheck } = await reader.query('SELECT COUNT(*)::text AS c FROM profiles WHERE user_id = $1', [user.id]);
    if (parseInt(profCheck[0].c, 10) === 0) {
        await writer.query(`INSERT INTO profiles (name, user_id) VALUES ($1, $2)`, [`${user.email.split('@')[0]}-work`, user.id]);
    }
    // Initialize gateway state
    const gw = await ensureGatewayState({
        externalEndpoint: body.externalEndpoint,
    });
    // Create session
    const session = await createUserSession(user.id, {
        userAgent: c.req.header('user-agent'),
        ipAddress: c.req.header('x-forwarded-for') ?? '',
    });
    setCookie(c, COOKIE_NAME, session.token, {
        httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax',
        path: '/', maxAge: 60 * 60 * 24 * 30,
    });
    await audit({ userId: user.id, action: 'user.create', metadata: { email: user.email } });
    return c.json({
        user: { id: user.id, email: user.email, displayName: user.displayName },
        gateway: { publicKey: gw.wgPublicKey, listenPort: gw.wgListenPort },
        sessionToken: session.token, // also returned for non-cookie clients
    }, 201);
});
// ── Auth ──────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.email || !body.password)
        return c.json({ error: 'email and password required' }, 400);
    const user = await authenticate(body.email, body.password);
    if (!user) {
        await audit({ action: 'auth.failed', target: body.email, outcome: 'denied' });
        return c.json({ error: 'invalid credentials' }, 401);
    }
    const session = await createUserSession(user.id, {
        userAgent: c.req.header('user-agent'),
        ipAddress: c.req.header('x-forwarded-for') ?? '',
    });
    setCookie(c, COOKIE_NAME, session.token, {
        httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax',
        path: '/', maxAge: 60 * 60 * 24 * 30,
    });
    await audit({ userId: user.id, action: 'auth.login' });
    return c.json({
        user: { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin },
        sessionToken: session.token,
    });
});
app.post('/api/auth/logout', async (c) => {
    const cookie = getCookie(c, COOKIE_NAME);
    if (cookie) {
        await revokeSession(cookie).catch(() => { });
        deleteCookie(c, COOKIE_NAME, { path: '/' });
    }
    return c.json({ ok: true });
});
// ── Authenticated routes ──────────────────────────────────────────────────
authed.get('/api/me', (c) => {
    const u = c.get('user');
    return c.json({ id: u.id, email: u.email, displayName: u.displayName, isAdmin: u.isAdmin });
});
authed.get('/api/profiles', async (c) => {
    const u = c.get('user');
    const { rows } = await reader.query(`SELECT id, name, created_at FROM profiles WHERE user_id = $1 ORDER BY created_at`, [u.id]);
    return c.json({ profiles: rows });
});
authed.post('/api/profiles', async (c) => {
    const u = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    if (!body.name)
        return c.json({ error: 'name required' }, 400);
    const { rows } = await writer.query(`INSERT INTO profiles (name, user_id) VALUES ($1, $2) RETURNING id`, [body.name, u.id]);
    await audit({ userId: u.id, action: 'profile.create', target: body.name });
    return c.json({ id: rows[0].id, name: body.name }, 201);
});
authed.get('/api/devices', async (c) => {
    const u = c.get('user');
    const includeRevoked = c.req.query('includeRevoked') === 'true';
    const devices = await listDevices({ userId: u.id, includeRevoked });
    return c.json({ devices });
});
authed.post('/api/devices', async (c) => {
    const u = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    if (!body.name)
        return c.json({ error: 'name required' }, 400);
    // Default profileId: first profile
    let profileId = body.profileId;
    if (!profileId) {
        const { rows } = await reader.query(`SELECT id FROM profiles WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [u.id]);
        if (!rows[0])
            return c.json({ error: 'no profile — create one first' }, 400);
        profileId = rows[0].id;
    }
    const result = await createDevice({
        userId: u.id,
        profileId,
        name: body.name,
        platform: body.platform,
        tier: body.tier ?? 'standard',
        publicKey: body.publicKey,
    });
    // Render client wireguard config. Tunnel mode determines AllowedIPs:
    //   split → only the gateway's wg subnet (sci-only, normal internet stays direct)
    //   full  → 0.0.0.0/0 + ::/0 (everything routes through the VPS — exit-node mode)
    const tunnelMode = body.tunnelMode ?? 'split';
    const allowedIps = tunnelMode === 'full'
        ? '0.0.0.0/0, ::/0'
        : result.server.subnet;
    const clientConfig = renderClientConfig({
        privateKey: result.wgPrivateKey || '<paste your private key here>',
        assignedIp: result.device.wgAssignedIp,
        subnetCidr: result.server.subnet.split('/')[1] ?? '24',
        serverPublicKey: result.server.publicKey,
        serverEndpoint: result.server.endpoint,
        presharedKey: result.wgPresharedKey,
        allowedIps,
        // Point peers at the gateway's DNS resolver so AI-augmented service
        // lookups can be observed and surfaced in the dashboard's Exposure tab.
        dns: result.server.serverIp,
        proxyHttpUrl: `http://${result.server.proxyIp}:3001`,
        proxyApiBase: `http://${result.server.proxyIp}:3001`,
    });
    await audit({ userId: u.id, agentId: result.device.agentId, deviceId: result.device.id,
        action: 'device.add', target: body.name });
    // Best-effort: tell the gateway to reload
    reloadGateway().catch(() => { });
    return c.json({
        device: result.device,
        wireguardConfig: clientConfig,
        wireguardPrivateKey: result.wgPrivateKey || null,
        presharedKey: result.wgPresharedKey,
        agentToken: result.agentToken,
        server: result.server,
        tunnelMode,
    }, 201);
});
authed.delete('/api/devices/:id', async (c) => {
    const u = c.get('user');
    const id = c.req.param('id');
    await revokeDevice(id, u.id);
    await audit({ userId: u.id, deviceId: id, action: 'device.revoke' });
    reloadGateway().catch(() => { });
    return c.json({ ok: true });
});
authed.get('/api/audit', async (c) => {
    const u = c.get('user');
    const limit = parseInt(c.req.query('limit') ?? '100');
    const action = c.req.query('action');
    const rows = await queryAudit({ userId: u.id, limit, action });
    return c.json({ entries: rows });
});
// ── Aggregated stats for the live dashboard ──────────────────────────────
authed.get('/api/stats', async (c) => {
    const u = c.get('user');
    const [counts, recent, perMinute, devices, gw] = await Promise.all([
        reader.query(`
      SELECT
        (SELECT COUNT(*)::int FROM episodic_memories) AS episodic,
        (SELECT COUNT(*)::int FROM semantic_nodes)    AS semantic,
        (SELECT COUNT(*)::int FROM identity_facts)    AS identity,
        (SELECT COUNT(*)::int FROM embeddings)        AS vectors,
        (SELECT COUNT(*)::int FROM agents)            AS agents
    `),
        // Same OR-NULL clause as the SSE stream — proxy.request rows from
        // tunneled clients arrive with user_id NULL today because docker's
        // POSTROUTING MASQUERADE rule on the gateway rewrites the WG-peer
        // source IP to the gateway container's docker IP before it reaches
        // the proxy, defeating source-IP→device→user resolution. Proper fix:
        // SCI-104 (drop MASQUERADE; preserve source IP). Until then, surface
        // null-user proxy.* rows to admin in single-tenant Hub mode.
        reader.query(`
      SELECT action, outcome, COUNT(*)::int AS c
      FROM audit_log
      WHERE (user_id = $1 OR user_id IS NULL)
        AND created_at > NOW() - INTERVAL '1 hour'
      GROUP BY action, outcome
      ORDER BY c DESC LIMIT 20
    `, [u.id]),
        reader.query(`
      SELECT date_trunc('minute', created_at) AS minute, COUNT(*)::int AS c
      FROM audit_log
      WHERE (user_id = $1 OR user_id IS NULL)
        AND created_at > NOW() - INTERVAL '60 minutes'
      GROUP BY 1 ORDER BY 1
    `, [u.id]),
        reader.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'active')::int  AS active,
             COUNT(*) FILTER (WHERE status = 'revoked')::int AS revoked,
             COUNT(*) FILTER (WHERE status = 'active'
                              AND last_seen_at > NOW() - INTERVAL '5 minutes')::int AS online
      FROM devices WHERE user_id = $1
    `, [u.id]),
        getGatewayState(),
    ]);
    return c.json({
        memory: counts.rows[0],
        actionsLastHour: recent.rows,
        perMinute: perMinute.rows.map((r) => ({ minute: r.minute, c: r.c })),
        devices: devices.rows[0],
        gateway: gw ? {
            publicKey: gw.wgPublicKey,
            listenPort: gw.wgListenPort,
            subnet: gw.wgSubnet,
            externalEndpoint: gw.externalEndpoint,
        } : null,
    });
});
// ── Server-Sent Events: audit log stream ─────────────────────────────────
// Polls audit_log for new rows every second, emits as SSE. Cheap on a
// small system. Replace with LISTEN/NOTIFY when scale demands it.
authed.get('/api/stream', async (c) => {
    const u = c.get('user');
    // Anchor at the latest existing id so we only get new rows.
    const { rows: anchor } = await reader.query(`SELECT COALESCE(MAX(id), 0)::text AS id FROM audit_log`);
    let lastId = BigInt(anchor[0]?.id ?? '0');
    // SSE response with a manual ReadableStream (Hono's streamSSE works too,
    // but a plain stream avoids an extra dep and gives explicit ping control).
    const stream = new ReadableStream({
        async start(controller) {
            const enc = new TextEncoder();
            const send = (event, data) => {
                controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            };
            send('hello', { now: new Date().toISOString(), lastId: lastId.toString() });
            // Register this stream so /api/exposure/log can push 'exposure' events.
            let subs = userStreams.get(u.id);
            if (!subs) {
                subs = new Set();
                userStreams.set(u.id, subs);
            }
            subs.add(send);
            let alive = true;
            const stop = () => {
                alive = false;
                subs?.delete(send);
                if (subs && subs.size === 0)
                    userStreams.delete(u.id);
                try {
                    controller.close();
                }
                catch { }
            };
            c.req.raw.signal.addEventListener('abort', stop);
            // Heartbeat
            const heartbeat = setInterval(() => {
                if (!alive)
                    return;
                try {
                    controller.enqueue(enc.encode(': hb\n\n'));
                }
                catch {
                    stop();
                }
            }, 15000);
            // Poll loop.
            //
            // Filter: rows belonging to this user OR rows with no user attribution
            // yet (proxy.request rows from devices not yet bound to a user via the
            // source-IP identity resolver). The latter is single-tenant-Hub-safe;
            // when we move to multi-tenant Cloud, every audit row will carry a
            // user_id and this OR-clause becomes redundant. SCI-104 is the proper
            // fix that ties source-IP-only requests back to a user_id at write time.
            while (alive) {
                try {
                    const { rows } = await reader.query(`SELECT id::text, user_id, agent_id, device_id, action, target,
                    outcome, metadata, created_at
             FROM audit_log
             WHERE id > $1 AND (user_id = $2 OR user_id IS NULL)
             ORDER BY id ASC LIMIT 50`, [lastId.toString(), u.id]);
                    for (const r of rows) {
                        send('audit', {
                            id: r.id, userId: r.user_id, agentId: r.agent_id, deviceId: r.device_id,
                            action: r.action, target: r.target, outcome: r.outcome,
                            metadata: r.metadata ?? {}, createdAt: r.created_at,
                        });
                        lastId = BigInt(r.id);
                    }
                }
                catch (e) {
                    send('error', { message: e.message });
                }
                await new Promise(r => setTimeout(r, 1000));
            }
            clearInterval(heartbeat);
        },
    });
    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
});
// ── Gateway state proxy (for dashboard "Live" tab) ──────────────────────
// Forwards to sci-gateway:3004/peers/state with the internal token. Lets
// the dashboard read peer handshake/transfer state without exposing the
// internal token to the browser.
authed.get('/api/gateway/state', async (c) => {
    const url = process.env['SCI_GATEWAY_URL'] ?? 'http://sci-gateway:3004';
    try {
        const res = await fetch(`${url}/peers/state`, {
            headers: { authorization: `Bearer ${PROXY_INTERNAL_TOKEN}` },
        });
        if (!res.ok)
            return c.json({ error: `gateway returned ${res.status}` }, 502);
        return c.json(await res.json());
    }
    catch (e) {
        return c.json({ error: e.message }, 502);
    }
});
// ── Exposure (Phase 8) ───────────────────────────────────────────────────
// Catalog of AI-augmented services + per-event log surfaced in the dashboard.
import { listExposureServices, getExposureService } from '@sci/core/exposure-services';
authed.get('/api/exposure/services', (c) => {
    return c.json({ services: listExposureServices() });
});
authed.get('/api/exposure/events', async (c) => {
    const u = c.get('user');
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '100'), 1), 500);
    const sinceQ = c.req.query('since');
    const params = [u.id];
    let where = `user_id = $1`;
    if (sinceQ) {
        params.push(new Date(sinceQ));
        where += ` AND created_at > $${params.length}`;
    }
    params.push(limit);
    const { rows } = await reader.query(`SELECT id::text, user_id, device_id, hostname, vendor_id,
            query_type, resolved_ip, metadata, created_at
     FROM exposure_events WHERE ${where}
     ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return c.json({
        entries: rows.map((r) => ({
            id: r.id, deviceId: r.device_id, hostname: r.hostname,
            vendorId: r.vendor_id, queryType: r.query_type, resolvedIp: r.resolved_ip,
            metadata: r.metadata ?? {}, createdAt: r.created_at,
            service: getExposureService(r.vendor_id),
        })),
    });
});
// Aggregate counts per vendor for the Overview cards.
authed.get('/api/exposure/summary', async (c) => {
    const u = c.get('user');
    const { rows } = await reader.query(`SELECT vendor_id, COUNT(*)::int AS c, MAX(created_at) AS last_seen
     FROM exposure_events
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
     GROUP BY vendor_id ORDER BY c DESC`, [u.id]);
    return c.json({
        summary: rows.map((r) => ({
            vendorId: r.vendor_id, count: r.c, lastSeen: r.last_seen,
            service: getExposureService(r.vendor_id),
        })),
    });
});
// Internal endpoint called by the gateway DNS server when a query matches
// the curated list. Maps the peer IP back to a device, then writes the row.
app.post('/api/exposure/log', async (c) => {
    const auth = c.req.header('authorization');
    if (!PROXY_INTERNAL_TOKEN || auth !== `Bearer ${PROXY_INTERNAL_TOKEN}`) {
        return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    if (!body.hostname || !body.vendorId)
        return c.json({ error: 'hostname + vendorId required' }, 400);
    // Resolve peer IP → device → user. If the IP isn't known, log with nulls
    // (still useful for debugging) but skip pushing to a user's stream.
    let userId = null;
    let deviceId = null;
    if (body.peerIp) {
        const { rows } = await reader.query(`SELECT id, user_id FROM devices
       WHERE wg_assigned_ip = $1 AND status = 'active' LIMIT 1`, [body.peerIp]);
        if (rows[0]) {
            deviceId = rows[0].id;
            userId = rows[0].user_id;
        }
    }
    const ins = await writer.query(`INSERT INTO exposure_events
       (user_id, device_id, hostname, vendor_id, query_type, resolved_ip)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::text`, [userId, deviceId, body.hostname, body.vendorId,
        body.queryType ?? null, body.resolvedIp ?? null]);
    // Push to anyone with an active SSE stream for that user.
    if (userId) {
        pushExposureEvent(userId, {
            id: ins.rows[0].id,
            deviceId, hostname: body.hostname, vendorId: body.vendorId,
            queryType: body.queryType, resolvedIp: body.resolvedIp,
            createdAt: new Date().toISOString(),
            service: getExposureService(body.vendorId),
        });
    }
    return c.json({ ok: true, id: ins.rows[0].id });
});
// ── SSE multiplexer (used by /api/stream) ─────────────────────────────────
// Keep a per-user list of open response controllers so /api/exposure/log
// can fan out events to live dashboards without re-querying.
const userStreams = new Map();
function pushExposureEvent(userId, payload) {
    const subs = userStreams.get(userId);
    if (!subs || subs.size === 0)
        return;
    for (const send of subs) {
        try {
            send('exposure', payload);
        }
        catch { /* dead subscriber */ }
    }
}
// ── Internal: gateway peer sync ────────────────────────────────────────────
// Called by sci-gateway every few seconds to refresh its peer list.
// Requires SCI_INTERNAL_TOKEN match.
app.get('/api/gateway/peers', async (c) => {
    const auth = c.req.header('authorization');
    if (!PROXY_INTERNAL_TOKEN || auth !== `Bearer ${PROXY_INTERNAL_TOKEN}`) {
        return c.json({ error: 'forbidden' }, 403);
    }
    const gw = await getGatewayState();
    if (!gw)
        return c.json({ error: 'gateway not initialized' }, 412);
    const peers = await listActivePeers();
    return c.json({
        server: {
            privateKey: gw.wgPrivateKey,
            publicKey: gw.wgPublicKey,
            listenPort: gw.wgListenPort,
            subnet: gw.wgSubnet,
            serverIp: gw.wgServerIp,
        },
        peers,
    });
});
app.post('/api/gateway/external-endpoint', async (c) => {
    const auth = c.req.header('authorization');
    if (!PROXY_INTERNAL_TOKEN || auth !== `Bearer ${PROXY_INTERNAL_TOKEN}`) {
        return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    if (!body.endpoint)
        return c.json({ error: 'endpoint required' }, 400);
    await setExternalEndpoint(body.endpoint);
    return c.json({ ok: true });
});
// ── Memory API (EP3) ────────────────────────────────────────────────────────
// Encrypted blobs are written by the device before upload and decrypted after
// download. The control plane stores ciphertext only — no plaintext content.
//
// Schema: memory_blobs table (added to db/init.sql separately)
//   id UUID, user_id UUID, device_id UUID, blob_type TEXT,
//   profile_id UUID, encrypted_blob TEXT, created_at TIMESTAMPTZ
//
// Sync protocol: push-on-write + pull-on-startup.
//   POST /api/memories       — device writes a new blob after local store
//   GET  /api/memories       — device pulls blobs since ?since=<timestamp>
//   GET  /api/memories/stats — count per type for debugging
//   DELETE /api/memories/:id — device-initiated delete (rare)

authed.post('/api/memories', async (c) => {
    const u = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    if (!body.encryptedBlob)
        return c.json({ error: 'encryptedBlob required' }, 400);
    if (!body.blobType || !['episodic', 'semantic', 'identity'].includes(body.blobType))
        return c.json({ error: 'blobType must be episodic | semantic | identity' }, 400);
    // Resolve device from bearer token (agent token → agent → device)
    const deviceRow = await resolveDeviceFromSession(u.id, c.req.header('authorization'));
    const deviceId = deviceRow?.id ?? null;
    const profileId = body.profileId ?? null;
    const { rows } = await writer.query(`INSERT INTO memory_blobs
        (user_id, device_id, profile_id, blob_type, encrypted_blob)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id::text, created_at`, [u.id, deviceId, profileId, body.blobType, body.encryptedBlob]);
    return c.json({ id: rows[0].id, createdAt: rows[0].created_at }, 201);
});

authed.get('/api/memories', async (c) => {
    const u = c.get('user');
    const since = c.req.query('since');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '1000'), 5000);
    const profileId = c.req.query('profileId');
    const blobType = c.req.query('blobType');
    const params = [u.id];
    const conditions = ['user_id = $1'];
    if (since) {
        params.push(new Date(since));
        conditions.push(`created_at > $${params.length}`);
    }
    if (profileId) {
        params.push(profileId);
        conditions.push(`profile_id = $${params.length}`);
    }
    if (blobType) {
        params.push(blobType);
        conditions.push(`blob_type = $${params.length}`);
    }
    params.push(limit);
    const where = conditions.join(' AND ');
    const { rows } = await reader.query(`SELECT id::text, device_id::text, profile_id::text,
            blob_type, encrypted_blob, created_at
       FROM memory_blobs
       WHERE ${where}
       ORDER BY created_at ASC
       LIMIT $${params.length}`, params);
    return c.json({
        blobs: rows.map(r => ({
            id: r.id, deviceId: r.device_id, profileId: r.profile_id,
            blobType: r.blob_type, encryptedBlob: r.encrypted_blob, createdAt: r.created_at,
        })),
        count: rows.length,
        hasMore: rows.length === limit,
    });
});

authed.get('/api/memories/stats', async (c) => {
    const u = c.get('user');
    const { rows } = await reader.query(`SELECT blob_type, COUNT(*)::int AS c, MAX(created_at) AS last_sync
       FROM memory_blobs WHERE user_id = $1 GROUP BY blob_type`, [u.id]);
    return c.json({ stats: rows });
});

authed.delete('/api/memories/:id', async (c) => {
    const u = c.get('user');
    const id = c.req.param('id');
    const { rowCount } = await writer.query(`DELETE FROM memory_blobs WHERE id = $1 AND user_id = $2`, [id, u.id]);
    if (rowCount === 0)
        return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
});

// Resolve the device row for the authenticated user from their session.
// The authed middleware validates the session cookie/bearer token against
// user_sessions. For device-specific attribution we additionally look up
// the device associated with the request's agent token, if present.
async function resolveDeviceFromSession(userId, authHeader) {
    if (!authHeader?.startsWith('Bearer '))
        return null;
    const token = authHeader.slice(7);
    if (!token.startsWith('sci_'))
        return null; // session token, not agent token — can't resolve device
    try {
        const { validateToken } = await import('@sci/core');
        const agent = await validateToken(token);
        if (!agent)
            return null;
        const { rows } = await reader.query(`SELECT id FROM devices WHERE agent_id = $1 AND user_id = $2 LIMIT 1`, [agent.agentId, userId]);
        return rows[0] ?? null;
    } catch {
        return null;
    }
}

// ── Device invite flow (EP4) ─────────────────────────────────────────────────
// Two-step enrollment for headless/SSH machines where browser OAuth isn't
// available. An already-enrolled device generates a one-time token; the new
// device redeems it via POST /api/devices/invite/redeem.
//
// Invite tokens live in device_invites table (added to db/init.sql).

authed.post('/api/devices/invite', async (c) => {
    const u = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const ttlMinutes = Math.min(Math.max(parseInt(body.ttlMinutes ?? '15'), 5), 60);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    await writer.query(`INSERT INTO device_invites (user_id, token, expires_at)
       VALUES ($1, $2, $3)`, [u.id, token, expiresAt]);
    await audit({ userId: u.id, action: 'device.invite.create', metadata: { token, expiresAt } });
    return c.json({ token, expiresAt, ttlMinutes, hint: `sci --setup --token ${token}` }, 201);
});

// Redeem an invite token — called by the new device during setup.
// Does NOT require an existing session (the token is the credential).
app.post('/api/devices/invite/redeem', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.token || !body.name)
        return c.json({ error: 'token and name required' }, 400);
    // Validate invite
    const { rows: inv } = await reader.query(`SELECT user_id, expires_at, used_at FROM device_invites WHERE token = $1`, [body.token]);
    const invite = inv[0];
    if (!invite)
        return c.json({ error: 'invalid token' }, 401);
    if (invite.used_at)
        return c.json({ error: 'token already used' }, 401);
    if (new Date(invite.expires_at) < new Date())
        return c.json({ error: 'token expired' }, 401);
    // Mark token as used
    await writer.query(`UPDATE device_invites SET used_at = NOW() WHERE token = $1`, [body.token]);
    // Pick the user's first profile
    const { rows: profiles } = await reader.query(`SELECT id FROM profiles WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [invite.user_id]);
    if (!profiles[0])
        return c.json({ error: 'no profile found — create one first' }, 400);
    const profileId = profiles[0].id;
    // Register the device
    const result = await createDevice({
        userId: invite.user_id,
        profileId,
        name: body.name,
        platform: body.platform,
        tier: 'standard',
        publicKey: body.publicKey,
    });
    // Pull the CA cert + key to return to the new device so it can do TLS MITM.
    const caCert = existsSync(CA_CERT_PATH) ? readFileSync(CA_CERT_PATH, 'utf-8') : null;
    const caKey = existsSync(CA_KEY_PATH) ? readFileSync(CA_KEY_PATH, 'utf-8') : null;
    await audit({ userId: invite.user_id, deviceId: result.device.id, action: 'device.invite.redeem', target: body.name });
    return c.json({
        device: result.device,
        agentToken: result.agentToken,
        caCert,
        caKey,
        server: result.server,
    }, 201);
});

// Mount authed routes
app.route('/', authed);
async function reloadGateway() {
    const url = process.env['SCI_GATEWAY_RELOAD_URL'];
    if (!url)
        return;
    await fetch(url, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${PROXY_INTERNAL_TOKEN}` },
    }).catch(() => { });
}
// ── Boot ──────────────────────────────────────────────────────────────────
console.log(`[sci-control] starting on port ${PORT}`);
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
    console.log(`[sci-control] listening on http://0.0.0.0:${info.port}`);
    console.log(`[sci-control] proxy api base: ${PROXY_API_BASE}`);
});
//# sourceMappingURL=index.js.map