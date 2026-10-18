#!/usr/bin/env bash
# Docker entrypoint for the dsh-chapters-dev service image.
#
# Roles (DSH_ROLE env):
#   web      — DSH Web UI on ${DSH_HOST}:${DSH_PORT} (the original behavior)
#   gateway  — SDK API gateway: WebSocket↔stdio relay serving `dsh --profile
#              sdk` children to external @deepseek-ai/dsh-sdk-client callers (#25)
#
# Configuration delivery, measured on host 0.2.x (#25 finding): a profile-dir
# settings.yaml is read by NOTHING — only $DSH_HOME/settings.yaml gets a
# one-time legacy import (packages/settings/settings/src/index.ts:243). The
# old entrypoint wrote profiles/web/settings.yaml and the local vLLM provider
# in it NEVER took effect (the live container proved it: zero baseURL rows in
# the effective config while agent-default-model selected `local`). Config now
# rides cordis.patch.yml: generate_profile_patch() composes each profile's
# patch from its static template + the env-interpolated llm-pi-ai row, so the
# `local:` route and the qwen-token-plan marketplace land together in ONE row
# (patch rows replace whole config blocks — restating both is mandatory).

set -euo pipefail

ROLE="${DSH_ROLE:-web}"
SDK_PROFILE_NAME="${DSH_SDK_PROFILE:-sdk}"

# ── Defaults ───────────────────────────────────────────────────────────────────
LLM_BASE_URL="${LLM_BASE_URL:-http://vllm:8080/v1}"
LLM_MODEL="${LLM_MODEL:-qwen3-4b-instruct}"
LLM_CONTEXT_WINDOW="${LLM_CONTEXT_WINDOW:-32768}"
LLM_MAX_TOKENS="${LLM_MAX_TOKENS:-15000}"
LOCAL_API_KEY="${LOCAL_API_KEY:-sk-local}"
SYSTEMONE_BASE_URL="${SYSTEMONE_BASE_URL:-http://vllm:8080/v1}"
SYSTEMONE_MODEL="${SYSTEMONE_MODEL:-qwen3-4b-systemone}"
QWEN_TOKEN_PLAN_API_KEY="${QWEN_TOKEN_PLAN_API_KEY:-}"
TINYFISH_API_KEY="${TINYFISH_API_KEY:-}"
DSH_PORT="${DSH_PORT:-3080}"
# 0.2.x refuses to bind 0.0.0.0 (remote-code-execution safety, dsh-web-app
# startup.js). Inside the container we bind loopback; Docker's published port
# mapping is what makes the surface reachable from the host.
DSH_HOST="${DSH_HOST:-127.0.0.1}"
GATEWAY_PORT="${GATEWAY_PORT:-8765}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-}"
GATEWAY_API_KEYS="${GATEWAY_API_KEYS:-}"
GATEWAY_IDLE_MS="${GATEWAY_IDLE_MS:-1800000}"
GATEWAY_INIT_TIMEOUT_MS="${GATEWAY_INIT_TIMEOUT_MS:-30000}"
# Hosted-archive durability (#33): absolute chapter-store root for non-web
# profiles; the gateway mounts a named volume at /workspace, so this lands the
# archive where it survives recreate. Empty is not an option — keep the default.
DSH_CHAPTERS_STORE_ROOT="${DSH_CHAPTERS_STORE_ROOT:-/workspace/.dsh-chapters}"

# ── Seed the credentials document ─────────────────────────────────────────────
# credentials-local refuses to load a world-readable .credentials.yaml (mode
# must be owner-only) and its absence would fail the `credentials` service.
# A named volume mounted at that FILE path becomes an empty 755 DIRECTORY —
# so compose no longer mounts one, and we own the file here instead. API keys
# still arrive through env (apiKeyEnv references), nothing is lost per boot.
CREDENTIALS_FILE="$DSH_HOME/.credentials.yaml"
if [ ! -f "$CREDENTIALS_FILE" ]; then
  echo "[entrypoint] seeding $CREDENTIALS_FILE (mode 600)"
  umask 077
  printf 'version: 1\nrefs: {}\n' > "$CREDENTIALS_FILE"
  chmod 600 "$CREDENTIALS_FILE"
fi

# ── Repair zero-byte profile manifests ────────────────────────────────────────
# The image writes package.json with printf inside RUN; if any past variant
# landed EMPTY, every boot dies at JSON.parse ("Unexpected end of JSON input")
# in a restart loop (#19). An empty manifest is never valid — delete it and let
# app-boot re-init the profile from its shipped template. Real bytes (a user's
# edited manifest) are left alone.
for p in "$DSH_HOME/profiles"/*/package.json; do
  [ -e "$p" ] || continue
  if [ ! -s "$p" ]; then
    echo "[entrypoint] removing zero-byte profile manifest $p; dsh will re-initialize it"
    rm -f "$p"
  fi
done

# ── Generate the llm-pi-ai patch row (env-interpolated) ───────────────────────
# One row carries BOTH routes because a patch replaces the whole config block.
generate_llm_row() {
  cat <<LLMROW
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      # Local vLLM provider (Qwen3-4B-AWQ) — small-model default (#25)
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
      # Alibaba Qwen Token Plan marketplace (optional — needs API key)
      qwen-token-plan:
        models:
          - id: deepseek-v4-pro
            name: DeepSeek V4 Pro
            contextWindow: 1000000
            maxTokens: 384000
            input: [text]
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1000000
            maxTokens: 384000
            input: [text, image]
          - id: glm-5.3
            name: GLM-5.3
            contextWindow: 1000000
            maxTokens: 131072
            input: [text]
          - id: kimi-k2.6
            name: Kimi K2.6
            contextWindow: 262144
            maxTokens: 262144
            input: [text, image]
          - id: kimi-k2.7-code
            name: Kimi K2.7 Code
            contextWindow: 262144
            maxTokens: 262144
            input: [text, image]
          - id: MiniMax-M2.5
            name: MiniMax-M2.5
            contextWindow: 196608
            maxTokens: 32768
            input: [text]
          - id: qwen3.8-flash
            name: Qwen3.8 Flash
            contextWindow: 1000000
            maxTokens: 131072
            input: [text, image]
          - id: qwen3.8-max
            name: Qwen3.8 Max
            contextWindow: 1000000
            maxTokens: 131072
            input: [text, image]
        apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY
LLMROW
}

# Compose one profile's cordis.patch.yml: the generated llm-pi-ai row first,
# then the static template WITHOUT its own llm-pi-ai row (a later replacement
# row would otherwise drop the local provider). Idempotent per boot.
generate_profile_patch() {
  local profile_dir="$1" template="$2"
  mkdir -p "$profile_dir"
  {
    echo "# Profile patch composed by the container entrypoint at $(date -u +%Y-%m-%dT%H:%M:%SZ)."
    echo "# Static template: ${template##*/}. The llm-pi-ai row below carries BOTH the local"
    echo "# vLLM route and the qwen-token-plan marketplace in one replacement (see header)."
    generate_llm_row
    # small-model stance (#25): the default route is the local vLLM provider —
    # the old settings.yaml carried this and died unread; here it is a patch row.
    cat <<DEFAULTROW
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: ${LLM_PROVIDER:-local}
    model: ${LLM_MODEL}
    reasoningEffort: medium
DEFAULTROW
    # The preset registry mounts `agentPresets`, which our bundle's
    # `preset-chapters` declaration row injects. On host 0.2.x only the web-app
    # bundle ships that mount (measured: base does NOT) — so in the sdk profile
    # the row would sit pending forever ("1 entry did not activate:
    # preset-chapters … waiting for service: agentPresets", seen live in the
    # gateway child's stderr). The insert is UNCONDITIONAL: templates carry no
    # registry rows, and in web this lands after the bundle's own mount where
    # the same-id config replaces it with ours (selectedDefault: chapters).
    cat <<REGROW
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard
        selectedDefault: chapters
REGROW
    # Same host-scope story for the subagent model-selection settings plugin:
    # our preset's tool-subagent row sets `modelSelectionSettings: true`, and
    # the tool throws "requires @deepseek-ai/dsh-tool-subagent/model-selection-settings
    # in the Host scope" unless that plugin is mounted at root — web-app mounts
    # it, base does not (measured live on the gateway child: preset "chapters"
    # DECLARED BUT BROKEN). Insert only when the profile has no web-app bundle
    # (the sdk/gateway profiles), so web never double-mounts.
    if ! grep -q "dsh-web-app" "$profile_dir/package.json" 2>/dev/null; then
      cat <<SETROW
- insert:
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
SETROW
      # Per-turn workspace-change announcements (#37): the recorder emits a
      # `workspace/changes` session event per changed top-level turn (summary
      # stays host-side behind ctx.workspaceChanges — measured payload is {turn}).
      # web-app mounts it; base does not. Needs subprocess+fs only, both in base.
      cat <<WCROW
- insert:
    - id: workspace-changes
      name: '@deepseek-ai/dsh-workspace-changes'
WCROW
    fi
    # Hosted-archive durability (#33): the chapter store root is cwd-relative
    # by design (measured: path.join(cwd, artifactStoreRoot) — `read` must reach
    # it), so persisting the archive means persisting the agent workspace. The
    # gateway mounts a named volume at /workspace; pointing the store there with
    # an ABSOLUTE artifactStoreRoot keeps hosted chapters under that volume even
    # when a session runs in a subdirectory of the workspace. Only for profiles
    # without a web-app bundle (the web UI manages its own per-project stores).
    if ! grep -q "dsh-web-app" "$profile_dir/package.json" 2>/dev/null; then
      cat <<STOREROW
- id: '@treeseed/dsh-chapters'
  name: '@treeseed/dsh-chapters'
  config:
    artifactStoreRoot: ${DSH_CHAPTERS_STORE_ROOT}
STOREROW
    fi
    # strip the template's own llm-pi-ai top-level row (id line through the next
    # top-level '- id:' / '- insert:' line)
    awk '/^- id: llm-pi-ai$/ {skip=1; next} /^- (id|insert):/ {skip=0} !skip' "$template"
  } > "$profile_dir/cordis.patch.yml.tmp"
  mv "$profile_dir/cordis.patch.yml.tmp" "$profile_dir/cordis.patch.yml"
  echo "[entrypoint] composed $profile_dir/cordis.patch.yml"
}

export LOCAL_API_KEY
export QWEN_TOKEN_PLAN_API_KEY
export TINYFISH_API_KEY

case "$ROLE" in
  web)
    PROFILE_DIR="$DSH_HOME/profiles/web"
    generate_profile_patch "$PROFILE_DIR" /app/profile-cordis.patch.yml
    echo "[entrypoint] Starting DSH Web UI on ${DSH_HOST}:${DSH_PORT}..."
    echo "[entrypoint] Profile: web"
    echo "[entrypoint] LLM: $LLM_BASE_URL ($LLM_MODEL)"
    echo "[entrypoint] SystemOne: $SYSTEMONE_BASE_URL ($SYSTEMONE_MODEL)"
    echo "[entrypoint] Token plan: ${QWEN_TOKEN_PLAN_API_KEY:+configured}${QWEN_TOKEN_PLAN_API_KEY:-not set}"
    exec dsh web \
      --host "$DSH_HOST" \
      --port "$DSH_PORT"
    ;;

  gateway)
    PROFILE_DIR="$DSH_HOME/profiles/$SDK_PROFILE_NAME"
    generate_profile_patch "$PROFILE_DIR" /app/profile-sdk-cordis.patch.yml
    if [ "$GATEWAY_TOKEN" = "" ]; then
      echo "[entrypoint] FATAL: GATEWAY_TOKEN is empty — refusing to expose an unauthenticated RCE surface."
      echo "[entrypoint] Set GATEWAY_TOKEN in the environment (compose.sdk.yml reads it from .env)."
      exit 1
    fi
    export GATEWAY_PORT GATEWAY_TOKEN GATEWAY_API_KEYS GATEWAY_IDLE_MS GATEWAY_INIT_TIMEOUT_MS
    export DSH_GATEWAY_BIND="${DSH_GATEWAY_BIND:-127.0.0.1}"
    export DSH_SDK_PROFILE="$SDK_PROFILE_NAME"
    echo "[entrypoint] Starting SDK API gateway on ${DSH_GATEWAY_BIND:-127.0.0.1}:${GATEWAY_PORT} (profile $SDK_PROFILE_NAME)..."
    echo "[entrypoint] LLM: $LLM_BASE_URL ($LLM_MODEL) | Token plan: ${QWEN_TOKEN_PLAN_API_KEY:+configured}${QWEN_TOKEN_PLAN_API_KEY:-not set}"
    exec node /gateway/gateway.mjs
    ;;

  *)
    echo "[entrypoint] unknown DSH_ROLE '$ROLE' (expected: web | gateway)" >&2
    exit 1
    ;;
esac
