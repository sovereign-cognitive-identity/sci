/**
 * Minimal UDP DNS server for fake IP assignment.
 *
 * Listens on 127.0.0.1:5353 (no root needed).
 * - AI domains  → fake IPs in 198.18.0.0/15 (from fake-ip.ts)
 * - Everything  → forwarded to 8.8.8.8 (real DNS)
 *
 * Configured via /etc/resolver/<domain> for per-domain resolution on macOS.
 * Only DNS queries for AI-owned domains ever reach this server.
 *
 * DNS packet format is minimal: we only handle A record queries.
 */
import dgram from 'dgram';
export declare const DNS_PORT: number;
export declare function startDNSServer(): dgram.Socket;
//# sourceMappingURL=dns-server.d.ts.map