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
import { networkInterfaces } from 'os';
import { execSync } from 'child_process';
let _physicalIP = null;
/**
 * Find the IPv4 address of the default-route interface (usually en0).
 * Cached after first call.
 */
export function getPhysicalInterfaceIP() {
    if (_physicalIP !== null)
        return _physicalIP;
    // Step 1: ask the kernel which interface the default route uses
    let defaultIface;
    try {
        const out = execSync('/sbin/route -n get default 2>/dev/null', { encoding: 'utf-8' });
        const m = out.match(/interface:\s+(\S+)/);
        if (!m) {
            process.stderr.write('[iface] could not find default interface\n');
            return null;
        }
        defaultIface = m[1];
    }
    catch (err) {
        process.stderr.write(`[iface] route command failed: ${err}\n`);
        return null;
    }
    // Step 2: get the IPv4 address of that interface
    const ifaces = networkInterfaces();
    const ifData = ifaces[defaultIface];
    if (!ifData) {
        process.stderr.write(`[iface] no interface data for ${defaultIface}\n`);
        return null;
    }
    const ipv4 = ifData.find(addr => addr.family === 'IPv4' && !addr.internal);
    if (!ipv4) {
        process.stderr.write(`[iface] no IPv4 on ${defaultIface}\n`);
        return null;
    }
    _physicalIP = ipv4.address;
    process.stderr.write(`[iface] physical interface: ${defaultIface} (${ipv4.address})\n`);
    return _physicalIP;
}
//# sourceMappingURL=physical-iface.js.map