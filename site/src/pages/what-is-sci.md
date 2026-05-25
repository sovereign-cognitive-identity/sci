---
layout: ../layouts/Base.astro
title: What is Sci?
description: Sci is a sovereign cognitive identity layer — a local privacy proxy and persistent memory for Claude Code, with no credentials handed over and no data leaving your machine.
---

# What is Sci?

Sci is a **sovereign cognitive identity layer** for the AI tools you already use. It's the first product from DancingBits, and the alpha targets one tool deeply: Claude Code.

It does two things that normally pull in opposite directions — it makes the model know *less* about you, and *more* about your work.

## The problem it solves

Coding assistants are remarkable, but using one means narrating your life to a remote model: your name in a commit, a client's domain in a stack trace, an API token you pasted by accident. That text leaves your machine, travels networks you don't control, and may be retained or used to train. Meanwhile the *useful* context — the decisions you made, the conventions of your project, the things you explained yesterday — evaporates the moment the session closes.

Sci splits those two flows apart. The identifying details get stripped out before they leave. The working context gets captured and carried forward.

## 1. Privacy proxy

Every request from Claude Code passes through a local proxy before it reaches Anthropic. Sci detects your real identifiers — name, email, and other PII — and replaces them with **stable placeholder tokens** (`[PERSON_1]`, `[EMAIL_1]`). "Stable" matters: the same person maps to the same token every time, so the model can still reason about "the user" coherently — it just never learns the user is you. When the reply returns, Sci swaps the tokens back. You read a normal conversation; Anthropic only ever saw the tokens.

## 2. Persistent memory

Sci runs a local memory store and exposes it to Claude Code through four MCP tools. Claude can **recall** facts about you, your projects, and past decisions, and **store** new ones as you work. Open a fresh session in a different repo tomorrow and the relevant context is already available — you stop re-explaining who you are and what you're building.

## Sovereignty by default

The principle underneath both features is simple: **your data stays yours.**

- Memory lives in a local **SQLite** database on your machine.
- Embeddings are computed **on-device** — no text is shipped to a hosted embedding API to be indexed.
- Sci **never holds your credentials.** The proxy forwards whatever login Claude Code already uses — your OAuth session (Claude Pro or Max) or your own API key — without storing or inspecting it.
- There is no Sci account and no Sci server. Nothing about you is phoned home, because there's nowhere for it to go.

## What the alpha proves

v0.1.0 is about establishing the core pipeline end-to-end on real hardware: anonymize → forward → deanonymize, plus memory injection, working transparently inside Claude Code. Auto-update, a GUI, multi-provider routing, and cloud sync come later.

---

Ready? Head to the [install guide](/install), or look at [how it works](/how-it-works) under the hood.
