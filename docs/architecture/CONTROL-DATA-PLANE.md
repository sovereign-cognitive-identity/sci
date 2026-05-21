# Sci — Control Plane / Data Plane Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CONTROL PLANE                                │
│                (hosted: control.sci.sh  OR  self-hosted docker run) │
│                                                                     │
│   ┌─────────────┐   ┌─────────────┐   ┌──────────────────────┐    │
│   │   Accounts  │   │   Devices   │   │  Memory Store        │    │
│   │  + Sessions │   │  + Tokens   │   │  (encrypted blobs)   │    │
│   └─────────────┘   └─────────────┘   └──────────────────────┘    │
│                                                                     │
│   ┌─────────────┐   ┌─────────────┐   ┌──────────────────────┐    │
│   │  CA cert    │   │  Profiles   │   │   Audit Log          │    │
│   │  + key      │   │  (work etc) │   │                      │    │
│   └─────────────┘   └─────────────┘   └──────────────────────┘    │
│                                                                     │
│   REST API :3003  —  all device ↔ control traffic over HTTPS       │
└─────────────────────────────────────────────────────────────────────┘
          ↑                    ↑                     ↑
          │ register           │ push/pull           │ pull CA
          │ device             │ encrypted           │ on enroll
          │                    │ memory blobs        │
┌─────────┴───────┐   ┌────────┴────────┐   ┌───────┴──────────┐
│   MacBook Pro   │   │   ollama-01     │   │  (future device) │
│                 │   │                 │   │                  │
│  DATA PLANE     │   │  DATA PLANE     │   │  DATA PLANE      │
└─────────────────┘   └─────────────────┘   └──────────────────┘
```

---

## Data Plane (per device)

```
                         ┌────────────────────────────────────────┐
                         │           sci agent (local)            │
                         │                                        │
  Any AI tool            │  ┌──────────────────────────────────┐  │
  (Claude Code,          │  │      HTTPS CONNECT proxy         │  │
   curl, Python SDK)     │  │         :3001                    │  │
         │               │  │                                  │  │
         │ HTTPS_PROXY   │  │  intercepts: api.anthropic.com   │  │
         └──────────────▶│  │             api.openai.com       │  │
                         │  │             openrouter.ai        │  │
                         │  │                                  │  │
                         │  │  passes through: everything else │  │
                         │  └──────────┬───────────────────────┘  │
                         │             │                          │
                         │  ┌──────────▼───────────────────────┐  │
                         │  │      TLS MITM engine             │  │
                         │  │                                  │  │
                         │  │  1. Anonymize  (PII → tokens)    │  │
                         │  │  2. Inject memory context        │  │
                         │  │  3. Forward to upstream          │  │
                         │  │  4. Deanonymize response         │  │
                         │  └──────────┬───────────────────────┘  │
                         │             │                          │
                         │  ┌──────────▼───────────────────────┐  │
                         │  │   Local memory store             │  │
                         │  │                                  │  │
                         │  │   SQLite  ←→  HNSW index         │  │
                         │  │   BGE-base-en-v1.5 (on-device)   │  │
                         │  │                                  │  │
                         │  │   ~/.sci/memory/sci.db           │  │
                         │  │   ~/.sci/memory/sci.idx          │  │
                         │  └──────────────────────────────────┘  │
                         │                                        │
                         │  MCP server (stdio)                    │
                         │  ← memory_recall / memory_store        │
                         │     memory_identity / memory_status    │
                         └────────────────────────────────────────┘
```

---

## New Device Enrollment Flow

```
User                    sci agent              Control Plane
  │                         │                       │
  ├─ sci --setup ──────────▶│                       │
  │                         │── open browser ──────▶│ /login
  │◀─────────────── browser opens ──────────────────┤
  │── logs in ─────────────────────────────────────▶│
  │                         │◀── session token ──────┤
  │                         │                       │
  │                         │── POST /api/devices ──▶│
  │                         │◀── bearer token ───────┤
  │                         │                       │
  │                         │── GET /api/ca/cert ───▶│
  │                         │── GET /api/ca/key ────▶│
  │                         │◀── ca.crt + ca.key ────┤
  │                         │                       │
  │                         │── GET /api/profiles ──▶│
  │                         │◀── [work, personal] ───┤
  │                         │                       │
  │                         │── GET /api/memories ──▶│  (pull existing
  │                         │   ?since=0             │   memories)
  │                         │◀── encrypted blobs ────┤
  │                         │                       │
  │                         │  decrypt + index       │
  │                         │  locally               │
  │                         │                       │
  │                         │  write ~/.zshrc        │
  │                         │  write launchd plist   │
  │                         │  write ~/.claude.json  │  (MCP registration)
  │◀─ ✓ Ready ─────────────┤                       │
```

---

## Memory Write Flow (request interception)

```
Claude Code sends: "My name is Casey, summarize this..."

sci agent (data plane)
  │
  ├─ Anonymize: "My name is [PERSON_1], summarize this..."
  │
  ├─ Embed request with BGE (on-device, no network)
  │
  ├─ Recall similar memories from local HNSW
  │   └─ inject as system context
  │
  ├─ Forward anonymized + context-injected request to Anthropic
  │
  ├─ Deanonymize response
  │
  ├─ Store new episodic memory locally (SQLite + HNSW)
  │
  └─ Push encrypted blob to control plane (async, non-blocking)
       └─ if offline: buffer to ~/.sci/pending-sync.ndjson
```

---

## Hosted vs Self-Hosted

```
HOSTED (default)                    SELF-HOSTED

brew install sci                    brew install sci
sci --setup                         docker run -p 3003:3003 \
                                      -v sci-data:/data \
  ↓                                   ghcr.io/sci/sci-control
  
Opens control.sci.sh/login          ┌─ Sci Control Plane ──────┐
                                    │ First run:               │
                                    │ http://localhost:3003/   │
                                    │   setup?token=abc123     │
                                    └──────────────────────────┘

                                    sci --setup \
                                      --control-plane \
                                      http://192.168.2.21:3003

Same agent binary.
Same data plane behaviour.
Only the control plane URL differs.
```

---

## What the control plane NEVER sees

- Prompt content (anonymized before leaving the device)
- Vector embeddings (search runs locally)
- Plaintext memory content (encrypted on-device before upload)
- API keys (stored in ~/.sci/credentials.env, never synced)

The control plane sees: encrypted blobs, device metadata, profile names, timestamps.
