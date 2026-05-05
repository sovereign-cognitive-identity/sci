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

import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { execSync, execFileSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'

const SCI_DIR = join(homedir(), '.sci')
export const RECOVER_SCRIPT   = join(SCI_DIR, 'recover.sh')
export const CLEANUP_HELPER   = join(SCI_DIR, 'tun-cleanup.sh')
const SUDOERS_FILE            = '/etc/sudoers.d/sci-tun'

// ── Cleanup helper script (runs as root via sudoers) ─────────────────────────

/**
 * Write the privileged cleanup helper. This is the script that actually undoes
 * system changes. It accepts the fake CIDR and resolver domains as arguments so
 * it stays generic across reinstalls.
 *
 * Called during `sci vpn install`. Requires sudo to write to /etc/sudoers.d.
 */
export function installCleanupHelper(
  fakeCIDR: string,
  resolverDomains: string[]
): void {
  mkdirSync(SCI_DIR, { recursive: true })

  const helper = `#!/bin/bash
# Sci TUN cleanup helper — runs as root (via sudoers NOPASSWD)
# Removes all TUN-mode system changes. Safe to run multiple times.

FAKE_CIDR="${fakeCIDR}"
RESOLVER_DOMAINS="${resolverDomains.join(' ')}"

# 1. Stop sing-box
killall sing-box 2>/dev/null && echo "[cleanup] sing-box stopped" || true

# 2. Remove fake IP route
route delete -net "$FAKE_CIDR" 2>/dev/null && echo "[cleanup] Route removed" || true

# 3. Remove /etc/resolver entries
for domain in $RESOLVER_DOMAINS; do
  rm -f "/etc/resolver/$domain" && echo "[cleanup] /etc/resolver/$domain removed" || true
done

# 4. Flush DNS cache
dscacheutil -flushcache 2>/dev/null || true
killall -HUP mDNSResponder 2>/dev/null || true
echo "[cleanup] DNS cache flushed"
`

  writeFileSync(CLEANUP_HELPER, helper, { mode: 0o755 })
  process.stderr.write(`[guard] Cleanup helper written: ${CLEANUP_HELPER}\n`)

  // Add NOPASSWD sudoers rule for this specific helper script
  try {
    const username = process.env['USER'] ?? process.env['LOGNAME'] ?? 'root'
    const rule = `${username} ALL=(root) NOPASSWD: ${CLEANUP_HELPER}\n`
    execSync(`echo '${rule}' | sudo tee ${SUDOERS_FILE} > /dev/null`)
    // Validate sudoers syntax
    execSync(`sudo visudo -cf ${SUDOERS_FILE}`)
    process.stderr.write(`[guard] Sudoers rule installed: ${SUDOERS_FILE}\n`)
  } catch (err) {
    process.stderr.write(`[guard] Could not install sudoers rule: ${err}\n`)
    process.stderr.write(`[guard] Add manually: ${process.env['USER']} ALL=(root) NOPASSWD: ${CLEANUP_HELPER}\n`)
  }
}

// ── Recovery script (survives hard crashes) ───────────────────────────────────

/**
 * Write recover.sh BEFORE making any system changes.
 * On clean shutdown, this is deleted. If it exists at startup, it's stale — run it.
 */
export function writeRecoveryScript(): void {
  mkdirSync(SCI_DIR, { recursive: true })

  const script = `#!/bin/bash
# Sci TUN recovery — auto-generated ${new Date().toISOString()}
# Run this to restore network to normal if the proxy crashed.
echo "[recover] Running TUN cleanup..."
sudo ${CLEANUP_HELPER}
rm -f "$0"
echo "[recover] Done. Network restored."
`
  writeFileSync(RECOVER_SCRIPT, script, { mode: 0o755 })
  process.stderr.write(`[guard] Recovery script ready: ${RECOVER_SCRIPT}\n`)
  process.stderr.write(`[guard] To recover manually at any time: bash ${RECOVER_SCRIPT}\n`)
}

export function deleteRecoveryScript(): void {
  try {
    if (existsSync(RECOVER_SCRIPT)) {
      unlinkSync(RECOVER_SCRIPT)
      process.stderr.write('[guard] Recovery script removed (clean shutdown ✓)\n')
    }
  } catch { /* ignore */ }
}

/**
 * On startup: if recover.sh exists, we crashed last time.
 * Run cleanup before making any new system changes.
 */
export function runRecoveryIfStale(): void {
  if (!existsSync(RECOVER_SCRIPT)) return

  process.stderr.write(`\n[guard] ⚠️  Stale recovery script found — previous session crashed.\n`)
  process.stderr.write(`[guard] Running cleanup before starting...\n`)

  try {
    execFileSync('bash', [RECOVER_SCRIPT], { stdio: 'inherit', timeout: 10_000 })
    process.stderr.write('[guard] Stale cleanup complete.\n\n')
  } catch (err) {
    process.stderr.write(`[guard] Recovery script error: ${err}\n`)
    process.stderr.write(`[guard] Continuing anyway — you may need to run manually:\n`)
    process.stderr.write(`[guard]   sudo ${CLEANUP_HELPER}\n\n`)
    // Delete the stale script even if it failed — don't loop forever
    deleteRecoveryScript()
  }
}

// ── Node.js signal handlers ───────────────────────────────────────────────────

type AsyncCleanupFn = () => Promise<void>

let _cleanupFn: AsyncCleanupFn | null = null
let _cleanupRan = false

export function registerTUNCleanup(fn: AsyncCleanupFn): void {
  _cleanupFn = fn

  const runCleanup = async (signal: string) => {
    if (_cleanupRan) return
    _cleanupRan = true
    process.stderr.write(`\n[guard] Signal: ${signal} — running TUN cleanup\n`)
    try {
      await fn()
    } catch (err) {
      process.stderr.write(`[guard] Cleanup error: ${err}\n`)
    }
    // Run the privileged helper too (belt and suspenders)
    try {
      execSync(`sudo ${CLEANUP_HELPER}`, { timeout: 8_000, stdio: 'pipe' })
    } catch { /* already logged above */ }
    deleteRecoveryScript()
  }

  // Graceful signals
  process.on('SIGTERM', () => void runCleanup('SIGTERM').then(() => process.exit(0)))
  process.on('SIGINT',  () => void runCleanup('SIGINT').then(() => process.exit(0)))

  // Synchronous fallback on exit (e.g. uncaught exception after try/catch)
  process.on('exit', () => {
    if (_cleanupRan) return
    // Best-effort: execSync in 'exit' handler, no async
    try {
      execSync(`sudo ${CLEANUP_HELPER}`, { timeout: 5_000, stdio: 'pipe' })
    } catch { /* ignore — we tried */ }
    try { deleteRecoveryScript() } catch { /* ignore */ }
  })

  process.on('uncaughtException', (err) => {
    process.stderr.write(`[guard] Uncaught exception: ${err}\n`)
    void runCleanup('uncaughtException').then(() => process.exit(1))
  })

  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[guard] Unhandled rejection: ${reason}\n`)
    // Don't exit — log and continue. TUN cleanup only on actual process death.
  })
}
