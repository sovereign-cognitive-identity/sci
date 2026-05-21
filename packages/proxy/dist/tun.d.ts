/**
 * sing-box TUN manager.
 *
 * sing-box creates a utun virtual NIC (utun9). Traffic routed to the fake IP
 * range (198.18.0.0/15) arrives at utun9. sing-box reads TLS ClientHello SNI
 * to extract the real hostname, then forwards as a SOCKS5 CONNECT request to
 * our SOCKS5 server on port 1080.
 *
 * Install: brew install sing-box
 *
 * Key config choices:
 *   auto_route: false    — we manage routes explicitly (avoids touching default gateway)
 *   sniff: true          — extract hostname from TLS SNI
 *   sniff_override_destination: true  — send domain name in SOCKS5, not fake IP
 *   stack: "mixed"       — gVisor for TCP, system for UDP
 */
import { type ChildProcess } from 'child_process';
export declare const TUN_ADDR = "172.19.0.1";
export declare const TUN_CIDR = "172.19.0.1/30";
export declare const TUN_INTERFACE: string;
export declare function startSingBox(): ChildProcess;
export declare function stopSingBox(): void;
/**
 * Add a route for the fake IP range through utun9.
 * Must be called after sing-box has started and created the interface.
 * Requires sudo.
 */
export declare function addFakeIPRoute(): void;
export declare function removeFakeIPRoute(): void;
/**
 * Add a /16 route for a real AI endpoint IP through the TUN.
 *
 * /16 (not /32) is required because macOS routes /32 host routes through
 * the gateway's interface (en0) instead of utun5 — there's a quirk where
 * larger network routes resolve their gateway via the TUN but smaller ones
 * resolve via the default route. /16 is the smallest mask that works.
 *
 * The /16 catches more than just the AI endpoint, but that's fine — sing-box
 * routes everything from the TUN to our SOCKS5, and our SOCKS5 only intercepts
 * known AI hostnames (others go through directTunnel passthrough).
 */
export declare function addRealIPRoute(realIP: string): void;
export declare function removeRealIPRoute(realIP: string): void;
export declare function trackRealIPRoute(realIP: string): void;
export declare function listRealIPRoutes(): string[];
/** Wait for utun9 to appear (sing-box creates it asynchronously). */
export declare function waitForInterface(timeoutMs?: number): Promise<void>;
export declare function writeHostsEntries(): void;
export declare function removeHostsEntries(): void;
declare const RESOLVER_DOMAINS: string[];
export declare function writeResolverEntries(): void;
export declare function removeResolverEntries(): void;
export { RESOLVER_DOMAINS };
/**
 * Full TUN startup sequence with safety guard wired in.
 *
 * Order matters:
 *   1. Run recovery if stale (cleans up previous crash)
 *   2. Write recovery script (before ANY system changes)
 *   3. Register cleanup handlers (SIGTERM/SIGINT/exit)
 *   4. Start sing-box
 *   5. Wait for interface
 *   6. Add route
 *   7. Flush DNS
 */
export declare function startTUNWithGuard(adapter: unknown): Promise<void>;
//# sourceMappingURL=tun.d.ts.map