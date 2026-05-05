# Storage Backends

Sci stores your data where you control it. Choose your backend at startup.

## Backends

| Backend | Set with | Where data lives |
|---|---|---|
| `local` | default | Postgres on your machine (Docker) |
| `dropbox` | `SCI_STORAGE_BACKEND=dropbox` | `/CognitiveOS/` in your Dropbox |
| `s3` | `SCI_STORAGE_BACKEND=s3` | `s3://your-bucket/CognitiveOS/` |
| `icloud` | `SCI_STORAGE_BACKEND=icloud` | `~/Library/Mobile Documents/` (macOS) |

## Local (default)

Postgres + pgvector. The most capable backend — full SQL queries, native full-text search, HNSW vector index. Requires Docker.

```bash
docker compose up -d
```

## Cloud backends

The cloud backends use two files:
- `sci.db` — SQLite database containing all memories, profiles, and identity facts
- `sci.idx` — hnswlib HNSW index for vector search

These files sync to your chosen cloud on `disconnect()` and are downloaded on `connect()` if the remote is newer.

**The sovereignty claim is literal:** your memory store is two files in a location you control. Download them and you have everything. We never have credentials to your storage.

### Dropbox

```bash
SCI_STORAGE_BACKEND=dropbox \
SCI_DROPBOX_TOKEN=your-access-token \
node packages/mcp/dist/index.js
```

Get a Dropbox access token from [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps). Data appears in `/CognitiveOS/` in your Dropbox.

### S3 (AWS, Cloudflare R2, MinIO, Backblaze B2)

```bash
SCI_STORAGE_BACKEND=s3 \
SCI_S3_BUCKET=your-bucket \
SCI_S3_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
node packages/mcp/dist/index.js
```

For Cloudflare R2 or other S3-compatible endpoints, add `SCI_S3_ENDPOINT=https://your-endpoint`.

### iCloud (macOS only)

```bash
SCI_STORAGE_BACKEND=icloud \
node packages/mcp/dist/index.js
```

Files are written to `~/Library/Mobile Documents/iCloud~sci~identity/Documents/` and synced by the OS automatically. No credentials required. Works with Syncthing if you prefer P2P sync instead.

## Backup and restore

Regardless of backend, you can always take a portable JSON backup:

```bash
sci backup --out ./sci-backup-$(date +%Y%m%d).json
sci restore ./sci-backup-20260505.json
```

The backup includes all tables in dependency order. Restore uses `ON CONFLICT DO NOTHING` — it's safe to run on a non-empty database.
