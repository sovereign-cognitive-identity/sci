---
layout: home

hero:
  name: Sci
  text: Sovereign Cognitive Identity
  tagline: A proxy that sits between you and every AI system you use. Protects your privacy, preserves your context, optimizes your costs.
  actions:
    - theme: brand
      text: Quick Start
      link: /guide/quick-start
    - theme: alt
      text: What is Sci?
      link: /guide/what-is-sci
    - theme: alt
      text: GitHub
      link: https://github.com/sovereign-cognitive-identity/sci

features:
  - icon: 🧠
    title: Memory
    details: Unified context that travels across Claude, Cursor, Copilot, and any MCP-compatible agent. One store, all tools.

  - icon: 🔒
    title: Privacy
    details: Anonymizes your identity before any cloud AI processing. Providers see coherent context, never your real name. Inspect the outbound request yourself.

  - icon: ⚡
    title: Routing
    details: Routes each query to the best/cheapest model automatically. You pay one subscription and get optimized results.

  - icon: 💳
    title: Just works
    details: Like Visa for payments — invisible infrastructure that works everywhere without friction. Set it and forget it.
---

## The honest claims

Every one of these is verifiable. We don't ask you to trust us.

| Claim | How to verify |
|---|---|
| AI providers never see your real name | Run `node demo/privacy-demo.mjs` — inspect the outbound text yourself |
| Your data lives in your Dropbox | Check your Dropbox — it's literally there |
| We can't read your vault | We don't have the credentials |
| You can run the whole thing yourself | `docker compose up` — AGPL-3.0, all source available |

## Quick install

```bash
git clone https://github.com/sovereign-cognitive-identity/sci
cd sci && npm install
docker compose up -d
npm run build
sci setup
```

Five commands. Under 5 minutes. Then restart Claude Code and start using `memory_recall`.
