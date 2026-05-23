/**
 * SqliteAdapter — pure-local SQLite + hnswlib backend, no sync layer.
 *
 * Same on-disk format (sci.db + sci.idx) as iCloudAdapter and the agent's
 * SqliteStorageAdapter, but with both CloudAdapter sync hooks as no-ops:
 * nothing is copied to iCloud Drive and nothing is pushed to a control plane.
 * This is the "easy to deploy" backend — point SCI_LOCAL_DIR at ~/.sci/memory
 * to share the exact store the sci agent reads/writes.
 *
 * Use via SCI_STORAGE_BACKEND=sqlite (see ./index.ts).
 */
import { CloudAdapter } from './cloud-adapter.js';
export class SqliteAdapter extends CloudAdapter {
    backend = 'sqlite';
    // Local-only: nothing to download from a remote.
    async _downloadIfNeeded() {
        /* no remote */
    }
    // Local-only: nothing to sync out.
    async _sync() {
        return { uploaded: 0, downloaded: 0 };
    }
}
//# sourceMappingURL=sqlite-adapter.js.map