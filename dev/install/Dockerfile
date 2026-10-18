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

# ── Stage 2: SDK gateway (#25) — compile the relay, resolve its closure ───────
# The gateway relays WebSocket frames ⇄ `dsh --profile sdk` child stdio. It
# speaks RAW stdio (not HarnessClient) so it forwards any protocol method
# verbatim — including ones a future host adds — and owns no protocol
# bookkeeping. `ws` is the only third-party import; pinned exact (this mini-
# manifest has no lockfile; a floating range would make image builds drift).
FROM node:22-bookworm-slim AS gateway-builder
WORKDIR /gw
RUN printf '{"name":"dsh-sdk-gateway","private":true,"type":"module","dependencies":{"ws":"8.18.0"}}' > package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY dev/install/sdk-gateway/gateway.ts ./gateway.ts
COPY dev/install/sdk-gateway/smoke.mts ./smoke.mts
COPY dev/install/sdk-gateway/connector.ts ./connector.ts
RUN npx --yes esbuild@0.25.5 gateway.ts --outfile=gateway.mjs --format=esm --platform=node --target=node22 --bundle --external:ws \
    && npx --yes esbuild@0.25.5 smoke.mts --outfile=smoke.mjs --format=esm --platform=node --target=node22 --bundle --external:ws \
    && npx --yes esbuild@0.25.5 connector.ts --outfile=connector.mjs --format=esm --platform=node --target=node22 --bundle --external:ws \
    && test -s gateway.mjs && test -s smoke.mjs && test -s connector.mjs

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
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

# Copy the dev Cordis patch TEMPLATES into /app. The entrypoint composes each
# profile's cordis.patch.yml from these at boot — a profile-dir settings.yaml
# is read by NOTHING on host 0.2.x (#25 finding: the old generated settings
# never took effect; config must ride the patch).
COPY dev/install/profile-cordis.patch.yml ./
COPY dev/install/profile-sdk-cordis.patch.yml ./

# Create profile package.json with web bundles + all dev plugins.
# NOT a heredoc: on the legacy builder multi-line RUN continuations are joined
# with " && \\\n", so `<<EOF` never gets its body and the file lands EMPTY —
# every container then dies at JSON.parse in a restart loop (#19). printf is
# one logical line and survives both builders; %s is filled by the shell from
# $PROFILE_DIR (the Dockerfile ${} was expanded before /bin/sh ever saw it).
RUN printf '{\n  "name": "dsh-profile-web",\n  "private": true,\n  "dependencies": {\n    "@jiangzhenguo/dsh-codegraph": "github:jiangzhenguo/dsh-codegraph",\n    "@treeseed/dsh-chapters": "file:/app",\n    "dsh-tinyfish-search": "0.15.0"\n  },\n  "dsh": {\n    "profile": {\n      "bundles": [\n        "@deepseek-ai/dsh-base",\n        "@deepseek-ai/dsh-web-app",\n        "dsh-tinyfish-search",\n        "@treeseed/dsh-chapters",\n        "@jiangzhenguo/dsh-codegraph"\n      ]\n    }\n  }\n}\n' > "${PROFILE_DIR}/package.json"

# SDK profile manifest (#25): same plugin set as web, sdk-app bundle instead of
# web-app — hosted agents keep chapters/codegraph/tinyfish AND the chapters
# preset (preset-chapters rides our bundle patch, mounted via agent-presets).
# Same printf discipline as above — no heredoc on this builder.
RUN mkdir -p "$DSH_HOME/profiles/sdk" && printf '{\n  "name": "dsh-profile-sdk",\n  "private": true,\n  "dependencies": {\n    "@jiangzhenguo/dsh-codegraph": "github:jiangzhenguo/dsh-codegraph",\n    "@treeseed/dsh-chapters": "file:/app",\n    "dsh-tinyfish-search": "0.15.0"\n  },\n  "dsh": {\n    "profile": {\n      "bundles": [\n        "@deepseek-ai/dsh-base",\n        "@deepseek-ai/dsh-sdk-app",\n        "dsh-tinyfish-search",\n        "@treeseed/dsh-chapters",\n        "@jiangzhenguo/dsh-codegraph"\n      ]\n    }\n  }\n}\n' > "$DSH_HOME/profiles/sdk/package.json"

# Create empty cordis roots (patches arrive per boot via the entrypoint)
RUN echo '[]' > "${PROFILE_DIR}/cordis.yml" && echo '[]' > "$DSH_HOME/profiles/sdk/cordis.yml"

# Install profile dependencies for BOTH profiles. file: not link: (npm rejects
# the pnpm-only "link:" protocol with EUNSUPPORTEDPROTOCOL), and
# --legacy-peer-deps because tinyfish pins a peer range that conflicts with the
# host's rc-lineage pins — the old silent `|| true` swallowed exactly this, so
# every dev plugin skipped at boot (#19). No swallow: a broken install fails the
# image build loudly. The sdk profile (#25) gets the identical plugin closure.
WORKDIR ${PROFILE_DIR}
RUN npm install --omit=dev --legacy-peer-deps && test -d node_modules/@treeseed/dsh-chapters
WORKDIR $DSH_HOME/profiles/sdk
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

# ── SDK gateway (#25): compile the relay, ship it with its `ws` closure ───────
# One WebSocket listener per container; per connection it spawns
# `node <dsh bin> --profile sdk` and relays newline JSON-RPC verbatim. Raw
# stdio (not HarnessClient) on purpose: forward ANY method, own no protocol
# bookkeeping, and no same-version manifest check can ever refuse a boot.
COPY --from=gateway-builder /gw/gateway.mjs /gateway/gateway.mjs
COPY --from=gateway-builder /gw/node_modules /gateway/node_modules
# GPU-box smoke client (not a CI gate): docker compose -f compose.sdk.yml exec dsh-agent-api node /gateway/smoke.mjs
COPY --from=gateway-builder /gw/smoke.mjs /gateway/smoke.mjs
# Consumer library (#31): in-image consumers import /gateway/connector.mjs; external ones vendor the file
COPY --from=gateway-builder /gw/connector.mjs /gateway/connector.mjs
RUN printf '{"type":"module"}' > /gateway/package.json \
    && node --input-type=module -e "import('/gateway/gateway.mjs').catch(e=>{if(String(e).includes('GATEWAY_TOKEN'))process.exit(0);throw e})" 2>/dev/null || true

# Agent working directory. The SDK server validates the initialize `cwd`
# against the real filesystem ("working-directory: directory does not exist",
# measured on 0.2.1-rc.2) — callers default to /workspace, and the web stack's
# test container already uses this path. A bind mount may replace it; empty is
# fine, missing is a failed turn.
RUN mkdir -p /workspace

# Entrypoint composes profile patches from env vars and starts the role service
COPY dev/install/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3080
EXPOSE 8765

# Role-aware healthcheck: web has no HTTP status that can go green from inside
# (no /api/health route on 0.2.x — measured 404 even authenticated — and the SPA
# index answers 401 until a browser completes the token exchange), so probe TCP.
# The gateway DOES serve /healthz (it has no dsh dependency by design), so an
# HTTP probe is meaningful there.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
  CMD bash -c 'if [ "${DSH_ROLE:-web}" = "gateway" ]; then curl -fsS "http://127.0.0.1:${GATEWAY_PORT:-8765}/healthz"; else node -e "const n=require(\"net\"),s=n.connect(3080,\"127.0.0.1\",()=>{s.end();process.exit(0)});s.on(\"error\",()=>process.exit(1))"; fi' || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
