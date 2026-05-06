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
COPY packages/core/package.json   ./packages/core/
COPY packages/mcp/package.json    ./packages/mcp/
COPY packages/cli/package.json    ./packages/cli/
COPY packages/proxy/package.json  ./packages/proxy/
COPY packages/ui/package.json     ./packages/ui/

RUN npm ci --workspaces --include-workspace-root

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/ ./packages/

RUN npm run build

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
