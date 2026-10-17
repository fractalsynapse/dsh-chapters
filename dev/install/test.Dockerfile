# DSH Chapters Test Runner
#
# CI-capable test environment with Node.js 22, Playwright, and Chromium.
# Mounts the repo at /workspace so source edits are reflected without rebuild.
#
# Build:  docker build -f dev/install/test.Dockerfile -t dsh-chapters-test .
# Run:    docker compose run --rm dsh-test npm run test:e2e:replay

FROM mcr.microsoft.com/playwright:v1.50.0-noble

# Node.js 22 is already in the Playwright image; verify
RUN node -v && npm -v

# Install system dependencies for git operations and native addons
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Pre-install project dependencies at build time for faster test starts.
# The volume mount at runtime overlays these, but having them baked in
# means the first `docker compose run` doesn't wait for npm ci.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts 2>/dev/null || true

# Copy source for build verification (volume mount overrides at runtime)
COPY tsconfig.json ./
COPY src/ ./src/
COPY cordis.patch.yml ./
COPY tests/ ./tests/
COPY scripts/ ./scripts/
COPY playwright.config.ts ./

# Build the plugin
RUN npm run build 2>/dev/null || npx tsc -p tsconfig.json || true

# Verify Playwright browsers are installed
RUN npx playwright install --with-deps chromium 2>/dev/null || true

# Default: show available test commands
CMD ["echo", "Available commands:\n  npm run test:unit          — unit tests\n  npm run test:e2e:replay   — e2e replay (no LLM needed)\n  npm run test:e2e:record   — record new tapes (needs LLM)\n  npm run coverage:ci       — coverage gate\n\nRun with: docker compose run --rm dsh-test <command>"]
