---
layout: ../layouts/Base.astro
title: How it works
description: The Sci architecture — a local proxy round-trip plus a memory agent exposed to Claude Code over MCP.
---

# How it works

```
┌─────────────┐    HTTPS_PROXY=:3001    ┌──────────────┐   anonymized    ┌───────────┐
│ Claude Code │ ──────────────────────► │  sci-helper  │ ──────────────► │ Anthropic │
│  (your Mac) │ ◄────────────────────── │   (:3001)    │ ◄────────────── │           │
└─────────────┘    deanonymized reply   └──────────────┘   real reply    └───────────┘
       │                                        │
       │ MCP (memory tools)                     │ local store
       ▼                                        ▼
┌─────────────┐                         ┌──────────────┐
│ com.sci.    │                         │  SQLite +    │
│ agent :8080 │                         │  local embed │
└─────────────┘                         └──────────────┘
```

## The pieces

- **`dev.sci.helper`** (port 3001) — the Rust proxy. Claude Code's `HTTPS_PROXY` points here. It does the anonymize → forward → deanonymize round trip. A local CA certificate (trusted in your Keychain) lets it terminate TLS.
- **`com.sci.agent`** (port 8080) — the Node agent backing the memory store and the MCP tools.
- Both run as **launchd** services with `KeepAlive`, so they survive logout and restart.
- **Memory** is stored in local **SQLite** with locally-computed embeddings. Nothing about your memory is sent to an external embedding API.
- **MCP integration** — the installer registers `sci` in `~/.claude.json`, exposing `memory_recall`, `memory_store`, `memory_identity`, and `memory_status` to Claude Code.

---

For the full technical reference — anonymization pipeline, retrieval, storage adapters — see the [technical docs](https://sovereign-cognitive-identity.github.io/sci/).
