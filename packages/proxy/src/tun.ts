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

import { spawn, type ChildProcess } from 'child_process'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { SOCKS5_PORT } from './socks5.js'
import { FAKE_IP_CIDR } from './fake-ip.js'
import {
  runRecoveryIfStale,
  writeRecoveryScript,
  registerTUNCleanup,
  installCleanupHelper,
} from './tun-guard.js'

export const TUN_ADDR = '172.19.0.1'
export const TUN_CIDR = '172.19.0.1/30'

/** Find the first utun interface name not currently in use (utun5–utun15). */
function findAvailableUtun(): string {
  for (let i = 5; i <= 15; i++) {
    try {
      execSync(`/sbin/ifconfig utun${i}`, { stdio: 'pipe' })
      // Interface exists — try next
    } catch {
      // Interface doesn't exist — available
      return `utun${i}`
    }
  }
  return 'utun15'  // fallback
}

export const TUN_INTERFACE = findAvailableUtun()

const CONFIG_DIR = join(homedir(), '.sci')
const CONFIG_PATH = join(CONFIG_DIR, 'singbox.json')

// ── Config generation ─────────────────────────────────────────────────────────

function buildSingBoxConfig(): object {
  // Minimal config: TUN device → SOCKS5 forwarding only.
  // DNS is handled externally by our dns-server.ts via /etc/resolver/ entries.
  // No sing-box DNS config needed — avoids the deprecated format in v1.12+.
  return {
    log: {
      level: 'warn',
    },

    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        interface_name: TUN_INTERFACE,
        // sing-box 1.12+: use 'address' array
        address: [TUN_CIDR],
        // auto_route: false — we manage the 198.18.0.0/15 route explicitly
        auto_route: false,
        // mixed: gVisor TCP stack + system UDP
        stack: 'mixed',
        // No sniff fields here — moved to route rule actions in sing-box 1.11+
        // Our SOCKS5 server handles fake IP → hostname reverse lookup directly
      },
    ],

    outbounds: [
      {
        type: 'socks',
        tag: 'sci-socks',
        server: '127.0.0.1',
        server_port: SOCKS5_PORT,
        version: '5',
      },
      {
        type: 'direct',
        tag: 'direct',
      },
    ],

    route: {
      rules: [
        {
          // All TUN traffic → our SOCKS5 server
          // (only 198.18.0.0/15 fake IPs reach this TUN via the route we add)
          inbound: 'tun-in',
          outbound: 'sci-socks',
        },
      ],
      final: 'direct',
      auto_detect_interface: true,
    },
  }
}

// ── Process management ────────────────────────────────────────────────────────

let _proc: ChildProcess | null = null

export function startSingBox(): ChildProcess {
  const singboxBin = findSingBox()
  if (!singboxBin) {
    throw new Error(
      'sing-box not found. Install it: brew install sing-box'
    )
  }

  // Write config
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(buildSingBoxConfig(), null, 2))
  process.stderr.write(`[tun] Config written to ${CONFIG_PATH}\n`)

  const logPath = join(homedir(), 'Vault', 'sci', 'singbox.log')

  // Creating a TUN interface requires root on macOS.
  // -n: non-interactive (fail immediately if password required — avoids hanging)
  _proc = spawn('sudo', ['-n', singboxBin, 'run', '-c', CONFIG_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  _proc.stdout?.on('data', (d: Buffer) => process.stderr.write(`[singbox] ${d}`))
  _proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[singbox] ${d}`))

  _proc.on('exit', (code, signal) => {
    process.stderr.write(`[tun] sing-box exited: code=${code} signal=${signal}\n`)
    _proc = null
    // If unexpected exit, restart after 2s
    if (signal !== 'SIGTERM' && code !== 0) {
      setTimeout(() => startSingBox(), 2000)
    }
  })

  process.stderr.write(`[tun] sing-box started (pid ${_proc.pid})\n`)
  return _proc
}

export function stopSingBox(): void {
  if (_proc) {
    _proc.kill('SIGTERM')
    _proc = null
  }
}

/** Find sing-box binary (Homebrew or PATH). */
function findSingBox(): string | null {
  const candidates = [
    '/opt/homebrew/bin/sing-box',  // Apple Silicon Homebrew
    '/usr/local/bin/sing-box',     // Intel Homebrew
  ]

  for (const p of candidates) {
    if (existsSync(p)) return p
  }

  // Try PATH
  try {
    const result = execSync('which sing-box', { encoding: 'utf-8' }).trim()
    if (result) return result
  } catch { /* not in PATH */ }

  return null
}

// ── Route management ──────────────────────────────────────────────────────────

/**
 * Add a route for the fake IP range through utun9.
 * Must be called after sing-box has started and created the interface.
 * Requires sudo.
 */
export function addFakeIPRoute(): void {
  try {
    // Remove existing route if present (idempotent)
    execSync(`sudo /sbin/route delete -net ${FAKE_IP_CIDR} 2>/dev/null || true`, { stdio: 'pipe' })
    execSync(`sudo /sbin/route add -net ${FAKE_IP_CIDR} ${TUN_ADDR}`, { stdio: 'pipe' })
    process.stderr.write(`[tun] Route added: ${FAKE_IP_CIDR} → ${TUN_ADDR} (${TUN_INTERFACE})\n`)
  } catch (err) {
    throw new Error(`Failed to add route: ${err}`)
  }
}

export function removeFakeIPRoute(): void {
  try {
    execSync(`sudo /sbin/route delete -net ${FAKE_IP_CIDR} 2>/dev/null || true`, { stdio: 'pipe' })
    process.stderr.write(`[tun] Route removed: ${FAKE_IP_CIDR}\n`)
  } catch { /* ignore */ }
}

/** Wait for utun9 to appear (sing-box creates it asynchronously). */
export async function waitForInterface(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      execSync(`/sbin/ifconfig ${TUN_INTERFACE}`, { stdio: 'pipe' })
      process.stderr.write(`[tun] Interface ${TUN_INTERFACE} is up\n`)
      return
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`Timeout waiting for ${TUN_INTERFACE} to appear`)
}

// ── /etc/resolver entries ─────────────────────────────────────────────────────

import { AI_HOSTNAMES } from './fake-ip.js'
import { DNS_PORT } from './dns-server.js'

const RESOLVER_DOMAINS = [...new Set(AI_HOSTNAMES.map(h => h.split('.').slice(-2).join('.')))]
// e.g. ['anthropic.com', 'openai.com', 'openrouter.ai', 'googleapis.com']

const RESOLVER_CONTENT = `# Sci proxy — per-domain DNS redirect
nameserver 127.0.0.1
port ${DNS_PORT}
`

export function writeResolverEntries(): void {
  for (const domain of RESOLVER_DOMAINS) {
    const path = `/etc/resolver/${domain}`
    try {
      execSync(`sudo mkdir -p /etc/resolver`)
      execSync(`echo '${RESOLVER_CONTENT}' | sudo tee ${path} > /dev/null`)
      process.stderr.write(`[tun] DNS resolver: /etc/resolver/${domain} → 127.0.0.1:${DNS_PORT}\n`)
    } catch (err) {
      throw new Error(`Failed to write ${path}: ${err}`)
    }
  }
  execSync('sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder 2>/dev/null || true', { stdio: 'pipe' })
}

export function removeResolverEntries(): void {
  for (const domain of RESOLVER_DOMAINS) {
    try {
      execSync(`sudo rm -f /etc/resolver/${domain}`, { stdio: 'pipe' })
      process.stderr.write(`[tun] DNS resolver removed: /etc/resolver/${domain}\n`)
    } catch { /* ignore */ }
  }
  try {
    execSync('sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder 2>/dev/null || true', { stdio: 'pipe' })
  } catch { /* ignore */ }
}

export { RESOLVER_DOMAINS }

// ── High-level TUN lifecycle (with safety guard) ──────────────────────────────

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
export async function startTUNWithGuard(adapter: unknown): Promise<void> {
  // Step 1: clean up any stale state from previous crash
  runRecoveryIfStale()

  // Step 2: write recovery script BEFORE touching system
  writeRecoveryScript()

  // Step 3: register cleanup — runs on SIGTERM/SIGINT/exit/uncaughtException
  registerTUNCleanup(async () => {
    stopSingBox()
    removeFakeIPRoute()
    removeResolverEntries()
  })

  // Step 4: start sing-box
  startSingBox()

  // Step 5: wait for utun interface
  await waitForInterface(6000)

  // Step 6: add fake IP route (requires sudoers rule from vpn install)
  addFakeIPRoute()

  // Step 7: flush DNS so resolver entries take effect immediately
  try {
    execSync('sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder 2>/dev/null || true', { stdio: 'pipe' })
    process.stderr.write('[tun] DNS cache flushed\n')
  } catch { /* non-fatal */ }
}
