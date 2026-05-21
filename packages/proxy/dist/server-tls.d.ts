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
import type { StorageAdapter } from '@sci/core';
export declare const TLS_INTERCEPT_PORT: number;
export declare function startTLSInterceptServer(adapter: StorageAdapter, openrouterKey: string): https.Server;
//# sourceMappingURL=server-tls.d.ts.map