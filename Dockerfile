# Sci — single image that runs the proxy, UI, OAuth CLI, or consolidator
# depending on the entry-point overridden in docker-compose.
#
# Multi-stage:
#   deps    — install workspace dependencies (cached when only source changes)
#   build   — compile all packages to dist/
#   runtime — slim image with only the built artefacts + runtime deps
#
# The fastembed BGE model (~125 MB) downloads on first use to
# /home/sci/.cache/fastembed — mount as a volume to persist across restarts.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app

# better-sqlite3 + onnxruntime-node (used by fastembed) need build tools at
# install time. Copying them in a single layer keeps cache invalidation tight.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/core/package.json       ./packages/core/
COPY packages/mcp/package.json        ./packages/mcp/
COPY packages/cli/package.json        ./packages/cli/
COPY packages/proxy/package.json      ./packages/proxy/
COPY packages/ui/package.json         ./packages/ui/
COPY packages/telemetry/package.json  ./packages/telemetry/

# `npm install` instead of `npm ci` so platform-specific optional deps
# (fastembed's @anush008/tokenizers-<platform>-gnu binaries, hnswlib, etc.)
# resolve against the BUILD environment's os/arch — not whatever the
# host's package-lock.json was generated against. `npm ci` strictly
# follows the lockfile and skips optional binaries that weren't selected
# when the lockfile was created, which leaves the runtime container
# crashing on `MODULE_NOT_FOUND` for the right-platform tokenizer.
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/ ./packages/

# Skip packages/core — its dist is committed directly (includes pre-compiled
# modules whose TypeScript source lives in a separate private repo).
# Build only the packages that have full TypeScript source here.
RUN npm run build -w packages/telemetry \
 && npm run build -w packages/mcp \
 && npm run build -w packages/cli \
 && npm run build -w packages/proxy \
 && npm run build -w packages/ui

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

# Non-root user — the embedding cache + token files land in $HOME, so we want
# a stable home directory we control.
RUN useradd --create-home --shell /bin/bash --uid 1001 sci \
    && mkdir -p /home/sci/.sci /home/sci/.cache/fastembed \
    && chown -R sci:sci /home/sci

# Copy the entire workspace including node_modules so workspace links resolve.
# (Workspace symlinks point @sci/core → packages/core, which resolves at
# runtime against the dist files we built in the previous stage.)
COPY --from=build --chown=sci:sci /app/package.json    ./
COPY --from=build --chown=sci:sci /app/node_modules    ./node_modules
COPY --from=build --chown=sci:sci /app/packages        ./packages

# /app needs to be writable by the sci user — fastembed and a few other libs
# default to relative-path caches (./local_cache) and we'd rather have them
# fail-soft than crash. The compose file sets SCI_FASTEMBED_CACHE_DIR to
# redirect the BGE model into a mounted volume, but this is the safety net.
RUN chown -R sci:sci /app

# We don't ship sources or source maps — only built artefacts and public/.
# Strip *.ts and *.map from packages to keep the runtime image small.
RUN find /app/packages -type d \( -name 'src' -o -name 'docs' -o -name 'tests' \) -prune -exec rm -rf {} + \
    && find /app/packages -name '*.ts' -delete \
    && find /app/packages -name '*.map' -delete

USER sci
ENV NODE_ENV=production
ENV HOME=/home/sci

EXPOSE 3001 3002 53000

# Default to UI server. Override via docker-compose `command:` for proxy / auth.
CMD ["node", "packages/ui/dist/server.js"]
