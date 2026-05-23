/**
 * Storage backend factory.
 *
 * Reads SCI_STORAGE_BACKEND and returns the appropriate adapter.
 *
 * SCI_STORAGE_BACKEND values:
 *   local    — Postgres + pgvector (default, current behaviour)
 *   dropbox  — SQLite + hnswlib synced to Dropbox (requires SCI_DROPBOX_TOKEN)
 *   s3       — SQLite + hnswlib synced to S3 (requires SCI_S3_BUCKET etc.)
 *   icloud   — SQLite + hnswlib synced to ~/Library/Mobile Documents/
 *
 * For the normie tier managed service, the backend is selected at signup
 * and the adapter is instantiated with the user's credentials server-side.
 */
import { join } from 'path';
import { homedir } from 'os';
const DEFAULT_LOCAL_DIR = join(homedir(), '.sci', 'data');
export async function createStorageAdapter() {
    const backend = process.env['SCI_STORAGE_BACKEND'] ?? 'local';
    switch (backend) {
        case 'local': {
            const { LocalAdapter } = await import('./local-adapter.js');
            const adapter = new LocalAdapter(process.env['SCI_DB_READER_URL'] ?? requireEnv('SCI_DB_READER_URL'), process.env['SCI_DB_WRITER_URL'] ?? requireEnv('SCI_DB_WRITER_URL'));
            await adapter.connect();
            return adapter;
        }
        case 'dropbox': {
            const { DropboxAdapter } = await import('./dropbox-adapter.js');
            const localDir = process.env['SCI_LOCAL_DIR'] ?? DEFAULT_LOCAL_DIR;
            const adapter = new DropboxAdapter(localDir, requireEnv('SCI_DROPBOX_TOKEN'));
            await adapter.connect();
            return adapter;
        }
        case 's3': {
            const { S3Adapter } = await import('./s3-adapter.js');
            const localDir = process.env['SCI_LOCAL_DIR'] ?? DEFAULT_LOCAL_DIR;
            const adapter = new S3Adapter(localDir, {
                bucket: requireEnv('SCI_S3_BUCKET'),
                region: process.env['SCI_S3_REGION'] ?? 'us-east-1',
                endpoint: process.env['SCI_S3_ENDPOINT'],
            });
            await adapter.connect();
            return adapter;
        }
        case 'icloud': {
            const { iCloudAdapter } = await import('./icloud-adapter.js');
            const localDir = process.env['SCI_LOCAL_DIR'] ?? DEFAULT_LOCAL_DIR;
            const adapter = new iCloudAdapter(localDir, process.env['SCI_ICLOUD_PATH']);
            await adapter.connect();
            return adapter;
        }
        case 'sqlite': {
            // Pure-local SQLite + HNSW — same on-disk store the sci agent uses, with
            // NO sync layer (no iCloud copy, no control-plane push). Point
            // SCI_LOCAL_DIR at ~/.sci/memory to share the agent's store.
            const { SqliteAdapter } = await import('./sqlite-adapter.js');
            const localDir = process.env['SCI_LOCAL_DIR']
                ?? join(homedir(), '.sci', 'memory');
            const adapter = new SqliteAdapter(localDir);
            await adapter.connect();
            return adapter;
        }
        default:
            throw new Error(`Unknown SCI_STORAGE_BACKEND: "${backend}". Valid: local, dropbox, s3, icloud, sqlite`);
    }
}
function requireEnv(name) {
    const val = process.env[name];
    if (!val)
        throw new Error(`Missing required env var for storage backend: ${name}`);
    return val;
}
//# sourceMappingURL=index.js.map