# Environment Variables

## Required

| Variable | Description |
|---|---|
| `SCI_DB_READER_URL` | Postgres connection string for the reader role |
| `SCI_DB_WRITER_URL` | Postgres connection string for the writer role |

Default values (local dev): `postgresql://sci_reader:sci_reader_local@localhost:5432/sci`

## Storage

| Variable | Default | Description |
|---|---|---|
| `SCI_STORAGE_BACKEND` | `local` | `local`, `dropbox`, `s3`, `icloud` |
| `SCI_LOCAL_DIR` | `~/.sci/data` | Local cache dir for cloud backends |
| `SCI_DROPBOX_TOKEN` | — | Dropbox access token (dropbox backend) |
| `SCI_S3_BUCKET` | — | S3 bucket name (s3 backend) |
| `SCI_S3_REGION` | `us-east-1` | AWS region (s3 backend) |
| `SCI_S3_ENDPOINT` | — | Custom endpoint for R2/MinIO (s3 backend) |
| `SCI_ICLOUD_PATH` | `~/Library/Mobile Documents/iCloud~sci~identity/Documents` | iCloud path override |

## Embeddings

| Variable | Default | Description |
|---|---|---|
| `SCI_EMBED_MODEL` | `BAAI/bge-base-en-v1.5` | Embedding model identifier |

## Auth

| Variable | Default | Description |
|---|---|---|
| `SCI_AGENT_TOKEN` | — | Agent token for the MCP server |
| `SCI_REQUIRE_AUTH` | `false` | Set to `true` to enforce token validation |

## Consolidation

| Variable | Default | Description |
|---|---|---|
| `SCI_OPENROUTER_KEY` | — | OpenRouter API key (required for consolidation and identity extraction) |
| `SCI_CONSOLIDATION_MODEL` | `google/gemini-2.5-flash-lite` | Model for nightly consolidation |
| `SCI_CONSOLIDATION_WINDOW_DAYS` | `1` | Days of history to process per run |
| `SCI_EXTRACT_MODEL` | `google/gemini-flash-1.5` | Model for identity extraction |

## Output

| Variable | Default | Description |
|---|---|---|
| `SCI_VAULT_PATH` | `~/Vault` | Obsidian vault path for digest export |
