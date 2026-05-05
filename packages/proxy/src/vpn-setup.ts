/**
 * TUN-mode VPN setup and teardown for macOS.
 *
 * Uses sing-box (brew install sing-box) as the TUN layer:
 *   - Creates utun9 virtual NIC
 *   - Intercepts traffic to fake IPs (198.18.0.0/15) via TLS SNI sniffing
 *   - Forwards as SOCKS5 CONNECT (with real domain name) to our proxy on :1080
 *
 * No /etc/hosts modification. No pf rules. No system-wide DNS change.
 *
 * install:
 *   1. Check brew install sing-box
 *   2. Generate + trust CA cert in system keychain
 *   3. Write /etc/resolver/<domain> entries (per-domain DNS only)
 *   4. Print sudo commands to add route + reload LaunchAgent
 *
 * uninstall:
 *   1. Remove CA from keychain
 *   2. Remove /etc/resolver entries
 *   3. Remove fake IP route
 *   4. Stop sing-box
 */
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { getCACertPath, ensureCACert } from './tls.js'
import {
  writeResolverEntries,
  removeResolverEntries,
  removeFakeIPRoute,
  stopSingBox,
  TUN_INTERFACE,
  TUN_ADDR,
  RESOLVER_DOMAINS,
} from './tun.js'
import { FAKE_IP_CIDR, AI_HOSTNAMES } from './fake-ip.js'
import { SOCKS5_PORT } from './socks5.js'

// ── Install ───────────────────────────────────────────────────────────────────

export async function installVPN(): Promise<void> {
  console.log('\n🔒 Installing Sci TUN interceptor...\n')

  // Step 1: Check sing-box
  process.stdout.write('  [1/4] Checking sing-box... ')
  const singboxPath = findSingBox()
  if (!singboxPath) {
    console.log('✗')
    console.error('\n  sing-box not found. Install it:\n    brew install sing-box\n')
    process.exit(1)
  }
  console.log(`✓  (${singboxPath})`)

  // Step 2: Generate CA cert
  process.stdout.write('  [2/4] Generating CA certificate... ')
  ensureCACert()
  const certPath = getCACertPath()
  console.log('✓')

  // Step 3: Write /etc/resolver entries (requires sudo)
  process.stdout.write('  [3/4] Writing DNS resolver entries... ')
  try {
    writeResolverEntries()
    console.log('✓')
  } catch (err) {
    console.log('✗')
    console.error(`\n  Failed: ${err}`)
    console.error('  Try running: sci vpn install  (it will prompt for your password)\n')
    process.exit(1)
  }

  // Step 4: Trust CA cert in system keychain (requires sudo)
  process.stdout.write('  [4/4] Trusting CA cert in system keychain... ')
  try {
    execSync(
      `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${certPath}`,
      { stdio: 'pipe' }
    )
    console.log('✓')
  } catch {
    console.log('(already trusted or skipped)')
  }

  console.log(`
  ┌─ Run these commands in a Terminal window ──────────────────────────────────
  │
  │  # Add route for fake IP range → utun9
  │  # (run AFTER the proxy has started and utun9 exists)
  │  sudo route add -net ${FAKE_IP_CIDR} ${TUN_ADDR}
  │
  │  # Enable TUN mode in the LaunchAgent and reload:
  │  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:SCI_VPN_MODE true" \\
  │    ~/Library/LaunchAgents/com.sci.proxy.plist
  │  launchctl unload ~/Library/LaunchAgents/com.sci.proxy.plist
  │  launchctl load ~/Library/LaunchAgents/com.sci.proxy.plist
  │
  └────────────────────────────────────────────────────────────────────────────

  How it works:
    • DNS queries for AI domains → 127.0.0.1:5353 (our DNS server)
    • DNS server returns fake IPs in ${FAKE_IP_CIDR}
    • Traffic to fake IPs → utun9 (sing-box TUN)
    • sing-box reads TLS SNI → SOCKS5 CONNECT "api.anthropic.com:443"
    • Our SOCKS5 server on :${SOCKS5_PORT} anonymizes + injects memory
    • Outbound uses real DNS → real IPs → bypasses TUN (no loop)

  Intercepted endpoints:
${AI_HOSTNAMES.map(h => `    • ${h}`).join('\n')}

  DNS resolver entries written:
${RESOLVER_DOMAINS.map(d => `    • /etc/resolver/${d}`).join('\n')}

  Watch the log:
    tail -f ~/Vault/sci/proxy.log

  To undo everything:
    sci vpn uninstall
`)
}

function findSingBox(): string | null {
  const candidates = ['/opt/homebrew/bin/sing-box', '/usr/local/bin/sing-box']
  for (const p of candidates) { if (existsSync(p)) return p }
  try { return execSync('which sing-box', { encoding: 'utf-8' }).trim() } catch { return null }
}

// ── Uninstall ─────────────────────────────────────────────────────────────────

export async function uninstallVPN(): Promise<void> {
  console.log('\n🔓 Uninstalling Sci TUN interceptor...\n')

  // Stop sing-box
  process.stdout.write('  [1/4] Stopping sing-box... ')
  stopSingBox()
  console.log('✓')

  // Remove fake IP route
  process.stdout.write('  [2/4] Removing fake IP route... ')
  removeFakeIPRoute()
  console.log('✓')

  // Remove /etc/resolver entries
  process.stdout.write('  [3/4] Removing DNS resolver entries... ')
  removeResolverEntries()
  console.log('✓')

  // Remove CA from keychain
  process.stdout.write('  [4/4] Removing CA from system keychain... ')
  try {
    execSync(
      'sudo security delete-certificate -c "Sci Local CA" /Library/Keychains/System.keychain 2>/dev/null || true',
      { stdio: 'pipe' }
    )
    console.log('✓')
  } catch {
    console.log('(not found, skipping)')
  }

  console.log('\n✓ Sci TUN interceptor uninstalled. AI traffic goes direct.')
  console.log('  Verify: curl https://api.anthropic.com/ (should return 404, not refused)\n')
}
