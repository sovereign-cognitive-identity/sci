---
layout: ../layouts/Base.astro
title: What is Sci?
description: Sci is a sovereign cognitive identity layer for AI tools — a privacy proxy plus persistent memory for Claude Code.
---

# What is Sci?

Sci is a **sovereign cognitive identity layer** for AI tools. In the alpha, that means two concrete things for Claude Code:

## 1. Privacy proxy

Every request from Claude Code passes through Sci before it reaches Anthropic. Sci replaces your real identifiers — name, email, and other PII — with stable placeholder tokens (`[PERSON_1]`, `[EMAIL_1]`), then swaps them back in the response. Anthropic never sees the real values; you never see the placeholders.

## 2. Persistent memory

Sci gives Claude Code an MCP server with four memory tools. Claude can recall facts about you, your projects, and past decisions, and store new ones — so context carries across sessions instead of starting cold every time.

## Sovereignty by default

The guiding principle is that your data stays yours. Memory lives on your machine in local SQLite, and embeddings are computed locally — no per-query data is sent to a third party.

---

Ready to try it? Head to the [install guide](/install), or see [how it works](/how-it-works) under the hood.
