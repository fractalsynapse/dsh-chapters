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

# Create profile package.json with web bundles + all dev plugins
RUN cat > "${PROFILE_DIR}/package.json" <<'EOF'
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@jiangzhenguo/dsh-codegraph": "github:jiangzhenguo/dsh-codegraph",
    "@treeseed/dsh-chapters": "link:/app",
    "dsh-tinyfish-search": "0.15.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-tinyfish-search",
        "@treeseed/dsh-chapters",
        "@jiangzhenguo/dsh-codegraph"
      ]
    }
  }
}
EOF

# Create empty cordis root
RUN echo '[]' > "${PROFILE_DIR}/cordis.yml"

# Install profile dependencies
WORKDIR ${PROFILE_DIR}
RUN npm install --omit=dev 2>/dev/null || true

WORKDIR /app

# Entrypoint generates settings from env vars and starts DSH web
COPY dev/install/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s \
  CMD curl -fsS http://localhost:3080/api/health 2>/dev/null || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
