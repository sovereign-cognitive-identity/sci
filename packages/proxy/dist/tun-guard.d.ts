/**
 * TUN mode safety guard.
 *
 * The TUN mode makes system-level changes: kernel routes, /etc/resolver entries,
 * and a running sing-box process. If the proxy crashes hard (SIGKILL, OOM, power
 * loss), those changes persist — routes point to a dead interface, DNS queries for
 * AI domains fail, network breaks.
 *
 * This module provides a three-layer safety net:
 *
 * Layer 1 — Node.js handlers (handles SIGTERM, SIGINT, normal exit)
 *   Registers process.on('SIGTERM/SIGINT/exit') to run cleanup synchronously.
 *
 * Layer 2 — Recovery script on disk (~/.sci/recover.sh)
 *   Written BEFORE any system changes. Deleted on clean shutdown.
 *   If Node.js crashes without running cleanup, the script survives.
 *   On next proxy startup, the stale script is detected and executed.
 *
 * Layer 3 — Privileged cleanup helper (~/.sci/tun-cleanup.sh, runs via sudo)
 *   A fixed shell script installed into sudoers (NOPASSWD) at vpn install time.
 *   Both the recovery script and the Node.js exit handler call it.
 *   Works even if the Node.js process is completely dead.
 *
 * Manual recovery at any time:
 *   bash ~/.sci/recover.sh
 */
export declare const RECOVER_SCRIPT: string;
export declare const CLEANUP_HELPER: string;
/**
 * Write the privileged cleanup helper. This is the script that actually undoes
 * system changes. It accepts the fake CIDR and resolver domains as arguments so
 * it stays generic across reinstalls.
 *
 * Called during `sci vpn install`. Requires sudo to write to /etc/sudoers.d.
 */
export declare function installCleanupHelper(fakeCIDR: string, resolverDomains: string[]): void;
/**
 * Write recover.sh BEFORE making any system changes.
 * On clean shutdown, this is deleted. If it exists at startup, it's stale — run it.
 */
export declare function writeRecoveryScript(): void;
export declare function deleteRecoveryScript(): void;
/**
 * On startup: if recover.sh exists, we crashed last time.
 * Run cleanup before making any new system changes.
 */
export declare function runRecoveryIfStale(): void;
type AsyncCleanupFn = () => Promise<void>;
export declare function registerTUNCleanup(fn: AsyncCleanupFn): void;
export {};
//# sourceMappingURL=tun-guard.d.ts.map