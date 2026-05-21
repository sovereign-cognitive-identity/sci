/**
 * Watchdog for system proxy safety.
 *
 * If the proxy process dies while the system HTTPS proxy is set to
 * localhost:PORT, all HTTPS traffic will fail. This watchdog:
 *
 * 1. Detects if a system proxy is active pointing to us
 * 2. If the proxy stops responding, auto-reverts the system proxy setting
 * 3. Logs all events to ~/Vault/sci/proxy.log
 *
 * The watchdog runs as a setInterval inside the same process.
 * A companion LaunchAgent (sci-watchdog) is registered separately to handle
 * the case where the whole process dies unexpectedly.
 */
export declare function saveProxyState(port: number): void;
export declare function startWatchdog(port: number): void;
//# sourceMappingURL=watchdog.d.ts.map