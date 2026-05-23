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
export declare class SqliteAdapter extends CloudAdapter {
    readonly backend = "sqlite";
    protected _downloadIfNeeded(): Promise<void>;
    protected _sync(): Promise<{
        uploaded: number;
        downloaded: number;
    }>;
}
//# sourceMappingURL=sqlite-adapter.d.ts.map