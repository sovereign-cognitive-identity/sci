/**
 * Phase 9 — TLS interception server.
 *
 * Listens on a high port inside the proxy container (8443 by default).
 * The gateway DNATs `10.13.13.2:443` to `sci-proxy:8443`. Peers querying
 * the gateway DNS for `api.anthropic.com` / `claude.ai` / etc. get back
 * `10.13.13.2`, and their TLS handshake lands here.
 *
 * For each connection:
 *   1. SNI callback generates a leaf cert signed by the Sci CA
 *   2. TLS terminates here
 *   3. We look up the source WireGuard IP → device → user (for identity,
 *      memory recall, and audit)
 *   4. AI-aware paths (`/v1/messages`, `/v1/chat/completions`, etc.)
 *      are dispatched into the existing handlers, which anonymize +
 *      recall + forward
 *   5. Other paths (cookie-authed claude.ai web traffic, etc.) are
 *      transparently piped to the real upstream so chat sessions work
 *      without modification
 *
 * Identity model: a request inherits the identity of whichever device's
 * WireGuard tunnel it arrived through. No `Authorization: Bearer sci_…`
 * is needed here — that header isn't present on browser traffic. The
 * proxy still validates the WG peer in the gateway (only registered
 * devices can hand the proxy a packet), so the source-IP-based identity
 * is trustworthy.
 */
import https from 'https';
import { audit, touchDeviceLastSeen } from '@sci/core';
import { ensureCACert, makeSNICallback } from './tls.js';
import { resolveReal } from './dns-resolver.js';
import { handleAnthropicMessages } from './handlers/anthropic.js';
import { handleOpenAIChat } from './handlers/openai.js';
import { handleGoogleGemini } from './handlers/google.js';
import { lookupIdentityByPeerIp } from './identity.js';
import { makeHandlerContext as makeHandlerContextShared, pipeResponse as pipeResponseShared, ANONYMOUS_AGENT as ANONYMOUS_AGENT_SHARED, } from './handler-context.js';
export const TLS_INTERCEPT_PORT = parseInt(process.env['SCI_TLS_INTERCEPT_PORT'] ?? '8443');
const TLS_BIND = process.env['SCI_TLS_INTERCEPT_BIND'] ?? '0.0.0.0';
// Hostname → API format we know how to anonymize. Other hostnames pass
// through transparently.
const KNOWN_AI_HOSTS = {
    'api.anthropic.com': 'anthropic',
    'api.openai.com': 'openai',
    'openrouter.ai': 'openai',
    'generativelanguage.googleapis.com': 'google',
};
// Hop-by-hop headers (per RFC 7230) — never forward upstream
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
// Identity lookup (peer IP → agent / device / user) lives in identity.ts and
// is shared with the Hono auth middleware so both entry paths attribute
// audit rows and memory writes to the same user.
/** Strip hop-by-hop headers and return a record safe to forward. */
function safeHeaders(req) {
    const out = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(k.toLowerCase()))
            continue;
        if (v === undefined)
            continue;
        out[k] = v;
    }
    return out;
}
/** Transparent passthrough — for hostnames we don't anonymize. Streams
 *  request and response without buffering so cookie-authed flows,
 *  websockets, and SSE all work unmodified.
 *
 *  Still writes an audit row so the dashboard's Live tab + Audit log
 *  reflect the activity. Passthrough = "Sci was on the path but didn't
 *  modify content"; the audit row carries `via=tls-passthrough` to
 *  distinguish from anonymized requests. */
async function passthrough(req, hostname, res, identity) {
    const t0 = Date.now();
    let outcome = 'ok';
    let upstreamStatus = 0;
    const realIP = await resolveReal(hostname).catch(() => hostname);
    const headers = safeHeaders(req);
    headers['host'] = hostname;
    await new Promise((resolve) => {
        const proxyReq = https.request({
            host: realIP, servername: hostname, port: 443,
            path: req.url ?? '/', method: req.method ?? 'GET',
            headers, rejectUnauthorized: true,
        }, (proxyRes) => {
            upstreamStatus = proxyRes.statusCode ?? 502;
            if (upstreamStatus >= 400)
                outcome = 'error';
            res.writeHead(upstreamStatus, proxyRes.headers);
            proxyRes.pipe(res);
            proxyRes.on('end', () => resolve());
            proxyRes.on('error', () => { outcome = 'error'; resolve(); });
        });
        proxyReq.on('error', (err) => {
            outcome = 'error';
            upstreamStatus = 502;
            process.stderr.write(`[tls-intercept] passthrough ${hostname} error: ${err.message}\n`);
            if (!res.headersSent)
                res.writeHead(502);
            res.end();
            resolve();
        });
        req.pipe(proxyReq);
    });
    // Audit even when we couldn't resolve identity from source IP (the gateway
    // MASQUERADE rule rewrites src to a docker-internal IP, defeating the
    // device lookup — see SCI-104). Anonymous-attribution rows still let the
    // dashboard show that traffic flowed through Sci. Once SCI-104 lands the
    // identity will populate properly.
    audit({
        userId: identity?.userId ?? null,
        agentId: identity?.context.agentId ?? null,
        deviceId: identity?.deviceId ?? null,
        action: 'proxy.request',
        target: `${hostname}${req.url ?? ''}`,
        outcome,
        metadata: {
            method: req.method ?? 'GET',
            status: upstreamStatus,
            ms: Date.now() - t0,
            via: 'tls-passthrough',
        },
    }).catch(() => { });
    if (identity) {
        touchDeviceLastSeen(identity.context.agentId).catch(() => { });
    }
}
// makeHandlerContext + ANONYMOUS_AGENT now live in handler-context.ts and
// are shared with @sci/agent (SCI-117). Re-aliased here so the rest of
// this file's references keep compiling without a global rename.
const makeHandlerContext = makeHandlerContextShared;
const ANONYMOUS_AGENT = ANONYMOUS_AGENT_SHARED;
async function handleIntercepted(req, hostname, format, identity, adapter, openrouterKey, res) {
    // Buffer the body. AI request bodies are small JSON.
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const t0 = Date.now();
    const agent = identity?.context ?? ANONYMOUS_AGENT;
    const ctx = makeHandlerContext(req, body, agent);
    let outcome = 'ok';
    let status = 0;
    try {
        const result = format === 'anthropic'
            ? await handleAnthropicMessages(ctx, adapter, openrouterKey)
            : format === 'google'
                ? await handleGoogleGemini(ctx, adapter)
                : await handleOpenAIChat(ctx, adapter, openrouterKey);
        status = result instanceof Response ? result.status : 200;
        if (status >= 400)
            outcome = 'error';
        await pipeResponse(result, res);
    }
    catch (err) {
        outcome = 'error';
        status = 502;
        process.stderr.write(`[tls-intercept] handler ${hostname} error: ${err}\n`);
        if (!res.headersSent)
            res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'sci_proxy_error', message: String(err) } }));
    }
    finally {
        // Surface the request in the dashboard's Live tab and Audit log. The
        // Hono middleware that does this for the HTTP path doesn't run here —
        // TLS interception bypasses the router entirely.
        audit({
            userId: identity?.userId ?? null,
            // Don't write the all-zeros placeholder agentId — FK to agents would
            // fail. Null is fine; the row still appears in dashboard stream.
            agentId: identity?.context.agentId ?? null,
            deviceId: identity?.deviceId ?? null,
            action: 'proxy.request',
            target: `${hostname}${req.url ?? ''}`,
            outcome,
            metadata: {
                method: req.method ?? 'POST',
                status,
                ms: Date.now() - t0,
                via: 'tls-intercept',
                format,
            },
        }).catch(() => { });
        if (identity) {
            touchDeviceLastSeen(identity.context.agentId).catch(() => { });
        }
    }
}
// pipeResponse lives in handler-context.ts now and is shared with
// @sci/agent (SCI-117). Re-aliased so the rest of this file compiles.
const pipeResponse = pipeResponseShared;
export function startTLSInterceptServer(adapter, openrouterKey) {
    const ca = ensureCACert();
    const server = https.createServer({
        SNICallback: makeSNICallback(ca),
        // Modern browsers and HTTP clients send TLS ALPN advertising 'h2' (HTTP/2)
        // and 'http/1.1'. Without ALPN handling, OpenSSL responds with
        // 'no_application_protocol_alert' and the client disconnects.
        //
        // We advertise both h2 and http/1.1 in ALPNProtocols — but pick http/1.1
        // via ALPNCallback whenever possible, since our handler only speaks
        // HTTP/1.1 (using node's http2 module is a future refactor). If a
        // client offers ONLY 'h2' (some strict HTTP/2-only stacks do this),
        // we accept it and let it fail at the protocol layer rather than the
        // TLS layer — at least that surfaces more diagnostic data.
        // ALPNCallback (no ALPNProtocols — Node treats them as mutually
        // exclusive). Pick http/1.1 whenever the client offers it; only
        // fall back to h2 if that's all the client supports (currently
        // would fail at the protocol layer since we don't speak HTTP/2,
        // but at least surfaces a parseable error rather than a TLS one).
        ALPNCallback: ({ protocols }) => {
            if (protocols.includes('http/1.1'))
                return 'http/1.1';
            if (protocols.includes('h2'))
                return 'h2';
            return undefined;
        },
    }, async (req, res) => {
        const hostname = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
        const peerIp = req.socket.remoteAddress ?? '';
        const cleanPeerIp = peerIp.replace(/^::ffff:/, '');
        // Identify the device. Without an identity, the request can't be
        // attributed for memory recall / audit — but we still pass through
        // transparently so the user's session isn't broken.
        const identity = await lookupIdentityByPeerIp(cleanPeerIp).catch(() => null);
        const format = KNOWN_AI_HOSTS[hostname];
        // Strip query string + trailing slash for path matching. Claude Code's
        // requests come in as /v1/messages?beta=true — the query suffix needs
        // to not break dispatch. Likewise OpenAI sometimes hits /v1/chat/completions/.
        const reqPath = (req.url ?? '').split('?')[0]?.replace(/\/$/, '') ?? '';
        const isAnthropicMessages = format === 'anthropic' && reqPath === '/v1/messages';
        const isOpenAIChat = format === 'openai' && reqPath.startsWith('/v1/chat');
        // Gemini paths: /v1beta/models/{model}:generateContent or :streamGenerateContent
        const isGoogleGenerate = format === 'google'
            && (Boolean(req.url?.includes(':generateContent'))
                || Boolean(req.url?.includes(':streamGenerateContent')));
        // Run the anonymized handler whenever the request matches a known API
        // shape, even if source-IP identity didn't resolve. SCI-104's MASQUERADE
        // bug means identity always resolves to null today; gating on identity
        // would force every API request into passthrough, which strands memory
        // and anonymization. A null identity means the handler runs against
        // the default profile (single-tenant Hub mode is the right context for
        // this; multi-tenant deployments should keep this gated, see SCI-104).
        const shouldIntercept = isAnthropicMessages || isOpenAIChat || isGoogleGenerate;
        if (!shouldIntercept) {
            await passthrough(req, hostname, res, identity).catch(() => { });
            return;
        }
        await handleIntercepted(req, hostname, format, identity, adapter, openrouterKey, res);
    });
    // Log every accepted TCP connection — even if TLS handshake fails — so
    // we can see why Claude Desktop / Bun-based / cert-pinning apps fail to
    // complete the handshake. Without this, https.createServer drops failures
    // silently and the dashboard / proxy logs look empty.
    server.on('connection', (sock) => {
        const peer = `${sock.remoteAddress ?? '?'}:${sock.remotePort ?? '?'}`;
        console.log(`[tls-intercept] tcp accept from ${peer}`);
        sock.on('error', (err) => {
            console.log(`[tls-intercept] tcp error from ${peer}: ${err.message}`);
        });
    });
    server.on('tlsClientError', (err, sock) => {
        const peer = sock?.remoteAddress ? `${sock.remoteAddress}:${sock.remotePort}` : '?';
        console.log(`[tls-intercept] handshake failure from ${peer}: ${err.code ?? ''} ${err.message}`);
    });
    server.on('clientError', (err, sock) => {
        const peer = sock?.remoteAddress ? `${sock.remoteAddress}:${sock.remotePort}` : '?';
        console.log(`[tls-intercept] client error from ${peer}: ${err.message}`);
        try {
            sock.destroy();
        }
        catch { /* ignore */ }
    });
    server.listen(TLS_INTERCEPT_PORT, TLS_BIND, () => {
        console.log(`[tls-intercept] listening on ${TLS_BIND}:${TLS_INTERCEPT_PORT} (Phase 9)`);
        console.log(`[tls-intercept] anonymized hosts: ${Object.keys(KNOWN_AI_HOSTS).join(', ')}`);
    });
    return server;
}
//# sourceMappingURL=server-tls.js.map