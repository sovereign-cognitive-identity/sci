# Storage Adapters

The `StorageAdapter` interface abstracts all data operations. Callers never touch raw SQL.

## Interface

Every adapter implements the same surface:

```typescript
interface StorageAdapter {
  // Lifecycle
  connect(): Promise<void>
  disconnect(): Promise<void>
  readonly backend: string

  // Profiles
  getProfiles(): Promise<Profile[]>
  getProfile(name: string): Promise<Profile | null>
  createProfile(name: string): Promise<Profile>

  // Memory operations
  storeEpisodic(input): Promise<{ id: string }>
  storeSemantic(input): Promise<{ id: string }>
  reinforceSemantic(id): Promise<void>
  updateDecayScore(id, score, flagged): Promise<void>
  storeIdentityFact(input): Promise<{ id: string }>

  // Retrieval
  recall(input): Promise<RecallResult[]>
  queryIdentityFacts(options): Promise<IdentityFact[]>
  findSimilarSemanticNode(embedding, profileId, threshold): Promise<...>

  // Stats + audit
  getStats(): Promise<StorageStats>
  recordWrite(operation, payload): Promise<void>

  // Consolidation
  getEpisodicMemoriesInWindow(options): Promise<...>
  getLastConsolidationRun(): Promise<Date | null>
  recordConsolidationRun(data): Promise<void>

  // Sync (cloud backends only, no-op for LocalAdapter)
  sync(): Promise<{ uploaded: number; downloaded: number }>
}
```

## LocalAdapter (Postgres + pgvector)

The default backend. Uses two connection pools:
- `db_reader` (sci_reader role) — all reads
- `db_writer` (sci_writer role) — all writes via Augmentor

Full hybrid retrieval: dense (pgvector HNSW) + tsvector full-text + RRF.

## CloudAdapter (SQLite + hnswlib)

Base class for all cloud backends. Stores everything in two files:

| File | Contents |
|---|---|
| `sci.db` | SQLite database — all memories, profiles, identity facts |
| `sci.idx` | hnswlib HNSW index — vector embeddings for recall |

The concrete subclasses (`DropboxAdapter`, `S3Adapter`, `iCloudAdapter`) only implement two methods:
- `_downloadIfNeeded()` — pull from cloud if remote is newer
- `_sync()` — push local files to cloud

On `connect()`, the cloud adapter:
1. Calls `_downloadIfNeeded()` to pull any updates
2. Opens the SQLite DB
3. Loads or creates the hnswlib index
4. Initializes the schema if this is a fresh database

On `disconnect()`, it flushes the hnswlib index to disk and calls `_sync()`.

## Vector map

Because hnswlib uses integer indices (not UUIDs), a `vector_map` table in SQLite maps integer → `(memory_id, memory_type)`:

```sql
CREATE TABLE vector_map (
  idx         INTEGER PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  memory_type TEXT NOT NULL
);
```

This is loaded into memory on connect and updated in-process. It's rebuilt from the SQLite DB if the index file is missing.

## Sync strategy

Cloud backends use a simple "last-write-wins" sync:
1. On connect: if remote `sci.db` has a newer mtime than local, download it
2. On disconnect: always upload local files

This is safe for single-user use (one machine writing at a time). Multi-device conflict resolution is a future concern.

## Selecting a backend

```bash
# At MCP server startup or CLI invocation
SCI_STORAGE_BACKEND=dropbox \
SCI_DROPBOX_TOKEN=... \
node packages/mcp/dist/index.js
```

The factory in `packages/core/src/storage/index.ts` reads `SCI_STORAGE_BACKEND` and instantiates the right adapter.

## Adding a new backend

Subclass `CloudAdapter` and implement two methods:

```typescript
export class GDriveAdapter extends CloudAdapter {
  readonly backend = 'gdrive'

  protected async _downloadIfNeeded(): Promise<void> {
    // Download sci.db and sci.idx from Google Drive if newer
  }

  protected async _sync(): Promise<{ uploaded: number; downloaded: number }> {
    // Upload this.dbPath and this.idxPath to Google Drive
    return { uploaded: 2, downloaded: 0 }
  }
}
```

Then add it to the factory in `packages/core/src/storage/index.ts`.
