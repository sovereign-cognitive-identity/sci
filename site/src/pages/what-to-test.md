---
layout: ../layouts/Base.astro
title: What to test
description: The six things we'd love alpha testers to exercise — install, privacy, memory, import, daily friction, and resilience.
---

# What to test

Work through these in order. For each, note: did it work, how long it took, and anything surprising.

## 1. Install (target: under 10 minutes, cold)

- Does the one-liner complete without intervention beyond the two `sudo` prompts? (The API-key prompt is optional — skip it and use your Claude Code login.)
- After a new terminal, does `sci status` print `ok: true`?
- **Report:** total time from paste to green, and any step that needed guessing.

## 2. Privacy guarantee (the core promise)

- Run `sci verify`. Does it PASS?
- In a real session, mention your name, email, and a fake secret like `AKIA...`. Check `~/Library/Logs/sci-helper.log` — did the real values get tokenized before leaving?
- **Try to break it:** unusual name spellings, your name mid-word, non-English text, your email in a code block.
- **Report:** anything that leaked, or anything tokenized that shouldn't have been.

## 3. Memory across sessions

- Session A (project X): "Remember that we chose SQLite over Postgres for the alpha."
- Quit. Open Session B in a *different* directory: "What did we decide about the database?"
- **Report:** did B recall it? Was it relevant and correctly de-tokenized?

## 4. Seeding from history (optional)

- Export your Claude history, then `sci import --claude ~/Downloads/conversations.json`.
- **Report:** did `sci status` counts jump? Any import errors?

## 5. Daily-driver friction

- Use Claude Code normally for a few real tasks with Sci running.
- Do your other tools still work with the proxy active — `brew`, `git`, `npm`, `curl`?
- **Report:** anything the proxy broke, slowed, or interfered with.

## 6. Resilience

- Restart your Mac. Do the services come back automatically (`sci status` still green)?
- If you use an API key, rotate it with `sci --setup` — does the next request pick it up? (On OAuth, confirm a re-login is respected.)
- **Report:** anything that needed a manual kick to recover.

---

## Known issues (please don't file duplicates)

- **Claude Code only.** The alpha supports Claude Code on macOS. Claude Desktop, Cursor, and the web app aren't supported yet — broader agent and provider coverage is on the roadmap.
- **Intel Macs are not supported** in this alpha — Apple Silicon only.
- **First request after install can hang 30–120s** while the local embedding model downloads (~110 MB). Expected once.
- **No auto-update.** New versions require re-running the installer.
- **Anthropic only.** Requests to other providers bypass the proxy and are not anonymized.
- **No GUI** — everything is terminal + Claude Code.

## How to report

Include `sci status` output and recent `~/Library/Logs/sci-helper.log` lines:

- [GitHub Issues](https://github.com/sovereign-cognitive-identity/sci/issues) (preferred)
- Email: casey.zandbergen@gmail.com
