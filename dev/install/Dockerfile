# DSH Chapters Development Service — Web UI
#
# Multi-stage build: compiles the plugin, then runs DSH with the full Web UI
# on port 3080. The web profile is pre-configured with dsh-chapters linked.
#
# Build:  docker build -f dev/install/Dockerfile -t dsh-chapters-dev .
# Run:    docker run -p 3080:3080 -e LOCAL_API_KEY=sk-local dsh-chapters-dev

# ── Stage 1: Build ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Install build dependencies (git for isomorphic-git, python/make for native addons)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY cordis.patch.yml ./
RUN npm run build 2>/dev/null || npx tsc -p tsconfig.json

# Verify build output
RUN test -f lib/index.js || (echo "Build failed: lib/index.js missing" && exit 1)

# ── Stage 2: Runtime ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# Runtime dependencies for DSH and git operations
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install DSH host globally
ARG DSH_HOST_VERSION=latest
RUN npm install -g "@deepseek-ai/dsh@${DSH_HOST_VERSION}"

# Create DSH home and web profile directory
ENV DSH_HOME=/dsh-home
ENV PROFILE_DIR=/dsh-home/profiles/web
ENV NODE_ENV=production

RUN mkdir -p "$PROFILE_DIR" \
             "$DSH_HOME/sessions" \
             "$DSH_HOME/storages"

# Copy built plugin from builder
WORKDIR /app
COPY --from=builder /build/package.json ./
COPY --from=builder /build/package-lock.json ./
COPY --from=builder /build/lib/ ./lib/
COPY --from=builder /build/cordis.patch.yml ./

# Install production dependencies only (npm install, not ci — the lockfile
# includes dev deps that aren't needed at runtime)
RUN npm install --omit=dev --ignore-scripts

# Copy the dev Cordis patch into the profile
COPY dev/install/profile-cordis.patch.yml ${PROFILE_DIR}/cordis.patch.yml

# Create profile package.json with web bundles + all dev plugins.
# NOT a heredoc: on the legacy builder multi-line RUN continuations are joined
# with " && \\\n", so `<<EOF` never gets its body and the file lands EMPTY —
# every container then dies at JSON.parse in a restart loop (#19). printf is
# one logical line and survives both builders; %s is filled by the shell from
# $PROFILE_DIR (the Dockerfile ${} was expanded before /bin/sh ever saw it).
RUN printf '{\n  "name": "dsh-profile-web",\n  "private": true,\n  "dependencies": {\n    "@jiangzhenguo/dsh-codegraph": "github:jiangzhenguo/dsh-codegraph",\n    "@treeseed/dsh-chapters": "file:/app",\n    "dsh-tinyfish-search": "0.15.0"\n  },\n  "dsh": {\n    "profile": {\n      "bundles": [\n        "@deepseek-ai/dsh-base",\n        "@deepseek-ai/dsh-web-app",\n        "dsh-tinyfish-search",\n        "@treeseed/dsh-chapters",\n        "@jiangzhenguo/dsh-codegraph"\n      ]\n    }\n  }\n}\n' > "${PROFILE_DIR}/package.json"

# Create empty cordis root
RUN echo '[]' > "${PROFILE_DIR}/cordis.yml"

# Install profile dependencies. file: not link: (npm rejects the pnpm-only
# "link:" protocol with EUNSUPPORTEDPROTOCOL), and --legacy-peer-deps because
# tinyfish pins a peer range that conflicts with the host's rc-lineage pins —
# the old silent `|| true` swallowed exactly this, so every dev plugin skipped
# at boot (#19). No swallow: a broken install fails the image build loudly.
WORKDIR ${PROFILE_DIR}
RUN npm install --omit=dev --legacy-peer-deps && test -d node_modules/@treeseed/dsh-chapters

# The plugin imports its @deepseek-ai/* peers from ITS OWN tree first: a bare
# `import('@deepseek-ai/schemastery')` inside /app/lib resolves relative to
# /app/node_modules, which npm populated only with direct deps (isomorphic-git,
# zod) — peers were left unmet and the bundle failed to import at boot (#19).
# Symlink the host closure's copies into /app/node_modules so resolution works
# from any cwd; the versions are the host's own.
RUN mkdir -p "/app/node_modules/@deepseek-ai" && for pkg in $(cd /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai && ls); do \
      [ -e "/app/node_modules/@deepseek-ai/$pkg" ] || ln -s /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/$pkg "/app/node_modules/@deepseek-ai/$pkg"; \
    done && node --input-type=module -e "import('@deepseek-ai/schemastery').then(()=>console.log('peer symlinks resolve'))"

WORKDIR /app

# Entrypoint generates settings from env vars and starts DSH web
COPY dev/install/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3080

# No /api/health route exists on host 0.2.x (measured: 404 even authenticated),
# and the SPA index answers 401 until a browser completes the token exchange —
# so an HTTP-status probe can never go green from inside the container. Probe at
# the TCP layer instead: node is guaranteed present in this image.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
  CMD node -e 'const n=require("net"),s=n.connect(3080,"127.0.0.1",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))' || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
