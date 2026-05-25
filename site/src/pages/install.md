---
layout: ../layouts/Base.astro
title: Install
description: Install the Sci alpha on Apple Silicon macOS — one command, then verify with sci status and sci verify.
---

# Install the alpha

> Alpha v0.1.0 · macOS · Apple Silicon · Invite only

## Prerequisites

- macOS 13 or later, **Apple Silicon (M1 or newer)** — Intel Macs are not supported in the alpha
- Claude Code installed and working (`claude --version` should succeed)
- An Anthropic API key (`sk-ant-...`)

Storage is local SQLite — **no Docker or Postgres required**.

## Install

Run the installer in your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/sovereign-cognitive-identity/sci/main/scripts/install.sh | bash
```

It asks for `sudo` twice (to trust the CA certificate and install the launchd services) and prompts for your Anthropic API key. The installer downloads the binary, trusts a local CA, registers the `sci` MCP server with Claude Code, configures the proxy, and starts the background services.

## Verify

Open a **new** terminal, then:

```bash
sci status     # should print  ok: true
sci verify     # sends a real request and proves your name didn't leak
```

If `sci verify` reports **PASS**, you're live. Start Claude Code normally — Sci works in the background.

## Next

- [Using Sci](/using-sci) — day-to-day usage
- [What to test](/what-to-test) — what we'd love your feedback on
- [Full install guide & troubleshooting](https://sovereign-cognitive-identity.github.io/sci/guide/alpha-install) (technical docs)
