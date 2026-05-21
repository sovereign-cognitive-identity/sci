/**
 * Local SQLite-backed StorageAdapter for the agent (SCI-118).
 *
 * Replaces the v0.5 NoopStorageAdapter with a real on-device memory store
 * so anonymized requests can recall + persist memories. No cloud sync —
 * the agent's job is to keep memory local. Cross-device sync is the
 * SCI-114 phase E concern (encrypted blob via Tailscale-mediated push)
 * and lives outside this adapter.
 *
 * Implementation: thin subclass of `@sci/core`'s `CloudAdapter`, which
 * already implements the entire StorageAdapter surface against SQLite +
 * hnswlib. We only need to override the two abstract sync hooks with
 * no-ops. That gives us:
 *
 *   - `sci.db`  — SQLite database (memories, profiles, identity facts)
 *   - `sci.idx` — hnswlib HNSW index for vector recall
 *
 * Both files live in `localDir` (default ~/.sci/memory/). The 'work' and
 * 'personal' profiles are seeded on first connect() via CloudAdapter's
 * INSERT OR IGNORE, so `injectMemoryContext`'s `getProfile('work')`
 * lookup succeeds immediately — no extra bootstrap step needed.
 */
import { CloudAdapter } from '@sci/core';
export class SqliteStorageAdapter extends CloudAdapter {
    backend = 'sqlite-local';
    constructor(localDir) {
        super(localDir);
    }
    /** No cloud to download from — local-only. */
    async _downloadIfNeeded() {
        /* noop */
    }
    /**
     * No cloud to push to. CloudAdapter still calls `index.writeIndex(idxPath)`
     * before invoking us via the public `sync()` method, so the in-memory HNSW
     * index gets persisted to disk on graceful shutdown. We just return zeros.
     */
    async _sync() {
        return { uploaded: 0, downloaded: 0 };
    }
}
//# sourceMappingURL=storage-sqlite.js.map