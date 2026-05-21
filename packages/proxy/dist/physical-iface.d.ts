/**
 * Physical interface detection for TUN-mode loop prevention.
 *
 * In TUN mode, AI endpoint IPs are routed through utun5. The proxy itself
 * needs to make outbound connections to those same IPs WITHOUT going through
 * the TUN (else infinite loop).
 *
 * Solution: bind outbound sockets to the physical interface's IP via
 * `localAddress`. macOS routes the connection out the interface that owns
 * that source IP, bypassing the more-specific TUN route for the destination.
 *
 * This is the userspace equivalent of `IP_BOUND_IF`/`SO_BINDTODEVICE`.
 */
/**
 * Find the IPv4 address of the default-route interface (usually en0).
 * Cached after first call.
 */
export declare function getPhysicalInterfaceIP(): string | null;
//# sourceMappingURL=physical-iface.d.ts.map