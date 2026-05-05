# Dependency Licenses

All production dependencies are MIT or Apache 2.0 — both compatible with AGPL-3.0.

| Package | License | Used for |
|---|---|---|
| `@modelcontextprotocol/sdk` | MIT | MCP server transport |
| `pg` | MIT | Postgres client |
| `fastembed` | MIT | Local embeddings (BGE-base-en) |
| `compromise` | MIT | NER for anonymization |
| `better-sqlite3` | MIT | SQLite for cloud backends |
| `hnswlib-node` | Apache-2.0 | Vector search for cloud backends |
| `@aws-sdk/client-s3` | Apache-2.0 | S3/R2 storage backend |
| `dropbox` | MIT | Dropbox storage backend |
| `commander` | MIT | CLI framework |
| `zod` | MIT | Schema validation |
| `vitepress` | MIT | Documentation site |

## AGPL compatibility

MIT and Apache 2.0 are both compatible with AGPL-3.0. You can use MIT/Apache 2.0 libraries in an AGPL project without triggering any incompatibility.

GPL-2.0-only (without the "or later" clause) would be incompatible with AGPL-3.0. None of Sci's dependencies use GPL-2.0-only.
