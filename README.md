# Sci — Sovereign Cognitive Interface

A local HTTPS proxy that sits between you and every AI provider, anonymizing your identity before requests leave your machine and injecting memory context from a local SQLite store.

**The privacy guarantee:** your real name, email, and other PII are substituted with placeholder tokens before any request reaches the cloud — run `sci-helper --verify` to see exactly what left your machine.

---

## What it does

| Capability | Description |
|---|---|
| **Memory** | Injects relevant context from a local SQLite store into every request, across Claude Code, curl, Python SDKs, or any tool that respects `HTTPS_PROXY` |
| **Privacy** | Named-entity recognition replaces your name, email, URLs, and other identifiers with stable session tokens before the request leaves localhost |
| **Routing** | Forwards requests to the correct upstream provider (Anthropic, OpenAI, etc.) using your own API keys, stored locally in `~/.sci/credentials.env` |

**What it is not:** a chatbot, a VPN, a cloud service, or a data broker.

---

## Quick start

```bash
brew tap cognitive-os/tap
brew install sci
sci-helper --setup        # credentials, shell config, launchd
sci-helper --trust-ca     # add CA to macOS keychain
brew services start sci   # start on login
```

After `--setup` completes, your shell config will contain:

```bash
export HTTPS_PROXY=http://127.0.0.1:3001
export ANTHROPIC_BASE_URL=http://127.0.0.1:3001
```

Any process that inherits these variables routes through Sci automatically.

---

## Verify the privacy guarantee

`sci-helper --verify` makes a real request through the proxy and shows you three things: the message you sent, the anonymized version that reached Anthropic, and the deanonymized response you received back.

```
$ sci-helper --verify

Sci privacy verification
────────────────────────────────────────────────────────────────

  What you sent:
    "My name is Casey Zandbergen and my email is casey@example.com.
     What should I call my next project?"

  What reached Anthropic:
    "My name is [PERSON_1] and my email is [EMAIL_1].
     What should I call my next project?"

  What you received:
    "Here are a few project name ideas for you, Casey:
     ..."

  Anonymization:
    PERSON_1  →  Casey Zandbergen
    EMAIL_1   →  casey@example.com

  Token map discarded. Nothing was written to disk.

  PASS — real name did not appear in the outbound request.

────────────────────────────────────────────────────────────────
```

The token map is held in process memory only. When the process exits, the mapping is gone. See [docs/PRIVACY.md](docs/PRIVACY.md) for the full pipeline.

---

## Connect Claude Code

Add two lines to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export HTTPS_PROXY=http://127.0.0.1:3001
export ANTHROPIC_BASE_URL=http://127.0.0.1:3001
```

`--setup` writes these automatically. To apply them to a running terminal:

```bash
source ~/.zshrc
```

Claude Code reads `ANTHROPIC_BASE_URL` before falling back to the Anthropic default. With both variables set, every Claude Code request passes through the proxy whether it uses the env var directly or respects `HTTPS_PROXY`.

---

## Storage

Sci stores all data locally. Four backends are available, selected at startup via `SCI_STORAGE_BACKEND`:

**Local (default)** — SQLite at `~/.sci/memory/sci.db` with a local HNSW index. No external dependencies. The embedder model is cached at `~/.sci/models/bge-base-en-v1.5/` after the first run (~110 MB download from HuggingFace, one time only).

**Dropbox** — SQLite + HNSW index synced to `/CognitiveOS/` in your Dropbox. Set `SCI_STORAGE_BACKEND=dropbox` and `SCI_DROPBOX_TOKEN`. Sci never holds your Dropbox credentials — you provide an app token scoped to that folder.

**S3** — any S3-compatible bucket (AWS, Cloudflare R2, MinIO, Backblaze B2). Set `SCI_STORAGE_BACKEND=s3`, `SCI_S3_BUCKET`, and `SCI_S3_REGION`. The two-file store (`sci.db` + `sci.idx`) is synced on connect and on each adapter sync.

**iCloud Drive** — macOS only. Set `SCI_STORAGE_BACKEND=icloud`. The files land in your iCloud Drive container and sync automatically via the OS; Sci does not call any iCloud API.

The cloud backends all use the same two-file layout: `sci.db` (all relational data) and `sci.idx` (vector embeddings). Download both files and you have everything.

---

## CLI reference

| Command | Description |
|---|---|
| `sci-helper --setup` | First-run wizard: writes `~/.sci/credentials.env`, adds shell exports, installs launchd plist |
| `sci-helper --trust-ca` | Adds `~/.sci/ca.crt` to the macOS system keychain so curl and browsers trust it |
| `sci-helper --verify` | Makes a live request through the proxy and prints the before/after comparison |
| `sci-helper --proxy <port>` | Start the HTTPS proxy on the given port (default: `SCI_HELPER_PROXY_PORT`) |
| `sci-helper --admin <port>` | Start the admin HTTP API on the given port (default: 3002) |
| `sci-helper --help` | Show usage |

**Environment variables:**

| Variable | Description |
|---|---|
| `SCI_CONFIG_DIR` | Override the default `~/.sci` config directory |
| `SCI_HELPER_SOCKET` | Override the Unix socket path |
| `SCI_HELPER_PROXY_PORT` | Proxy port (alternative to `--proxy`) |
| `SCI_HELPER_ADMIN_PORT` | Admin API port (alternative to `--admin`, default 3002) |
| `SCI_STORAGE_BACKEND` | `local` (default), `dropbox`, `s3`, `icloud` |
| `SCI_MODEL_CACHE_DIR` | Override the embedding model cache directory |
| `RUST_LOG` | Logging filter, e.g. `debug`, `info` |

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a full technical description of the three-layer architecture, the anonymization pipeline, hybrid retrieval (dense + full-text with RRF), the auth model, and the nightly consolidation process.

---

## License

Sci is dual-licensed under **[AGPL-3.0](LICENSE)** for open source use, self-hosting, and personal use, and a **[Commercial License](COMMERCIAL_LICENSE.md)** for managed service operators and proprietary embedding. If you self-host Sci for your own use, AGPL-3.0 applies and you owe nothing. If you want to offer Sci as a service to others without open-sourcing your stack, contact casey.zandbergen@gmail.com.
