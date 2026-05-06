# Sci — share with a colleague

A self-contained docker-compose setup for running Sci end-to-end on someone
else's machine. They get the full inspector experience (privacy + memory),
their own OAuth token, and Sci's anonymizer in front of every request.

## What they need on their machine

- **Docker Desktop** (or Docker Engine + compose plugin)
- A web browser
- An **Anthropic Pro or Max subscription** — Sci's UI uses the user's
  subscription via OAuth, not API credits
- About **2 GB free disk space** for the build, embedding model, and Postgres
  data volume

That's it. No Node, no Postgres, no homebrew installs.

## First-time setup

```bash
git clone <this-repo> sci
cd sci

# 1. Build the images (~3–5 min the first time)
docker compose build

# 2. Authenticate with Anthropic — opens browser-based OAuth login
docker compose --profile setup run --rm sci-auth
#    → terminal prints a URL
#    → open it in your browser, log in to Anthropic
#    → browser redirects to localhost:53000/callback
#    → terminal prints "✓ login complete"

# 3. Start the stack
docker compose up -d

# 4. Open the chat UI
open http://localhost:3002          # macOS
xdg-open http://localhost:3002      # linux
start http://localhost:3002         # windows
```

That's the whole flow. Send a message in the browser; the proxy anonymizes
outbound, Anthropic answers (billed against your subscription), the response
is deanonymized on the way back. Open the 🔒 / 🧠 / 🔓 chips below each
turn to see exactly what Sci did.

## What's running

```
┌── docker compose ─────────────────────────────────────────────┐
│                                                                │
│  postgres (pgvector/pg16)         ← memory store               │
│       ↑                                                        │
│  sci-proxy   :3001                ← anonymize + memory inject  │
│       ↑                                                        │
│  sci-ui      :3002 → host         ← chat UI + SSE relay        │
│                                                                │
│  sci-auth    :53000 → host        (one-shot, profile=setup)    │
│  sci-consolidate                  (one-shot, profile=consolidate) │
└────────────────────────────────────────────────────────────────┘
```

Volumes:

| Volume | Holds | Notes |
|---|---|---|
| `sci_data` | Postgres data | Conversations, memories, embeddings |
| `sci_config` | `~/.sci/` | OAuth token (mode 0600 inside the volume) |
| `sci_fastembed_cache` | BGE-base-en-v1.5 model | ~125 MB, downloaded on first proxy start |

## Day-to-day commands

```bash
docker compose up -d              # start everything
docker compose logs -f sci-proxy  # tail proxy logs (masking + memory inject)
docker compose logs -f sci-ui     # tail UI server logs
docker compose down               # stop without deleting data

docker compose down -v            # ⚠ stops AND deletes all data + token
```

## Promoting episodic chats into searchable facts

After you've had some chats with Sci, run the consolidator to extract
durable facts (employer, education, preferences, etc.) into the semantic
layer so future recall surfaces them:

```bash
docker compose --profile consolidate run --rm sci-consolidate
# or with --dry to preview without writing:
docker compose --profile consolidate run --rm sci-consolidate --dry
```

This calls Anthropic via your OAuth token to do the extraction (a few cents
of inference for typical chat history). Without it, recall has to rely on
matching against full chat turns — useful, but specific questions like
"where did I attend college?" work much better once consolidation has run.

## Re-authenticating

OAuth tokens refresh automatically. If the refresh token expires (or if you
get a 401 in the UI) re-run setup:

```bash
docker compose --profile setup run --rm sci-auth
```

## Privacy posture you're actually getting

- **Anthropic** sees the masked content (`[PERSON_1]`, `[EMAIL_1]`, …) — never
  the real values
- **Postgres** stores the real values (so recall works) — locally, in your
  Docker volume
- **OAuth token** lives in the `sci_config` volume — your machine, never sent
  anywhere except Anthropic's auth + token endpoints

You can audit every request with the inspector: each turn shows what was
masked outbound and what was unmasked on the way back.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `Authorization failed — Invalid request format` during login | Hard-refresh the OAuth URL in a browser tab where you're already signed into Anthropic. The auth server requires a logged-in session. |
| `proxy unreachable` in UI | `docker compose logs sci-proxy` — usually Postgres wasn't ready, restart with `docker compose up -d` |
| Empty response / model says "I don't know" | Open the 🧠 chip — if recall returned nothing useful, run the consolidator |
| `port 3002 already in use` | Something else is on 3002. Either stop it or change the host port in `docker-compose.yml`'s `sci-ui` `ports:` block |
| Slow first message | First request loads the BGE embedding model (~125 MB). Subsequent requests are fast. |

## What's not in this build

- Multi-user / multi-profile (single `'work'` profile)
- File uploads, vision, artifacts (Tier 3 features)
- Cloud sync of memory (use the Dropbox/S3/iCloud adapters in `@sci/core` if you want this — not wired through compose yet)
- Auto-update mechanism — pull the repo and rebuild when there are new commits
