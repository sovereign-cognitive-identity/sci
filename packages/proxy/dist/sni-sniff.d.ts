/**
 * TLS ClientHello SNI sniffer.
 *
 * Peeks the first bytes of a TCP stream, parses the TLS ClientHello, and
 * extracts the Server Name Indication extension. Used by the SOCKS5 server
 * to decide whether to intercept (TLS terminate) or pass through (raw tunnel)
 * a given connection.
 *
 * Necessary because all Anthropic hostnames (api.anthropic.com, claude.ai,
 * assets-proxy.anthropic.com, etc.) resolve to the same IP, and Chromium
 * has cached real IPs that bypass /etc/hosts. The IP alone tells us nothing
 * about which service the client is actually trying to reach — only the SNI
 * does.
 */
import type net from 'net';
/**
 * Parse SNI from a TLS ClientHello buffer.
 * Returns the server name (e.g. "api.anthropic.com") or null if not found.
 *
 * TLS ClientHello layout:
 *   Record header     (5 bytes): type(1) version(2) length(2)
 *   Handshake header  (4 bytes): type(1) length(3)
 *   Client version    (2)
 *   Random            (32)
 *   Session ID        (variable: 1 byte length + body)
 *   Cipher suites     (variable: 2 byte length + body)
 *   Compression       (variable: 1 byte length + body)
 *   Extensions        (variable: 2 byte length + body)
 *
 * SNI extension (type 0x0000):
 *   Server name list length (2)
 *   Name type (1) — 0x00 for host_name
 *   Host name length (2)
 *   Host name (variable)
 */
export declare function parseSNI(buf: Buffer): string | null;
/**
 * Read enough bytes from `socket` to parse the TLS ClientHello.
 * Returns the buffered bytes (so the caller can unshift them back) and the
 * extracted SNI (or null if no SNI / not TLS).
 *
 * Times out and returns whatever was read if no full ClientHello arrives.
 */
export declare function peekClientHello(socket: net.Socket, timeoutMs?: number): Promise<{
    buffer: Buffer;
    sni: string | null;
}>;
//# sourceMappingURL=sni-sniff.d.ts.map