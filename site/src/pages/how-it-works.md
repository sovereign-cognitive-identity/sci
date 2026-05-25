---
layout: ../layouts/Base.astro
title: How it works
description: The Sci architecture — a transparent local proxy that anonymizes requests in-flight, plus a memory agent exposed to Claude Code over MCP. Nothing leaves your machine but the anonymized request.
---

# How it works

Sci installs two small background services and wires Claude Code to route through them. Nothing about the setup depends on a remote server.

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

## The request lifecycle

1. **Intercept.** During install, Claude Code's `HTTPS_PROXY` is set to `http://127.0.0.1:3001`. Every call it makes to `api.anthropic.com` is routed to the local proxy first.
2. **Terminate TLS locally.** `sci-helper` holds a CA certificate that you trust in your macOS Keychain during install. That lets it read the request on your machine — and *only* on your machine — to do its work.
3. **Anonymize.** It scans the outbound request for PII and substitutes placeholder tokens, recording the mapping in memory locally.
4. **Forward untouched auth.** Whatever credentials Claude Code attached — an OAuth bearer token from your Claude subscription, or an `x-api-key` — are passed straight through. Sci doesn't store or inspect them.
5. **Deanonymize.** Anthropic streams its reply back through `sci-helper`, which restores your real values before Claude Code renders the response. The round trip is invisible to you.

## The pieces

- **`dev.sci.helper`** (port 3001) — the Rust proxy that does the anonymize → forward → deanonymize round trip. Written in Rust for a small, fast, always-on footprint.
- **`com.sci.agent`** (port 8080) — the Node agent that backs the memory store and serves the MCP tools to Claude Code.
- **launchd services** — both run with `KeepAlive`, so they start at login and restart automatically if they stop.
- **Local store** — memory lives in **SQLite**, with embeddings computed **on-device**. No memory text is sent to an external embedding API.
- **MCP registration** — the installer adds `sci` to `~/.claude.json`, exposing `memory_recall`, `memory_store`, `memory_identity`, and `memory_status`.

## What leaves your machine — and what doesn't

| Leaves your machine | Stays local |
|---|---|
| The anonymized request to Anthropic (tokens, not PII) | Your name, email, and the token↔value map |
| Your existing Claude Code auth, forwarded unchanged | Your memory store (SQLite) |
| | Embedding computation |
| | The CA private key |

## The trust model

You're trusting a local CA certificate so the proxy can see your own traffic on your own machine — the same mechanism corporate proxies and debugging tools like mitmproxy use, scoped to you. The certificate's private key never leaves `~/.sci`. You can inspect, distrust, or remove it from Keychain Access at any time.

---

For the deeper technical reference — the anonymization pipeline, hybrid retrieval, and storage adapters — see the [technical docs](https://sovereign-cognitive-identity.github.io/sci/).
