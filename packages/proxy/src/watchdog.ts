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

import { execSync } from 'child_process'
import { appendFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import http from 'http'

const LOG_DIR = join(homedir(), 'Vault', 'sci')
const LOG_FILE = join(LOG_DIR, 'proxy.log')
const STATE_FILE = join(homedir(), '.sci', 'vpn-state.json')

interface ProxyState {
  proxyEnabled: boolean
  proxyHost: string
  proxyPort: number
  enabledAt: string
  previousState: {
    enabled: boolean
    server: string
    port: number
  } | null
}

function log(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  process.stderr.write(line)
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line)
  } catch { /* ignore log write failures */ }
}

function getSystemProxyState(): { enabled: boolean; server: string; port: number } {
  try {
    const result = execSync('networksetup -getsecurewebproxy Wi-Fi 2>/dev/null', {
      encoding: 'utf-8', timeout: 5000
    })
    const lines = result.split('\n')
    const enabled = lines.find(l => l.startsWith('Enabled:'))?.includes('Yes') ?? false
    const server = lines.find(l => l.startsWith('Server:'))?.split(':')[1]?.trim() ?? ''
    const portStr = lines.find(l => l.startsWith('Port:'))?.split(':')[1]?.trim() ?? '0'
    return { enabled, server, port: parseInt(portStr, 10) }
  } catch {
    return { enabled: false, server: '', port: 0 }
  }
}

function revertSystemProxy(reason: string): void {
  try {
    log(`[watchdog] REVERTING system proxy: ${reason}`)
    execSync('networksetup -setsecurewebproxystate Wi-Fi off', { timeout: 5000 })
    log('[watchdog] System proxy reverted successfully')

    // Update state file
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as ProxyState
      state.proxyEnabled = false
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
    } catch { /* ignore */ }
  } catch (err) {
    log(`[watchdog] FAILED to revert system proxy: ${err}`)
  }
}

async function checkProxyHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/health`, { timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200)
      res.destroy()
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

export function saveProxyState(port: number): void {
  try {
    const sciDir = join(homedir(), '.sci')
    if (!existsSync(sciDir)) mkdirSync(sciDir, { recursive: true })

    const prev = getSystemProxyState()
    const state: ProxyState = {
      proxyEnabled: true,
      proxyHost: '127.0.0.1',
      proxyPort: port,
      enabledAt: new Date().toISOString(),
      previousState: prev,
    }
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
    log(`[watchdog] State saved to ${STATE_FILE}`)
  } catch (err) {
    log(`[watchdog] Failed to save state: ${err}`)
  }
}

export function startWatchdog(port: number): void {
  let consecutiveFailures = 0
  const MAX_FAILURES = 3      // 3 failures × 30s = 90s before revert
  const CHECK_INTERVAL = 30_000

  log(`[watchdog] Started (checking port ${port} every ${CHECK_INTERVAL / 1000}s)`)

  const interval = setInterval(async () => {
    const proxyState = getSystemProxyState()

    // If system proxy is pointing at us, verify we're healthy
    if (proxyState.enabled && proxyState.server === '127.0.0.1' && proxyState.port === port) {
      const healthy = await checkProxyHealth(port)
      if (healthy) {
        consecutiveFailures = 0
      } else {
        consecutiveFailures++
        log(`[watchdog] Health check failed (${consecutiveFailures}/${MAX_FAILURES})`)

        if (consecutiveFailures >= MAX_FAILURES) {
          revertSystemProxy(`${consecutiveFailures} consecutive health check failures`)
          consecutiveFailures = 0
        }
      }
    } else {
      // System proxy is not pointing at us — nothing to watch
      consecutiveFailures = 0
    }
  }, CHECK_INTERVAL)

  // Revert on process exit
  const onExit = (signal: string) => {
    log(`[watchdog] Process exiting (${signal}), checking system proxy...`)
    const state = getSystemProxyState()
    if (state.enabled && state.server === '127.0.0.1' && state.port === port) {
      revertSystemProxy(`process exit (${signal})`)
    }
    clearInterval(interval)
  }

  process.on('SIGTERM', () => onExit('SIGTERM'))
  process.on('SIGINT', () => onExit('SIGINT'))
  process.on('exit', () => onExit('exit'))

  // Unref so the watchdog doesn't prevent process exit
  interval.unref()
}
