/**
 * Agent runtime config — loaded once at startup from env vars + ~/.sci/agent.toml.
 *
 * Single-user assumptions: the user running the agent is the user the
 * agent serves. No multi-tenant scoping. Credential storage is per-user
 * config files with 0600 perms.
 */
import { homedir } from 'os';
import { join } from 'path';
export function loadConfig() {
    const configDir = process.env['SCI_CONFIG_DIR'] ?? join(homedir(), '.sci');
    return {
        proxyPort: parseInt(process.env['SCI_PROXY_PORT'] ?? '8080'),
        configDir,
        memoryDir: process.env['SCI_MEMORY_DIR'] ?? join(configDir, 'memory'),
        // Subset of hostnames the agent inspects + anonymizes. Everything else
        // is a transparent CONNECT tunnel — Sci does not act as a generic web
        // proxy, only as an AI-traffic-aware shim. See SCI-114 phase A.2.
        aiHosts: new Set([
            'api.anthropic.com',
            'api.openai.com',
            'openrouter.ai',
            'generativelanguage.googleapis.com',
        ]),
    };
}
//# sourceMappingURL=config.js.map