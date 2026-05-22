#!/usr/bin/env node
/**
 * Sci Proxy — Rate Limit Reset
 *
 * Resets the sci OAuth token so the agent fetches a fresh one on next startup.
 * Useful after hitting Anthropic rate limits or when token refresh has stalled.
 *
 * Steps:
 *   1. Set expires_at_ms = 0 in ~/.sci/oauth.json  (forces token refresh)
 *   2. Unload + reload the com.sci.agent launchd agent
 *   3. Wait for agent to start
 *   4. Confirm startup by reading recent log entries
 *
 * Usage:
 *   node scripts/reset-proxy-rate-limit.mjs
 *   npm run reset:ratelimit
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync, spawnSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'

const HOME = homedir()
const OAUTH_FILE = join(HOME, '.sci', 'oauth.json')
const SCI_LOG = join(HOME, '.sci', 'sci.log')
const PLIST_LABEL = 'com.sci.agent'
const PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`)

const GREEN = '[32m'
const RED = '[31m'
const YELLOW = '[33m'
const BLUE = '[34m'
const NC = '[0m'

function log(msg) {
  console.log(`  ${msg}`)
}

function logStep(msg) {
  console.log(`\n${BLUE}→${NC} ${msg}`)
}

function logOk(msg) {
  console.log(`  ${GREEN}✓${NC} ${msg}`)
}

function logWarn(msg) {
  console.log(`  ${YELLOW}!${NC} ${msg}`)
}

function logErr(msg) {
  console.log(`  ${RED}✗${NC} ${msg}`)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ── Step 1: Reset oauth.json ─────────────────────────────────────────────────

logStep('Resetting OAuth token expiry...')

if (!existsSync(OAUTH_FILE)) {
  logErr(`No oauth.json at ${OAUTH_FILE}`)
  logErr('Cannot reset — no token to refresh. Run sci auth flow first.')
  process.exit(1)
}

let oauthData
try {
  oauthData = JSON.parse(readFileSync(OAUTH_FILE, 'utf8'))
} catch (err) {
  logErr(`Failed to parse ${OAUTH_FILE}: ${err.message}`)
  process.exit(1)
}

const originalExpiry = oauthData.expires_at_ms ?? 0
const wasExpired = originalExpiry < Date.now()

// Keep refresh_token — that's what the agent uses to get a new access_token.
// Set access_token expiry to 0 so the agent treats it as expired immediately.
oauthData.expires_at_ms = 0

try {
  writeFileSync(OAUTH_FILE, JSON.stringify(oauthData, null, 2) + '\n', 'utf8')
  if (wasExpired) {
    logOk(`Token was already expired — set expires_at_ms = 0 (was ${originalExpiry})`)
  } else {
    logOk(`Set expires_at_ms = 0 (was ${originalExpiry}, valid for ${Math.round((originalExpiry - Date.now()) / 3600000)}h more)`)
  }
} catch (err) {
  logErr(`Failed to write ${OAUTH_FILE}: ${err.message}`)
  process.exit(1)
}

// ── Step 2: Restart the launchd agent ───────────────────────────────────────

logStep('Restarting sci-agent via launchctl...')

if (!existsSync(PLIST_PATH)) {
  logWarn(`Plist not found at ${PLIST_PATH}`)
  logWarn('Trying launchctl bootout/bootstrap directly...')
}

// Attempt unload
const unloadResult = spawnSync(
  'launchctl', ['unload', PLIST_PATH],
  { stdio: 'pipe', encoding: 'utf8' }
)

if (unloadResult.status === 0) {
  logOk(`Unloaded ${PLIST_LABEL}`)
} else if (unloadResult.stderr?.includes('No such process') ||
           unloadResult.stderr?.includes('Could not find') ||
           unloadResult.status === 3) {
  logWarn(`Agent was not loaded — will load fresh`)
} else {
  // Non-fatal — agent might be partially loaded
  logWarn(`launchctl unload exit ${unloadResult.status}: ${(unloadResult.stderr ?? '').trim().slice(0, 120)}`)
}

// Small gap so the process fully exits before re-loading
await sleep(1000)

// Attempt load
const loadResult = spawnSync(
  'launchctl', ['load', PLIST_PATH],
  { stdio: 'pipe', encoding: 'utf8' }
)

if (loadResult.status === 0) {
  logOk(`Loaded ${PLIST_LABEL}`)
} else if (loadResult.stderr?.includes('already loaded')) {
  logWarn('Agent already loaded — using kickstart to restart')
  spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${PLIST_LABEL}`], { stdio: 'pipe' })
  logOk('Sent kickstart signal')
} else {
  logErr(`launchctl load exit ${loadResult.status}: ${(loadResult.stderr ?? '').trim().slice(0, 120)}`)
  logErr('Try manually: launchctl load ~/Library/LaunchAgents/com.sci.agent.plist')
  // Don't exit — carry on and check logs anyway
}

// ── Step 3: Wait for agent to start ─────────────────────────────────────────

logStep('Waiting 5s for agent to initialize...')

// Capture log size before we start waiting so we can detect new entries
let logSizeBefore = 0
try {
  logSizeBefore = parseInt(execSync(`wc -c < "${SCI_LOG}"`, { encoding: 'utf8' }).trim())
} catch { /* ignore */ }

await sleep(5000)

// ── Step 4: Verify startup from log ─────────────────────────────────────────

logStep('Checking agent startup in sci.log...')

if (!existsSync(SCI_LOG)) {
  logErr(`sci.log not found at ${SCI_LOG}`)
  logErr('Cannot confirm startup — check ~/Library/LaunchAgents/ and launchctl list')
  process.exit(1)
}

let logSizeAfter = 0
let recentLog = ''
try {
  logSizeAfter = parseInt(execSync(`wc -c < "${SCI_LOG}"`, { encoding: 'utf8' }).trim())
  recentLog = execSync(`tail -30 "${SCI_LOG}"`, { encoding: 'utf8' })
} catch (err) {
  logErr(`Failed to read sci.log: ${err.message}`)
  process.exit(1)
}

const newBytes = logSizeAfter - logSizeBefore

// Look for positive signals of agent startup
const signals = {
  started:      /sci.*(starting|started|listening|up on|proxy start)/i,
  storage:      /storage.*:.*backend|backend.*storage/i,
  token:        /token.*refresh|refresh.*token|oauth|access_token/i,
  error:        /ERROR|FATAL|panic|Uncaught Exception/i,
}

const hasStarted = signals.started.test(recentLog)
const hasStorage = signals.storage.test(recentLog)
const hasToken   = signals.token.test(recentLog)
const hasError   = signals.error.test(recentLog)

if (newBytes > 0) {
  logOk(`Agent wrote ${newBytes} bytes to log after restart`)
} else {
  logWarn('No new log bytes detected — agent may not have restarted yet')
}

if (hasStarted) {
  logOk('Detected startup message in log')
} else if (newBytes > 200) {
  logOk('Detected substantial log activity (agent likely running)')
} else {
  logWarn('No startup message found in recent log — agent may still be initializing')
}

if (hasToken) {
  logOk('Detected token refresh activity in log')
}

if (hasStorage) {
  logOk('Detected storage initialization in log')
}

if (hasError) {
  logErr('Found ERROR/FATAL in recent log entries')
  log('')
  // Print the error lines
  const errorLines = recentLog
    .split('\n')
    .filter(l => signals.error.test(l))
    .slice(0, 5)
  errorLines.forEach(l => log(`  ${RED}${l.trim().slice(0, 120)}${NC}`))
  log('')
  logErr('Fix the error above before proceeding')
}

// ── Print last few log lines for visibility ───────────────────────────────────

log('')
log(`Last 10 lines of ${SCI_LOG}:`)
log('─'.repeat(50))
recentLog.split('\n').slice(-12).filter(l => l.trim()).forEach(l => {
  log(`  ${YELLOW}${l.trim().slice(0, 110)}${NC}`)
})
log('─'.repeat(50))

// ── Final verdict ─────────────────────────────────────────────────────────────

console.log('')
if (!hasError && (hasStarted || newBytes > 0)) {
  console.log(`  ${GREEN}DONE${NC}: sci-agent restarted. Token will refresh automatically.`)
  console.log(`  Monitor: tail -f ~/.sci/sci.log`)
  process.exit(0)
} else if (hasError) {
  console.log(`  ${RED}FAIL${NC}: Agent had errors after restart. See log above.`)
  process.exit(1)
} else {
  console.log(`  ${YELLOW}WARN${NC}: Could not confirm clean startup. Check log manually:`)
  console.log(`  tail -f ~/.sci/sci.log`)
  process.exit(0) // non-fatal — might just need more time
}
