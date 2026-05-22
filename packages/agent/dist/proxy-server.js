/**
 * HTTPS_PROXY server — handles `CONNECT` from any tool with
 * `HTTPS_PROXY=http://localhost:8080` set.
 *
 * Two paths after CONNECT:
 *
 *   1. AI host (api.anthropic.com / api.openai.com / etc.) — terminate
 *      TLS locally with a Sci-CA-signed leaf cert (via SNI), parse the
 *      decrypted HTTP request, forward to the real upstream, stream the
 *      response back through the same TLS-terminated client socket.
 *
 *      Today (SCI-116) this path is **passthrough-with-MITM**: we
 *      intercept and re-forward verbatim with no anonymization. Wiring
 *      anonymization + memory + provider-specific handling lands in
 *      SCI-117 (handler refactor) + SCI-118 (local SQLite memory).
 *
 *      The MITM mechanic is what unlocks anonymization later. Without
 *      TLS termination at this layer, we'd never see decrypted prompt
 *      content to anonymize.
 *
 *   2. Anything else — pure socket-level tunnel. No TLS interception,
 *      no CA exposure. `socket.pipe()` the bidirectional bytes between
 *      the client and the upstream. Apps that share their HTTPS_PROXY
 *      env var with us don't break for non-AI traffic.
 */
import { createServer as createHttpServer } from 'http';
import { request as httpsRequest } from 'https';
import { getH2Client } from '../../proxy/dist/direct-anthropic.js';
import { connect as netConnect } from 'net';
import { TLSSocket } from 'tls';
import { ensureCA, makeSNICallback } from './cert.js';
import { mkdirSync, existsSync } from 'fs';
import { handleAnthropicMessages, handleOpenAIChat, handleGoogleGemini, makeHandlerContext, pipeResponse, ANONYMOUS_AGENT, } from '@sci/proxy/handlers';
import { SqliteStorageAdapter } from './storage-sqlite.js';
import { loadCredentials, summarizeCredentials, injectCredentialForHost, } from './credentials.js';
import { getAccessTokenSafe, readCache, ANTHROPIC_OAUTH_BETA } from './oauth.js';
// Handler routing: hostname → which provider format. Path-level routing
// happens inside dispatchToHandler so each provider's path quirks (e.g.
// /v1/messages vs /v1/messages?beta=true vs /v1/chat/completions vs
// /v1beta/models/{m}:generateContent) live next to the dispatch decision.
const ANTHROPIC_HOSTS = new Set(['api.anthropic.com']);
const OPENAI_HOSTS = new Set(['api.openai.com', 'openrouter.ai']);
const GOOGLE_HOSTS = new Set(['generativelanguage.googleapis.com']);
// Module-level adapter — connected once in `startProxyServer`, drained in
// `closeAdapter` on shutdown. Local SQLite + hnswlib at `config.memoryDir`.
// The handlers receive this same instance, which means recall + storage are
// backed by real on-device state instead of the previous NoopStorageAdapter.
let adapter = null;
// Credentials are loaded once at startup. The agent process is long-lived;
// re-reading on every request would be cheap but pointless. If the user
// edits ~/.sci/credentials.env they restart the agent — same shape as
// editing /etc/wireguard/wg0.conf and `systemctl restart`.
let credentials = {};
// `OPENROUTER_KEY` is read by the OpenAI/OpenRouter handler when it routes
// through OpenRouter. The agent's normal path is direct-to-provider with
// the user's BYO key, so this is a placeholder that only matters if the
// caller set up OpenRouter routing.
const OPENROUTER_KEY = process.env['SCI_OPENROUTER_KEY'] ?? '';
export async function startProxyServer(config) {
    const ca = ensureCA(config.configDir);
    const sniCallback = makeSNICallback(ca);
    // Stand up the local memory store before serving traffic. CloudAdapter's
    // _initSchema seeds the 'work' + 'personal' profiles via INSERT OR IGNORE,
    // so injectMemoryContext('work') succeeds from the very first request —
    // no separate bootstrap step. First-run side effects (creating the dir,
    // writing sci.db / sci.idx) all happen in connect().
    if (!existsSync(config.memoryDir)) {
        mkdirSync(config.memoryDir, { recursive: true, mode: 0o700 });
    }
    const sqliteAdapter = new SqliteStorageAdapter(config.memoryDir, {
        configDir: config.configDir,
        controlPlaneUrl: config.controlPlaneUrl,
    });
    await sqliteAdapter.connect();
    adapter = sqliteAdapter;
    process.stderr.write(`[sci-agent] memory store ready: ${config.memoryDir}\n`);
    // Warm up the fastembed ONNX model in the background so the first request
    // doesn't block the event loop loading the model mid-stream.
    import('@sci/core').then(({ embed }) => embed('warmup').catch(() => {})).catch(() => {});
    process.stderr.write(`[sci-agent] warming up embed model...\n`);
    // Resolve BYO credentials once. Logged as a count + provider list (never
    // bytes). If empty, the agent still runs — handlers fall back to whatever
    // header the client tool sent, so a tool that brings its own key still
    // works without Sci config. The "set up Sci once, every tool just works"
    // story requires this to be populated though.
    credentials = loadCredentials(config.configDir);
    process.stderr.write(`[sci-agent] ${summarizeCredentials(credentials)}\n`);
    // Internal HTTP server — never .listen()s. We feed it TLS-decrypted
    // sockets via .emit('connection', tlsSocket). It parses the HTTP request
    // off each socket and dispatches to our request handler.
    const internalHttpServer = createHttpServer((req, res) => {
        handleAIRequest(req, res).catch((err) => {
            process.stderr.write(`[sci-agent] handler error: ${err}\n`);
            if (!res.headersSent)
                res.writeHead(502, { 'content-type': 'text/plain' });
            res.end();
        });
    });
    const server = createHttpServer();
    server.on('request', (req, res) => {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('sci agent: this is an HTTPS_PROXY for AI hosts. ' +
            'Use HTTPS_PROXY=http://localhost:' + config.proxyPort + ' on a tool that ' +
            'respects it (claude, curl, openai-python, etc.).\n');
    });
    server.on('connect', (req, clientSocket, head) => {
        const target = req.url ?? '';
        const [hostname, portStr] = target.split(':');
        const port = parseInt(portStr ?? '443');
        if (!hostname) {
            clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            clientSocket.destroy();
            return;
        }
        if (config.aiHosts.has(hostname.toLowerCase())) {
            interceptAIHost(hostname, clientSocket, head, ca, sniCallback, internalHttpServer);
            return;
        }
        tunnel(hostname, port, clientSocket, head);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.proxyPort, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    return server;
}
/**
 * Drain the local memory adapter cleanly. Called from the agent's SIGINT
 * shutdown path so the SQLite WAL flushes and the hnswlib index is written
 * out to disk before the process exits — otherwise the most recent embeddings
 * from the in-memory index don't make it into `sci.idx`.
 */
export async function closeAdapter() {
    if (!adapter)
        return;
    try {
        await adapter.disconnect();
    }
    catch (err) {
        process.stderr.write(`[sci-agent] memory shutdown warning: ${err}\n`);
    }
    adapter = null;
}
/**
 * AI-host CONNECT path: terminate TLS with a Sci-CA leaf cert for the
 * requested hostname, then feed the decrypted stream to our internal
 * HTTP server so a request handler can run.
 */
function interceptAIHost(hostname, clientSocket, _head, _ca, sniCallback, internalHttpServer) {
    process.stderr.write(`[sci-agent] AI-host CONNECT (intercept): ${hostname}\n`);
    // Tell the client the tunnel is open so it sends ClientHello.
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const tlsSocket = new TLSSocket(clientSocket, {
        isServer: true,
        SNICallback: sniCallback,
        // ALPN: claim http/1.1 only. HTTP/2 over MITM is doable but more
        // complex (header tables, frame parsing). v0.5 sticks to HTTP/1.1
        // which is what every Anthropic/OpenAI/Google REST SDK uses anyway.
        ALPNProtocols: ['http/1.1'],
    });
    tlsSocket.once('error', (err) => {
        process.stderr.write(`[sci-agent] tls handshake error from ${hostname}: ${err.message}\n`);
        if (!tlsSocket.destroyed)
            tlsSocket.destroy();
    });
    tlsSocket._sciHostname = hostname;
    // Feed this decrypted stream to the internal HTTP server.
    internalHttpServer.emit('connection', tlsSocket);
}
/**
 * Internal HTTP server's request handler. The decrypted stream is parsed
 * by Node's HTTP parser into an IncomingMessage; we either:
 *
 *   - Dispatch to the matching provider-aware handler from
 *     `@sci/proxy/handlers` (anonymizes, applies memory if available,
 *     forwards upstream, deanonymizes the response stream)
 *
 *   - Or, when no handler matches the path (e.g. a request to an
 *     auxiliary endpoint we don't anonymize), fall back to passthrough
 *     forwarding so the tool sees its expected response shape.
 */
async function handleAIRequest(req, res) {
    const sock = req.socket;
    const hostname = (sock._sciHostname ?? req.headers.host ?? '').toLowerCase();
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    process.stderr.write(`[sci-agent] ${req.method} https://${hostname}${url}\n`);
    // Buffer the request body. AI request bodies are JSON and small.
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    const body = Buffer.concat(chunks);
    // Replace whatever auth header the client tool sent with the user's Sci-
    // configured credential for this hostname. The handlers in
    // `@sci/proxy/handlers` were originally written for the proxy-server's
    // OAuth-swap model; in the agent's BYO-key world we always want the
    // user's real provider key reaching upstream. Injecting here means any
    // tool — `claude`, raw curl, an SDK with stale creds — works as long as
    // Sci itself has the right key.
    injectCredentialForHost(hostname, req.headers, credentials);
    // Pass through client's own token for all requests.
    // The proxy now uses HTTP/2 upstream which doesn't rate-limit CC native tokens.
    if (ANTHROPIC_HOSTS.has(hostname) && !credentials.anthropic &&
        !req.headers['authorization'] && !req.headers['x-api-key'] && readCache()) {
        try {
            const token = await getAccessTokenSafe();
            req.headers['authorization'] = `Bearer ${token}`;
            const existing = req.headers['anthropic-beta'];
            req.headers['anthropic-beta'] = existing
                ? `${existing},${ANTHROPIC_OAUTH_BETA}`
                : ANTHROPIC_OAUTH_BETA;
        } catch (err) {
            process.stderr.write(`[sci-agent] OAuth token refresh failed: ${err.message}\n`);
        }
    }
    // Decide whether this hostname+path is one we know how to anonymize.
    const handler = pickHandler(hostname, path, req.method ?? 'POST');
    if (handler) {
        try {
            const ctx = makeHandlerContext(req, body, ANONYMOUS_AGENT);
            const result = await handler(ctx);
            await pipeResponse(result, res);
        }
        catch (err) {
            process.stderr.write(`[sci-agent] handler error for ${hostname}${path}: ${err}\n`);
            if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    error: { type: 'sci_agent_error', message: String(err) },
                }));
            }
        }
        return;
    }
    // No matching handler — passthrough forward. The tool gets its expected
    // response shape; Sci is just on the wire path without modifying content.
    await passthroughForward(req, body, hostname, res);
}
function pickHandler(hostname, path, method) {
    if (method !== 'POST')
        return null;
    // adapter is set by startProxyServer before the listener accepts a single
    // request, so it's non-null by the time any handler dispatches. Capture
    // it in a local so each closure pins the live adapter without re-reading
    // the module-level let on every invocation.
    const a = adapter;
    if (!a)
        return null;
    if (ANTHROPIC_HOSTS.has(hostname) && path === '/v1/messages') {
        return (ctx) => handleAnthropicMessages(ctx, a, OPENROUTER_KEY);
    }
    if (OPENAI_HOSTS.has(hostname) && path.startsWith('/v1/chat')) {
        return (ctx) => handleOpenAIChat(ctx, a, OPENROUTER_KEY);
    }
    if (GOOGLE_HOSTS.has(hostname) &&
        (path.includes(':generateContent') || path.includes(':streamGenerateContent'))) {
        return (ctx) => handleGoogleGemini(ctx, a);
    }
    return null;
}
/**
 * Plain passthrough — used when no handler matched and for non-AI paths
 * within an AI host. Forwards verbatim to the real upstream.
 */
async function passthroughForward(req, body, hostname, res) {
    // Use HTTP/2 for Anthropic hosts — all requests share one connection,
    // matching the rate-limit profile of a direct Claude Code session.
    if (ANTHROPIC_HOSTS.has(hostname)) {
        try {
            const h2 = getH2Client();
            const h2Headers = { ':method': req.method ?? 'GET', ':path': req.url ?? '/', ':scheme': 'https', ':authority': hostname, 'accept-encoding': 'identity' };
            const skip = new Set([':method',':path',':scheme',':authority','host','connection','transfer-encoding','content-length']);
            for (const [k, v] of Object.entries(req.headers)) {
                if (!skip.has(k.toLowerCase())) h2Headers[k.toLowerCase()] = String(v);
            }
            if (body.length > 0) h2Headers['content-length'] = String(body.length);
            const h2req = h2.request(h2Headers, { endStream: body.length === 0 });
            h2req.on('error', (err) => {
                process.stderr.write(`[sci-agent] h2 passthrough error: ${err.message}\n`);
                if (!res.headersSent) { res.writeHead(502); res.end(); }
            });
            let statusSent = false;
            h2req.on('response', (headers) => {
                const status = Number(headers[':status'] ?? 200);
                const resHeaders = {};
                for (const [k, v] of Object.entries(headers)) {
                    if (!k.startsWith(':')) resHeaders[k] = String(v);
                }
                res.writeHead(status, resHeaders);
                statusSent = true;
            });
            h2req.on('data', chunk => res.write(chunk));
            h2req.on('end', () => res.end());
            if (body.length > 0) { h2req.write(body); h2req.end(); }
            return;
        } catch (err) {
            process.stderr.write(`[sci-agent] h2 passthrough setup error: ${err.message} — falling back to HTTP/1.1\n`);
        }
    }
    const upstreamHeaders = sanitizeHeaders(req.headers, hostname);
    const upstream = httpsRequest({
        host: hostname,
        port: 443,
        path: req.url,
        method: req.method,
        headers: upstreamHeaders,
    }, (upstreamRes) => {
        const responseHeaders = sanitizeHeaders(upstreamRes.headers, hostname);
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.on('error', err => {
            process.stderr.write(`[sci-agent] passthrough ${req.method} ${req.url} error: ${err.message}\n`);
        });
        upstreamRes.pipe(res);
    });
    upstream.on('error', (err) => {
        process.stderr.write(`[sci-agent] upstream ${hostname} error: ${err.message}\n`);
        if (!res.headersSent)
            res.writeHead(502, { 'content-type': 'text/plain' });
        res.end();
    });
    if (body.length > 0)
        upstream.write(body);
    upstream.end();
}
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
function sanitizeHeaders(headers, hostname) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (HOP_BY_HOP.has(k.toLowerCase()))
            continue;
        if (v === undefined)
            continue;
        out[k] = v;
    }
    out['host'] = hostname;
    return out;
}
/**
 * Open a TCP connection to the upstream host:port and pipe bytes
 * bidirectionally with the client. Used for non-AI hosts — the agent
 * is not a general HTTPS proxy, just a transparent tunnel for everything
 * outside its AI-host whitelist.
 */
function tunnel(hostname, port, clientSocket, head) {
    const upstream = netConnect(port, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0)
            upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
    });
    upstream.on('error', (err) => {
        process.stderr.write(`[sci-agent] upstream ${hostname}:${port} error: ${err.message}\n`);
        if (!clientSocket.destroyed) {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            clientSocket.destroy();
        }
    });
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
}
//# sourceMappingURL=proxy-server.js.map