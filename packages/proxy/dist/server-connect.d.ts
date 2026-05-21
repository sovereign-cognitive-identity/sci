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
import type { Server as HttpServer } from 'http';
import type { StorageAdapter } from '@sci/core';
/**
 * Attach HTTP CONNECT handler to the given Node.js http.Server.
 * Call this after serve() returns the server instance.
 */
export declare function attachConnectHandler(server: HttpServer, adapter: StorageAdapter, openrouterKey: string): void;
//# sourceMappingURL=server-connect.d.ts.map