/**
 * Agent main process — boots the HTTPS_PROXY listener and waits for
 * shutdown signal.
 *
 * The actual proxy logic lives in `proxy-server.ts` (SCI-116) and is
 * a placeholder here. This file only does process supervision.
 */
import { mkdirSync, existsSync } from 'fs';
import { startProxyServer, closeAdapter } from './proxy-server.js';
export async function startAgent(config) {
    // Make sure the config dir exists. The CA cert + memory DB + token cache
    // all live here. 0700 because it holds credentials.
    if (!existsSync(config.configDir)) {
        mkdirSync(config.configDir, { recursive: true, mode: 0o700 });
    }
    process.stdout.write(`\n🌀 Sci agent starting...\n`);
    process.stdout.write(`   config:  ${config.configDir}\n`);
    process.stdout.write(`   memory:  ${config.memoryDir}\n`);
    process.stdout.write(`   port:    ${config.proxyPort}\n\n`);
    const server = await startProxyServer(config);
    process.stdout.write(`✓ listening on http://localhost:${config.proxyPort}\n`);
    process.stdout.write(`\n  To use:  export HTTPS_PROXY=http://localhost:${config.proxyPort}\n`);
    process.stdout.write(`  Then run any tool that respects that env var.\n`);
    process.stdout.write(`\n  Ctrl-C to stop.\n\n`);
    // Wait for shutdown signal. We don't daemonize in v0.5 — the user runs
    // `sci up` in a terminal or under launchd/systemd. Daemonization is a
    // packaging concern, not an agent-runtime one.
    await new Promise((resolve) => {
        const shutdown = (sig) => {
            process.stdout.write(`\n${sig} received, shutting down...\n`);
            server.close(() => {
                // Drain the SQLite + hnswlib adapter after the listener stops
                // accepting requests, before the process exits. Otherwise recent
                // embeddings buffered in the HNSW index never reach sci.idx.
                closeAdapter()
                    .then(() => {
                    process.stdout.write(`✓ stopped cleanly\n`);
                    resolve();
                })
                    .catch((err) => {
                    process.stderr.write(`shutdown warning: ${err}\n`);
                    resolve();
                });
            });
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    });
}
//# sourceMappingURL=agent.js.map