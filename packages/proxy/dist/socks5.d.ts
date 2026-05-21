/**
 * SOCKS5 server for TUN-mode interception.
 *
 * sing-box intercepts traffic from the fake IP range (198.18.0.0/15) via
 * the utun device. With TLS sniffing enabled, sing-box extracts the domain
 * name from the TLS ClientHello SNI and sends it here as a SOCKS5 CONNECT
 * request with ATYP=0x03 (domain name).
 *
 * For AI hostnames: TLS intercept → anonymize → memory inject → forward.
 * For everything else: direct TCP passthrough.
 *
 * Loop prevention: outbound connections from THIS server use the real
 * hostname (resolved via real DNS), which returns the REAL IP. The real
 * IP is NOT in 198.18.0.0/15, so it is NOT routed through the TUN.
 */
import net from 'net';
import type { StorageAdapter } from '@sci/core';
export declare const SOCKS5_PORT: number;
export declare function startSOCKS5Server(adapter: StorageAdapter, openrouterKey: string): net.Server;
//# sourceMappingURL=socks5.d.ts.map