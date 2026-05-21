/**
 * StorageAdapter — abstract interface for all Sci storage backends.
 *
 * Implementations:
 *   LocalAdapter    → Postgres + pgvector  (local / self-hosted)
 *   DropboxAdapter  → SQLite + hnswlib, synced to Dropbox
 *   S3Adapter       → SQLite + hnswlib, synced to S3
 *   iCloudAdapter   → SQLite + hnswlib, written to ~/Library/Mobile Documents
 *
 * The interface is intentionally high-level — adapters handle their own
 * connection pooling, indexing, and sync. Callers never touch raw SQL.
 */
export {};
//# sourceMappingURL=interface.js.map