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
  sci up              Start the agent (HTTPS_PROXY listener + memory store)
  sci doctor          Self-test a running agent (CA, memory, creds, TLS path)
  sci --trust-ca      Add Sci CA to system keychain (macOS)
  sci status          Print runtime state if running
  sci config          Show credential file location + env-var summary
  sci --help          This message

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