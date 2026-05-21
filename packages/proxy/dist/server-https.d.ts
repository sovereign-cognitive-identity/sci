/**
 * HTTPS server for VPN mode.
 *
 * Listens on port 8443. With pf redirect rules, port 443 traffic to
 * 127.0.0.1 gets forwarded here transparently.
 *
 * SNI: when api.anthropic.com connects, we generate a cert for that
 * hostname signed by our local CA (which the OS trusts), complete
 * the TLS handshake, decrypt the traffic, process it, and forward
 * to the real upstream IP (bypassing our /etc/hosts redirect).
 */
import https from 'https';
import type { StorageAdapter } from '@sci/core';
export declare const VPN_PORT: number;
export declare function startHTTPSServer(adapter: StorageAdapter, openrouterKey: string): https.Server;
//# sourceMappingURL=server-https.d.ts.map