#!/usr/bin/env node
/**
 * `sci` — local on-device agent CLI.
 *
 * Sub-commands:
 *   sci up       — start the agent (foreground; daemonization comes later)
 *   sci status   — print agent state if running
 *   sci config   — interactive credential setup
 *   sci --help   — usage
 *
 * v0.5 scaffolding (SCI-115). Provider handlers, MITM, memory all
 * land in subsequent phases (SCI-116 → SCI-121).
 */
import { loadConfig } from './config.js';
import { startAgent } from './agent.js';
import { runDoctor } from './doctor.js';
import { spawnSync } from 'child_process';
import { existsSync, homedir } from 'fs';
import { join } from 'path';

async function runSetup(config, extraArgs) {
    const { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } = await import('fs');
    const { homedir, hostname } = await import('os');
    const { join } = await import('path');
    const home = homedir();
    const configDir = config.configDir;
    // 1. Create ~/.sci/
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    process.stdout.write(`✓ ${configDir} ready\n`);
    // Parse --token <code> and --control-plane <url> from extraArgs.
    // When --token is present we do headless enrollment instead of browser OAuth.
    let inviteToken = null;
    let controlPlane = config.controlPlaneUrl;
    for (let i = 0; i < extraArgs.length; i++) {
        if (extraArgs[i] === '--token' && extraArgs[i + 1]) {
            inviteToken = extraArgs[++i];
        } else if (extraArgs[i] === '--control-plane' && extraArgs[i + 1]) {
            controlPlane = extraArgs[++i];
        }
    }
    // 1b. Headless enrollment via invite token (EP4).
    if (inviteToken) {
        process.stdout.write(`\nEnrolling via invite token...\n`);
        let enrollResp;
        try {
            const res = await fetch(`${controlPlane}/api/devices/invite/redeem`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    token: inviteToken,
                    name: hostname(),
                    platform: process.platform,
                }),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                process.stderr.write(`Enrollment failed (${res.status}): ${body}\n`);
                process.exit(1);
            }
            enrollResp = await res.json();
        } catch (err) {
            process.stderr.write(`Could not reach control plane at ${controlPlane}: ${err.message}\n`);
            process.exit(1);
        }
        // Write CA cert + key so the agent can do TLS MITM.
        if (enrollResp.caCert) {
            writeFileSync(join(configDir, 'ca.crt'), enrollResp.caCert, { mode: 0o644 });
            process.stdout.write(`✓ CA cert written to ${configDir}/ca.crt\n`);
        }
        if (enrollResp.caKey) {
            writeFileSync(join(configDir, 'ca.key'), enrollResp.caKey, { mode: 0o600 });
            process.stdout.write(`✓ CA key written to ${configDir}/ca.key\n`);
        }
        // Write agent token — used for authenticated control plane calls (e.g. memory sync).
        if (enrollResp.agentToken) {
            writeFileSync(join(configDir, 'agent.token'), enrollResp.agentToken, { mode: 0o600 });
            process.stdout.write(`✓ Agent token written to ${configDir}/agent.token\n`);
        }
        // Persist the control plane URL so future agent runs know where to sync.
        writeFileSync(join(configDir, 'control-plane'), controlPlane + '\n', { mode: 0o644 });
        process.stdout.write(`✓ Control plane URL saved (${controlPlane})\n`);
        process.stdout.write(`✓ Device enrolled: ${enrollResp.device?.name ?? hostname()}\n\n`);
    }
    // 2. Shell exports
    const zshrc = join(home, '.zshrc');
    const exportBlock = [
        '',
        '# Added by sci --setup',
        `export HTTPS_PROXY=http://localhost:${config.proxyPort}`,
        `export NODE_EXTRA_CA_CERTS=$HOME/.sci/ca.crt`,
        `export NO_PROXY=localhost,127.0.0.1,*.brew.sh,formulae.brew.sh,raw.githubusercontent.com,objects.githubusercontent.com`,
    ].join('\n');
    const zshrcExists = existsSync(zshrc);
    const alreadySet = zshrcExists && readFileSync(zshrc, 'utf-8').includes('Added by sci --setup');
    if (!alreadySet) {
        appendFileSync(zshrc, exportBlock + '\n');
        process.stdout.write(`✓ Shell exports written to ~/.zshrc\n`);
    } else {
        process.stdout.write(`✓ Shell exports already present in ~/.zshrc\n`);
    }
    // 3. Launchd plist (macOS only)
    if (process.platform === 'darwin') {
        const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
        mkdirSync(launchAgentsDir, { recursive: true });
        const sciExe = process.execPath; // path to the compiled sci binary
        const plistPath = join(launchAgentsDir, 'com.sci.agent.plist');
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sci.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${sciExe}</string>
    <string>up</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SCI_CONFIG_DIR</key><string>${configDir}</string>
    <key>HOME</key><string>${home}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${configDir}/sci.log</string>
  <key>StandardOutPath</key><string>${configDir}/sci.log</string>
</dict>
</plist>
`;
        writeFileSync(plistPath, plist);
        process.stdout.write(`✓ Launchd plist written to ${plistPath}\n`);
    }
    // 4. MCP registration in ~/.claude.json
    const claudeJsonPath = join(home, '.claude.json');
    if (existsSync(claudeJsonPath)) {
        try {
            const existing = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
            if (!existing.mcpServers) existing.mcpServers = {};
            existing.mcpServers['sci'] = {
                type: 'stdio',
                command: process.execPath,
                args: ['mcp'],
                env: {
                    SCI_CONFIG_DIR: configDir,
                    HOME: home,
                },
            };
            writeFileSync(claudeJsonPath, JSON.stringify(existing, null, 2) + '\n');
            process.stdout.write(`✓ Claude Code MCP registered in ~/.claude.json\n`);
        } catch (e) {
            process.stderr.write(`  Could not update ~/.claude.json: ${e.message}\n`);
        }
    } else {
        process.stdout.write(`  Claude Code not detected — skipping MCP registration\n`);
    }
    // 5. Next steps — copy-paste ready
    process.stdout.write(`
─── Next steps ──────────────────────────────────────────────────
`);
    if (process.platform === 'darwin') {
        process.stdout.write(`  launchctl load ~/Library/LaunchAgents/com.sci.agent.plist
  sci --trust-ca
  sci doctor
`);
    } else {
        process.stdout.write(`  sci up &
  sci --trust-ca
  sci doctor
`);
    }
    process.stdout.write(`─────────────────────────────────────────────────────────────────
`);
}

async function runTrustCA(configDir) {
    const caPath = join(configDir, 'ca.crt');
    if (!existsSync(caPath)) {
        process.stderr.write(`CA not found at ${caPath}\nRun: sci up (once, to generate the CA), then retry.\n`);
        process.exit(1);
    }
    if (process.platform !== 'darwin') {
        process.stdout.write(`Non-macOS: add CA manually.\n`);
        process.stdout.write(`  NODE_EXTRA_CA_CERTS=${caPath} is already set by sci --setup and covers\n`);
        process.stdout.write(`  Claude Code and most Node/Python tools without keychain trust.\n`);
        process.stdout.write(`\nFor system-wide trust on Linux:\n`);
        process.stdout.write(`  sudo cp ${caPath} /usr/local/share/ca-certificates/sci-ca.crt\n`);
        process.stdout.write(`  sudo update-ca-certificates\n`);
        return;
    }
    const keychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
    // Try unlocking the login keychain first (needed in headless/SSH sessions).
    spawnSync('security', ['unlock-keychain', keychain], { stdio: 'ignore' });
    const result = spawnSync('security', [
        'add-trusted-cert', '-r', 'trustRoot', '-k', keychain, caPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status === 0) {
        process.stdout.write(`✓ Sci CA trusted in login keychain.\n`);
        process.stdout.write(`  HTTPS interception will work for curl, Safari, and system tools.\n`);
    } else {
        const stderr = result.stderr?.toString().trim();
        if (stderr) process.stderr.write(`${stderr}\n`);
        process.stderr.write(`\nKeychain trust failed (common in SSH sessions without a GUI).\n`);
        process.stderr.write(`This is OK — Claude Code uses NODE_EXTRA_CA_CERTS, not the keychain.\n`);
        process.stderr.write(`NODE_EXTRA_CA_CERTS is already written to ~/.zshrc by sci --setup.\n`);
        process.stderr.write(`\nFor GUI apps (Safari, curl), trust the CA from a desktop session:\n`);
        process.stderr.write(`  security add-trusted-cert -r trustRoot \\\n`);
        process.stderr.write(`    -k ~/Library/Keychains/login.keychain-db ${caPath}\n`);
        // Exit 0 — this is a soft failure; the agent still works via NODE_EXTRA_CA_CERTS.
    }
}
const VERSION = '0.5.0-dev';
function printUsage() {
    process.stdout.write(`
sci — local AI traffic anonymization + memory agent  (v${VERSION})

Usage:
  sci --setup                             First-run wizard (browser OAuth)
  sci --setup --token <code>              Headless enrollment via invite token
  sci --setup --token <code> \\
      --control-plane <url>               Headless enrollment against a custom control plane
  sci up                                  Start the agent (HTTPS_PROXY listener + memory store)
  sci doctor                              Self-test a running agent (CA, memory, creds, TLS path)
  sci --trust-ca                          Add Sci CA to system keychain (macOS)
  sci status                              Print runtime state if running
  sci config                              Show credential file location + env-var summary
  sci --help                              This message

Configuration (env vars):
  SCI_PROXY_PORT   localhost port to bind to (default 8080)
  SCI_CONFIG_DIR   where to store CA + memory DB (default ~/.sci/)

Once running, point any tool at it:
  export HTTPS_PROXY=http://localhost:8080
  claude --print "test"

Source / docs / issues:
  https://github.com/sovereign-cognitive-identity/sci

`);
}
async function main() {
    const args = process.argv.slice(2);
    const cmd = args[0];
    if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
        printUsage();
        return;
    }
    const config = loadConfig();
    switch (cmd) {
        case 'up': {
            await startAgent(config);
            // startAgent runs until SIGINT/SIGTERM
            return;
        }
        case 'doctor': {
            // SCI-121 self-test. Exits non-zero on any failed check so it composes
            // cleanly with shell scripts (`sci doctor && proceed-with-real-tools`).
            const code = await runDoctor(config);
            process.exit(code);
        }
        // eslint-disable-next-line no-fallthrough
        case 'status': {
            // Placeholder. Real version reads a pid + stats file written by `up`.
            // For now we just dump the resolved config — useful enough that we
            // don't block dogfood on writing pidfile machinery.
            process.stdout.write(`sci status: dumping resolved config (no liveness check yet)\n`);
            process.stdout.write(`config dir: ${config.configDir}\n`);
            process.stdout.write(`memory dir: ${config.memoryDir}\n`);
            process.stdout.write(`port:       ${config.proxyPort}\n`);
            return;
        }
        case 'config': {
            // Show where credentials.env lives and which keys the loader currently
            // sees — same surface `sci doctor` uses, exposed standalone so the
            // user can sanity-check without spinning up the whole self-test.
            const { loadCredentials, summarizeCredentials } = await import('./credentials.js');
            const creds = loadCredentials(config.configDir);
            process.stdout.write(`credentials file: ${config.configDir}/credentials.env\n`);
            process.stdout.write(`  format:  KEY=VALUE per line, # comments, recommended chmod 0600\n`);
            process.stdout.write(`  env vars take priority: ANTHROPIC_API_KEY, OPENAI_API_KEY,\n`);
            process.stdout.write(`                          OPENROUTER_API_KEY, GEMINI_API_KEY (or\n`);
            process.stdout.write(`                          GOOGLE_GENERATIVE_AI_API_KEY)\n`);
            process.stdout.write(`\ncurrently resolved: ${summarizeCredentials(creds)}\n`);
            return;
        }
        case '--trust-ca':
        case 'trust-ca': {
            await runTrustCA(config.configDir);
            return;
        }
        case '--setup':
        case 'setup': {
            await runSetup(config, args.slice(1));
            return;
        }
        case '--version':
        case '-v':
        case 'version': {
            process.stdout.write(`${VERSION}\n`);
            return;
        }
        default: {
            process.stderr.write(`unknown command: ${cmd}\n\n`);
            printUsage();
            process.exit(2);
        }
    }
}
main().catch((err) => {
    process.stderr.write(`sci: fatal error: ${err.message ?? err}\n`);
    if (process.env['SCI_DEBUG'])
        process.stderr.write(`${err.stack}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map