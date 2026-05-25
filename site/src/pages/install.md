---
layout: ../layouts/Base.astro
title: Install
description: Install the Sci alpha on Apple Silicon macOS — one command, then verify with sci status and sci verify.
---

# Install the alpha

> Alpha v0.1.0 · macOS · Apple Silicon · Invite only

## Prerequisites

- macOS 13 or later, **Apple Silicon (M1 or newer)** — Intel Macs are not supported in the alpha
- Claude Code installed and signed in (`claude --version` should succeed)

That's it. **No API key required** — Sci uses the Claude Code login you already have, including Claude Pro or Max via OAuth. Storage is local SQLite, so there's **no Docker or Postgres** to install either.

## Install

Run the installer in your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/sovereign-cognitive-identity/sci/main/scripts/install.sh | bash
```

It asks for `sudo` twice — to trust the local CA certificate and to install the launchd services. The installer downloads the binary, trusts the CA, registers the `sci` MCP server with Claude Code, configures the proxy, and starts the background services.

> If the installer offers to store an Anthropic API key, you can **skip it** (just press Enter) — your existing Claude Code login already works through the proxy. A key is only needed if you prefer key-based auth over OAuth.

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
