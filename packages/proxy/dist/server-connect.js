/**
 * HTTP CONNECT proxy support for the Sci proxy.
 *
 * When HTTPS_PROXY=http://localhost:3001 is set, HTTPS clients send:
 *   CONNECT api.anthropic.com:443 HTTP/1.1
 *
 * This module attaches to the raw Node.js http.Server and handles CONNECT
 * tunnels by performing TLS interception using our local CA cert.
 *
 * Flow:
 *   1. Client sends CONNECT api.anthropic.com:443
 *   2. We respond "200 Connection established"
 *   3. Client does TLS handshake with us (we present a cert for api.anthropic.com)
 *   4. We decrypt the plaintext HTTP request
 *   5. Route through existing Anthropic/OpenAI handlers (anonymize, inject memory, etc.)
 *   6. Forward to real upstream, stream response back
 *
 * This is the "system HTTPS proxy" approach — reversible in one command:
 *   networksetup -setsecurewebproxystate Wi-Fi off
 */
import tls from 'tls';
import net from 'net';
import { ensureCACert, makeSNICallback } from './tls.js';
import { handleAnthropicMessages } from './handlers/anthropic.js';
import { handleOpenAIChat } from './handlers/openai.js';
import { makeHonoContext } from './connect-context.js';
// Hosts we intercept vs pass through as a raw tunnel
const INTERCEPT_HOSTS = new Set([
    'api.anthropic.com',
    'api.openai.com',
    'openrouter.ai',
    'generativelanguage.googleapis.com',
]);
const ENDPOINT_FORMAT = {
    'api.anthropic.com': 'anthropic',
    'api.openai.com': 'openai',
    'openrouter.ai': 'openai',
    'generativelanguage.googleapis.com': 'openai',
};
/**
 * Attach HTTP CONNECT handler to the given Node.js http.Server.
 * Call this after serve() returns the server instance.
 */
export function attachConnectHandler(server, adapter, openrouterKey) {
    const ca = ensureCACert();
    server.on('connect', (req, clientSocket, head) => {
        const target = req.url ?? '';
        const [hostname, portStr] = target.split(':');
        const port = parseInt(portStr ?? '443', 10);
        if (!hostname) {
            clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            clientSocket.destroy();
            return;
        }
        const shouldIntercept = INTERCEPT_HOSTS.has(hostname);
        if (shouldIntercept) {
            handleInterceptedConnect(hostname, port, clientSocket, head, ca, adapter, openrouterKey);
        }
        else {
            handlePassthroughConnect(hostname, port, clientSocket, head);
        }
    });
    process.stderr.write('[connect] HTTP CONNECT handler attached\n');
}
/**
 * Handle a CONNECT tunnel for a host we intercept.
 * We present a TLS cert for the hostname, decrypt the request, process it.
 */
function handleInterceptedConnect(hostname, _port, clientSocket, head, ca, adapter, openrouterKey) {
    // Tell the client the tunnel is established
    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    // Upgrade the socket to TLS, presenting a cert for the target hostname
    const sniCallback = makeSNICallback(ca);
    const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        SNICallback: sniCallback,
    });
    // Buffer to accumulate HTTP request data
    let buf = head.length > 0 ? head : Buffer.alloc(0);
    let headersParsed = false;
    tlsSocket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!headersParsed) {
            // Check if we have the full HTTP headers
            const headerEnd = buf.indexOf('\r\n\r\n');
            if (headerEnd === -1)
                return; // need more data
            headersParsed = true;
            const headerStr = buf.slice(0, headerEnd).toString('utf-8');
            const body = buf.slice(headerEnd + 4);
            handleDecryptedRequest(hostname, headerStr, body, tlsSocket, adapter, openrouterKey);
        }
    });
    tlsSocket.on('error', (err) => {
        process.stderr.write(`[connect] TLS error for ${hostname}: ${err.message}\n`);
    });
}
/**
 * Parse the decrypted HTTP request and route it through our handlers.
 */
async function handleDecryptedRequest(hostname, headerStr, initialBody, tlsSocket, adapter, openrouterKey) {
    const lines = headerStr.split('\r\n');
    const requestLine = lines[0] ?? '';
    const [method, path] = requestLine.split(' ');
    const headers = {};
    for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon === -1)
            continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers[name] = value;
    }
    const format = ENDPOINT_FORMAT[hostname] ?? 'openai';
    const contentLength = parseInt(headers['content-length'] ?? '0', 10);
    // Collect the full request body
    let bodyBuf = initialBody;
    if (bodyBuf.length < contentLength) {
        // Need to wait for more data — attach a one-time listener
        await new Promise((resolve) => {
            tlsSocket.on('data', (chunk) => {
                bodyBuf = Buffer.concat([bodyBuf, chunk]);
                if (bodyBuf.length >= contentLength)
                    resolve();
            });
        });
    }
    const bodyStr = bodyBuf.toString('utf-8');
    try {
        let bodyJson;
        try {
            bodyJson = JSON.parse(bodyStr);
        }
        catch {
            bodyJson = {};
        }
        // Build a minimal Hono-compatible context
        const ctx = makeHonoContext(method ?? 'POST', path ?? '/', headers, bodyJson);
        let response;
        if (format === 'anthropic' && path === '/v1/messages') {
            response = await handleAnthropicMessages(ctx, adapter, openrouterKey);
        }
        else if (format === 'openai' && (path?.startsWith('/v1/chat') ?? false)) {
            response = await handleOpenAIChat(ctx, adapter, openrouterKey);
        }
        else {
            // Pass through to real upstream
            response = await forwardToUpstream(method ?? 'GET', hostname, path ?? '/', headers, bodyBuf);
        }
        // Write response back to the TLS socket
        await writeResponseToSocket(response, tlsSocket);
    }
    catch (err) {
        const errBody = JSON.stringify({ error: String(err) });
        tlsSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: ${errBody.length}\r\n\r\n${errBody}`);
        tlsSocket.destroy();
    }
}
/**
 * Forward a request to the real upstream.
 * Uses the hostname directly (not IP) since in HTTP CONNECT mode we are NOT
 * redirecting via /etc/hosts, so the standard TLS cert chain works normally.
 *
 * Note: resolveReal() is only needed in VPN mode where /etc/hosts redirects
 * api.anthropic.com → 127.0.0.1. In CONNECT mode we have no such redirect.
 */
async function forwardToUpstream(method, hostname, path, headers, body) {
    const url = `https://${hostname}${path}`;
    return fetch(url, {
        method,
        headers: { ...headers, host: hostname },
        body: body.length > 0 ? body : undefined,
        signal: AbortSignal.timeout(30_000),
    });
}
/**
 * Write a standard Response object back to a socket as HTTP/1.1.
 */
async function writeResponseToSocket(response, socket) {
    const statusLine = `HTTP/1.1 ${response.status} ${response.statusText || 'OK'}`;
    const headerLines = [statusLine];
    response.headers.forEach((value, name) => {
        headerLines.push(`${name}: ${value}`);
    });
    headerLines.push(''); // blank line
    headerLines.push(''); // end of headers
    socket.write(headerLines.join('\r\n'));
    if (response.body) {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            socket.write(value);
        }
    }
    socket.end();
}
/**
 * Handle a CONNECT tunnel for a host we do NOT intercept.
 * Just create a raw TCP tunnel to the real server.
 */
function handlePassthroughConnect(hostname, port, clientSocket, head) {
    const upstreamSocket = net.connect(port, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (head.length > 0)
            upstreamSocket.write(head);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
    });
    upstreamSocket.on('error', (err) => {
        process.stderr.write(`[connect] Passthrough error ${hostname}:${port}: ${err.message}\n`);
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
    });
    clientSocket.on('error', () => upstreamSocket.destroy());
    clientSocket.on('close', () => upstreamSocket.destroy());
}
//# sourceMappingURL=server-connect.js.map