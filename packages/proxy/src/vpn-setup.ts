/**
 * VPN setup and teardown for macOS.
 *
 * install:
 *   1. Generate CA cert (if not exists)
 *   2. Trust CA cert in macOS System keychain (requires admin)
 *   3. Write AI endpoints to /etc/hosts (requires admin)
 *   4. Install pf rules: redirect 127.0.0.1:443 → 127.0.0.1:8443 (requires admin)
 *   5. Update Launch Agent to start in VPN mode
 *
 * uninstall:
 *   1. Remove CA from keychain
 *   2. Remove /etc/hosts entries
 *   3. Remove pf rules
 *   4. Revert Launch Agent
 */
import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { getCACertPath, ensureCACert } from './tls.js'
import { AI_ENDPOINTS } from './dns-resolver.js'
import { VPN_PORT } from './server-https.js'

const HOSTS_FILE = '/etc/hosts'
const HOSTS_MARKER_START = '# BEGIN sci-vpn'
const HOSTS_MARKER_END = '# END sci-vpn'
const PF_ANCHOR = 'sci-vpn'
const PF_CONF = '/etc/pf.anchors/sci-vpn'

// Run a shell command with admin privileges via osascript
function sudo(command: string): void {
  execSync(`osascript -e 'do shell script "${command.replace(/'/g, "\\'")}" with administrator privileges'`)
}

// ── Install ───────────────────────────────────────────────────────────────────

export async function installVPN(): Promise<void> {
  console.log('\n🔒 Installing Sci VPN...\n')

  // Step 1: Generate CA cert — no privileges needed
  process.stdout.write('  [1/3] Generating CA certificate... ')
  ensureCACert()
  const certPath = getCACertPath()
  console.log('✓')

  // Step 2: Prepare /etc/hosts file
  process.stdout.write('  [2/3] Preparing /etc/hosts entries... ')
  const currentHosts = readFileSync(HOSTS_FILE, 'utf-8')
  const lines = currentHosts.split('\n')
  let inBlock = false
  const cleaned = lines.filter(line => {
    if (line.includes(HOSTS_MARKER_START)) { inBlock = true; return false }
    if (line.includes(HOSTS_MARKER_END))   { inBlock = false; return false }
    return !inBlock
  }).join('\n')
  const hostsBlock = [HOSTS_MARKER_START, ...Object.keys(AI_ENDPOINTS).map(h => `127.0.0.1 ${h}`), HOSTS_MARKER_END].join('\n')
  const newHosts = cleaned.trimEnd() + '\n\n' + hostsBlock + '\n'
  const tmpHostsPath = `/tmp/sci-hosts-${Date.now()}`
  writeFileSync(tmpHostsPath, newHosts)
  console.log('✓')

  // Step 3: Prepare pf rules
  process.stdout.write('  [3/3] Preparing pf port redirect rules... ')
  const pfRules = `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port ${VPN_PORT}\n`
  const tmpPfPath = `/tmp/sci-pf-${Date.now()}`
  writeFileSync(tmpPfPath, pfRules)
  console.log('✓')

  // Print the sudo commands the user must run in their terminal
  console.log(`
  ┌─ Run these 3 commands in a Terminal window ────────────────────────────────
  │
  │  # 1. Trust the Sci CA in your system keychain
  │  sudo security add-trusted-cert -d -r trustRoot \\
  │    -k /Library/Keychains/System.keychain \\
  │    ${certPath}
  │
  │  # 2. Redirect AI endpoints to localhost
  │  sudo cp ${tmpHostsPath} /etc/hosts
  │
  │  # 3. Forward port 443 → ${VPN_PORT} via pf
  │  sudo mkdir -p /etc/pf.anchors
  │  sudo cp ${tmpPfPath} ${PF_CONF}
  │  echo 'rdr-anchor "${PF_ANCHOR}"' | sudo pfctl -f - 2>/dev/null || true
  │  sudo pfctl -a ${PF_ANCHOR} -f ${PF_CONF}
  │  sudo pfctl -e 2>/dev/null || true
  │
  └────────────────────────────────────────────────────────────────────────────

  After running those commands:
    1. Reload the Launch Agent in VPN mode:
       launchctl unload ~/Library/LaunchAgents/com.sci.proxy.plist
       SCI_VPN_MODE=true — update the plist, then:
       launchctl load ~/Library/LaunchAgents/com.sci.proxy.plist

    2. Restart Claude Code — all AI traffic will be intercepted

  Intercepted endpoints:
${Object.keys(AI_ENDPOINTS).map(h => `    • ${h}`).join('\n')}

  Watch the log:
    tail -f ~/Vault/sci/proxy.log

  To undo:
    sci vpn uninstall
`)
}

// ── Uninstall ─────────────────────────────────────────────────────────────────

export async function uninstallVPN(): Promise<void> {
  console.log('\n🔓 Uninstalling Sci VPN...\n')

  // Remove CA from keychain
  process.stdout.write('  [1/3] Removing CA from keychain... ')
  try {
    sudo('security delete-certificate -c "Sci Local CA" /Library/Keychains/System.keychain')
    console.log('✓')
  } catch {
    console.log('(not found, skipping)')
  }

  // Remove /etc/hosts entries
  process.stdout.write('  [2/3] Removing /etc/hosts entries... ')
  try {
    const hosts = readFileSync(HOSTS_FILE, 'utf-8')
    const lines = hosts.split('\n')
    let inBlock = false
    const cleaned = lines.filter(line => {
      if (line.includes(HOSTS_MARKER_START)) { inBlock = true; return false }
      if (line.includes(HOSTS_MARKER_END)) { inBlock = false; return false }
      return !inBlock
    }).join('\n')
    const tmpPath = `/tmp/sci-hosts-clean-${Date.now()}`
    writeFileSync(tmpPath, cleaned)
    sudo(`cp ${tmpPath} ${HOSTS_FILE}`)
    console.log('✓')
  } catch (err) {
    console.log(`(error: ${err})`)
  }

  // Remove pf rules
  process.stdout.write('  [3/3] Removing pf port redirect... ')
  try {
    sudo(`pfctl -a ${PF_ANCHOR} -F all 2>/dev/null; true`)
    console.log('✓')
  } catch {
    console.log('(not found, skipping)')
  }

  // Remove com.sci.env.plist if present (it sets ANTHROPIC_BASE_URL system-wide)
  const envPlist = `${process.env['HOME']}/Library/LaunchAgents/com.sci.env.plist`
  if (existsSync(envPlist)) {
    process.stdout.write('  [+]  Removing com.sci.env.plist (ANTHROPIC_BASE_URL)... ')
    try {
      sudo(`launchctl unload ${envPlist} 2>/dev/null; rm ${envPlist}`)
      execSync('launchctl unsetenv ANTHROPIC_BASE_URL 2>/dev/null || true')
      console.log('✓')
    } catch { console.log('(skipped)') }
  }

  // Flush DNS cache
  process.stdout.write('  [+]  Flushing DNS cache... ')
  try {
    sudo('dscacheutil -flushcache; killall -HUP mDNSResponder 2>/dev/null || true')
    console.log('✓')
  } catch { console.log('(skipped)') }

  console.log('\n✓ Sci VPN uninstalled. AI traffic is no longer intercepted.')
  console.log('  Verify: curl https://api.anthropic.com (should return 404, not connection refused)\n')
}
