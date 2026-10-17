#!/usr/bin/env bash
# dsh-chapters development installer
#
# Installs dsh-chapters into the EXISTING web profile so you get the full Web UI
# with the chapters plugin active. This mirrors how the live environment works:
#   - Links this checkout as the plugin source (edits reflect after rebuild)
#   - Adds the local Qwen provider to the existing LLM configuration
#   - Sets chapters as the selectedDefault preset
#   - Applies dev-specific Cordis overrides (timeouts, llm-gate)
#
# Usage: ./dev/install/install.sh [--dsh-home PATH] [--host-version VER]
#
# Environment overrides (take precedence over flags):
#   DSH_HOME          DSH home directory (default: ~/.dsh)
#   DSH_HOST_VERSION  @deepseek-ai/dsh version (default: latest)

set -euo pipefail

# ── Resolve paths ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Defaults ───────────────────────────────────────────────────────────────────
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
DSH_HOST_VERSION="${DSH_HOST_VERSION:-latest}"
PROFILE_NAME="web"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"

# ── Parse flags ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh-home)      DSH_HOME="$2"; shift 2 ;;
    --host-version)  DSH_HOST_VERSION="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--dsh-home PATH] [--host-version VER]"
      echo ""
      echo "Installs dsh-chapters into the existing 'web' profile."
      echo ""
      echo "Options:"
      echo "  --dsh-home PATH       DSH home directory (default: ~/.dsh)"
      echo "  --host-version VER    @deepseek-ai/dsh version (default: latest)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Helpers ────────────────────────────────────────────────────────────────────
info()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[  ok ]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[ warn]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[ fail]\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" &>/dev/null || fail "Required command not found: $1"
}

# ── Pre-flight ─────────────────────────────────────────────────────────────────
info "Checking prerequisites..."
require_cmd node
require_cmd npm
require_cmd git

NODE_VERSION="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [[ "$NODE_VERSION" -lt 22 ]]; then
  fail "Node.js ≥ 22 required (found $(node -v))"
fi
ok "Node.js $(node -v)"

# ── Step 1: Install DSH host ──────────────────────────────────────────────────
info "Checking DSH host installation..."

CURRENT_DSH_VERSION="$(dsh --version 2>/dev/null || echo "not-installed")"

if [[ "$CURRENT_DSH_VERSION" == "not-installed" ]]; then
  info "Installing @deepseek-ai/dsh@${DSH_HOST_VERSION} globally..."
  npm install -g "@deepseek-ai/dsh@${DSH_HOST_VERSION}"
  ok "DSH host installed: $(dsh --version)"
elif [[ "$DSH_HOST_VERSION" != "latest" && "$CURRENT_DSH_VERSION" != "$DSH_HOST_VERSION" ]]; then
  warn "DSH host version mismatch: installed=$CURRENT_DSH_VERSION, requested=$DSH_HOST_VERSION"
  info "Upgrading @deepseek-ai/dsh@${DSH_HOST_VERSION}..."
  npm install -g "@deepseek-ai/dsh@${DSH_HOST_VERSION}"
  ok "DSH host upgraded: $(dsh --version)"
else
  ok "DSH host already installed: $CURRENT_DSH_VERSION"
fi

# ── Step 2: Build the plugin ──────────────────────────────────────────────────
info "Building dsh-chapters plugin..."

cd "$REPO_ROOT"

if [[ ! -d "node_modules" ]]; then
  info "Installing dependencies (npm ci)..."
  npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts
fi

info "Compiling TypeScript..."
npm run build 2>/dev/null || npx tsc -p tsconfig.json
ok "Plugin built: lib/index.js"

# Verify the build output exists
[[ -f "lib/index.js" ]] || fail "Build failed: lib/index.js not found"
[[ -f "cordis.patch.yml" ]] || fail "Missing cordis.patch.yml in repo root"

PLUGIN_VERSION="$(node -e "console.log(require('$REPO_ROOT/package.json').version)")"

# ── Step 3: Ensure web profile exists ─────────────────────────────────────────
info "Setting up web profile at $PROFILE_DIR..."

mkdir -p "$DSH_HOME"

if [[ ! -d "$PROFILE_DIR" ]]; then
  info "Creating web profile from default template..."
  mkdir -p "$PROFILE_DIR"

  # Initialize from the shipped web template
  cat > "$PROFILE_DIR/cordis.yml" <<'CORDIS'
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml.
[]
CORDIS
fi

# ── Step 4: Update profile package.json ───────────────────────────────────────
info "Configuring profile package.json..."

PKG_JSON="$PROFILE_DIR/package.json"

# Plugin versions / sources — mirrors the live web profile
CODEGRAPH_PKG="@jiangzhenguo/dsh-codegraph"
CODEGRAPH_SRC="github:jiangzhenguo/dsh-codegraph"
TINYFISH_PKG="dsh-tinyfish-search"
TINYFISH_VER="0.15.0"

if [[ -f "$PKG_JSON" ]]; then
  # Existing profile — merge all dev plugins into dependencies and bundles
  info "Merging dev plugins into existing web profile..."
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$PKG_JSON', 'utf8'));

    if (!pkg.dependencies) pkg.dependencies = {};

    // dsh-chapters (linked to this checkout)
    pkg.dependencies['@treeseed/dsh-chapters'] = 'link:$REPO_ROOT';

    // dsh-codegraph (GitHub source)
    if (!pkg.dependencies['$CODEGRAPH_PKG']) {
      pkg.dependencies['$CODEGRAPH_PKG'] = '$CODEGRAPH_SRC';
    }

    // dsh-tinyfish-search (npm)
    if (!pkg.dependencies['$TINYFISH_PKG']) {
      pkg.dependencies['$TINYFISH_PKG'] = '$TINYFISH_VER';
    }

    // Ensure bundle list includes all plugins
    if (!pkg.dsh) pkg.dsh = {};
    if (!pkg.dsh.profile) pkg.dsh.profile = {};
    if (!pkg.dsh.profile.bundles) pkg.dsh.profile.bundles = [];
    const bundles = pkg.dsh.profile.bundles;
    for (const b of ['@treeseed/dsh-chapters', '$TINYFISH_PKG', '$CODEGRAPH_PKG']) {
      if (!bundles.includes(b)) bundles.push(b);
    }

    fs.writeFileSync('$PKG_JSON', JSON.stringify(pkg, null, 2) + '\n');
    console.log('Dependencies:', JSON.stringify(pkg.dependencies, null, 2));
  "
else
  # Fresh profile — create package.json with web bundles + all dev plugins
  info "Creating fresh web profile package.json..."
  cat > "$PKG_JSON" <<PKGJSON
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "${CODEGRAPH_PKG}": "${CODEGRAPH_SRC}",
    "@treeseed/dsh-chapters": "link:${REPO_ROOT}",
    "${TINYFISH_PKG}": "${TINYFISH_VER}"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "${TINYFISH_PKG}",
        "@treeseed/dsh-chapters",
        "${CODEGRAPH_PKG}"
      ]
    }
  }
}
PKGJSON
fi
ok "Profile package.json updated (chapters v${PLUGIN_VERSION} linked + codegraph + tinyfish)"

# ── Step 5: Merge dev Cordis patch entries ────────────────────────────────────
info "Applying dev Cordis patch entries..."

PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
DEV_PATCH="$SCRIPT_DIR/profile-cordis.patch.yml"

if [[ -f "$PATCH_FILE" ]]; then
  # Check if our full config block is already present (marker comment)
  if grep -q "dsh-chapters DEV Cordis patch" "$PATCH_FILE" 2>/dev/null || \
     (grep -q "qwen-token-plan" "$PATCH_FILE" 2>/dev/null && \
      grep -q "llm-gate" "$PATCH_FILE" 2>/dev/null); then
    ok "Cordis patch entries already present"
  else
    info "Appending full config to existing cordis.patch.yml..."
    echo "" >> "$PATCH_FILE"
    cat "$DEV_PATCH" >> "$PATCH_FILE"
    ok "Full config appended to cordis.patch.yml"
  fi
else
  # No existing patch — copy ours as the complete file
  cp "$DEV_PATCH" "$PATCH_FILE"
  ok "Cordis patch created from dev template"
fi

# ── Step 6: Merge dev settings ────────────────────────────────────────────────
info "Merging dev settings..."

LLM_BASE_URL="${LLM_BASE_URL:-http://localhost:8080/v1}"
LLM_MODEL="${LLM_MODEL:-qwen3-4b-instruct}"
LLM_CONTEXT_WINDOW="${LLM_CONTEXT_WINDOW:-32768}"
LLM_MAX_TOKENS="${LLM_MAX_TOKENS:-15000}"
SYSTEMONE_MODEL="${SYSTEMONE_MODEL:-qwen3-4b-systemone}"
LOCAL_API_KEY="${LOCAL_API_KEY:-sk-local}"

SETTINGS_FILE="$PROFILE_DIR/settings.yaml"

if [[ -f "$SETTINGS_FILE" ]]; then
  # Existing settings — check if local provider is already configured
  if grep -q "local:" "$SETTINGS_FILE" 2>/dev/null; then
    ok "Local LLM provider already configured in settings"
  else
    info "Appending local vLLM provider to existing settings..."
    cat >> "$SETTINGS_FILE" <<SETTINGS

# ── dsh-chapters dev: local vLLM provider (added by install.sh) ──────────
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
llm-pi-ai:
  providers:
    local:
      displayName: Local vLLM
      api: openai-completions
      baseURL: ${LLM_BASE_URL}
      models:
        - id: ${LLM_MODEL}
          name: "${LLM_MODEL} (local vLLM)"
          contextWindow: ${LLM_CONTEXT_WINDOW}
          maxTokens: ${LLM_MAX_TOKENS}
          reasoningEfforts:
            off:
            low: low
            medium: medium
            high: high
            xhigh: xhigh
        - id: ${SYSTEMONE_MODEL}
          name: "${SYSTEMONE_MODEL} (systemone decision)"
          contextWindow: ${LLM_CONTEXT_WINDOW}
          maxTokens: 4096
      apiKeyEnv: LOCAL_API_KEY
      streamIdleTimeoutMs: 3600000
      timeoutMs: 3600000
      reasoning: medium
      retryPolicy:
        mode: normal
        maxRetries: 0
      compat:
        supportsDeveloperRole: false
SETTINGS
    ok "Local vLLM provider appended to settings"
  fi
else
  # Fresh settings file
  cat > "$SETTINGS_FILE" <<SETTINGS
# dsh-chapters DEV settings — generated by install.sh
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Repo: $REPO_ROOT
llm-pi-ai:
  providers:
    local:
      displayName: Local vLLM
      api: openai-completions
      baseURL: ${LLM_BASE_URL}
      models:
        - id: ${LLM_MODEL}
          name: "${LLM_MODEL} (local vLLM)"
          contextWindow: ${LLM_CONTEXT_WINDOW}
          maxTokens: ${LLM_MAX_TOKENS}
          reasoningEfforts:
            off:
            low: low
            medium: medium
            high: high
            xhigh: xhigh
        - id: ${SYSTEMONE_MODEL}
          name: "${SYSTEMONE_MODEL} (systemone decision)"
          contextWindow: ${LLM_CONTEXT_WINDOW}
          maxTokens: 4096
      apiKeyEnv: LOCAL_API_KEY
      streamIdleTimeoutMs: 3600000
      timeoutMs: 3600000
      reasoning: medium
      retryPolicy:
        mode: normal
        maxRetries: 0
      compat:
        supportsDeveloperRole: false

agent-default-model:
  provider: local
  model: ${LLM_MODEL}
  reasoningEffort: medium

agent-presets:
  default: chapters

ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
SETTINGS
  ok "Settings created (model: ${LLM_MODEL}, systemone: ${SYSTEMONE_MODEL})"
fi

# ── Step 7: Ensure agent-preset-registry has chapters as selectedDefault ──────
info "Ensuring chapters preset is available..."

if [[ -f "$PATCH_FILE" ]]; then
  if grep -q "selectedDefault: chapters" "$PATCH_FILE" 2>/dev/null || \
     grep -q "default: chapters" "$PATCH_FILE" 2>/dev/null; then
    ok "Chapters preset already configured"
  else
    info "Adding chapters preset selection to cordis.patch.yml..."
    cat >> "$PATCH_FILE" <<'PRESET'

- id: agent-preset-registry
  config:
    selectedDefault: chapters
PRESET
    ok "Chapters preset selection added"
  fi
fi

# ── Step 8: Install profile dependencies ──────────────────────────────────────
info "Installing profile dependencies..."

cd "$PROFILE_DIR"

# Use pnpm if available (DSH profiles typically use pnpm), fall back to npm
if command -v pnpm &>/dev/null; then
  pnpm install --no-frozen-lockfile 2>&1 | tail -5
else
  warn "pnpm not found — using npm (DSH profiles prefer pnpm)"
  npm install 2>&1 | tail -5
fi
ok "Profile dependencies installed"

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
printf '\033[1;32m✓ Installation complete!\033[0m\n'
echo ""
echo "  Profile:  $PROFILE_NAME (with Web UI)"
echo "  Location: $PROFILE_DIR"
echo "  Plugin:   $REPO_ROOT (linked, v${PLUGIN_VERSION})"
echo ""
echo "  Start the Web UI:"
echo "    export LOCAL_API_KEY=${LOCAL_API_KEY}"
echo "    dsh web"
echo ""
echo "  Or specify the home explicitly:"
echo "    DSH_HOME=${DSH_HOME} dsh web"
echo ""
echo "  To uninstall (remove plugin from web profile):"
echo "    $SCRIPT_DIR/uninstall.sh"
echo ""
