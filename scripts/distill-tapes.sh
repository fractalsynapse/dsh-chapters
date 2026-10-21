#!/usr/bin/env bash
# distill-tapes — one whole-project re-record per acceptance project (#54).
#
# Why a script: `npm run test:e2e:record` chains EIGHT projects with && , which means the
# first failure hides the other seven, and a re-distill is exactly the run where you want to
# know what every project does. Each project boots its own server on its own port with its
# own pins (the same env the npm script uses), archives its own tape, and reports.
#
#   scripts/distill-tapes.sh                 # every project, hosted endpoint, sequential
#   scripts/distill-tapes.sh fork suite      # just these
#   LOCAL_LLM_UP=1 scripts/distill-tapes.sh  # prefer the local :8080 stress server
#
# SEQUENTIAL ON PURPOSE: never two boots at once (measured 2026-09-23 — a live loop that
# records mid-test can be OOM-killed, and same-home sibling boots have corrupted captures).
# plans is special: its upstream is the SCRIPTED stub (tests/e2e/stub-model.ts), because
# a tape must not freeze one model's decision to plan (see its PROVENANCE.md). That leg is
# unchanged by this script — run it with the stub, as documented.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
NODE_BIN="${NODE_BIN:-$ROOT/var/toolchain/node-v24.22.0-linux-x64/bin}"
export PATH="$NODE_BIN:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/var/ms-playwright"

HOSTED="${E2E_UPSTREAM:-https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode}"
HOSTED_MODEL="${E2E_UPSTREAM_MODEL:-qwen3.8-flash}"
if [[ "${LOCAL_LLM_UP:-}" == "1" ]]; then HOSTED="http://localhost:8080"; HOSTED_MODEL=""; fi
if [[ -z "${E2E_UPSTREAM_KEY:-}" && "$HOSTED" != http://localhost* ]]; then
  E2E_UPSTREAM_KEY="$(node -e "import('./scripts/llm.mjs').then(m=>process.stdout.write(m.apiKey()||''))" 2>/dev/null || true)"
fi
export E2E_UPSTREAM="$HOSTED"
[[ -n "${E2E_UPSTREAM_KEY:-}" ]] && export E2E_UPSTREAM_KEY
[[ -n "$HOSTED_MODEL" ]] && export E2E_UPSTREAM_MODEL

# project | port | threshold | extra env | arrival floor
specs=(
  "suite|41731|0.75|E2E_TAPE=suite|"
  "heavy|41733|0.5|E2E_TAPE=heavy|E2E_FLOOR=1000000"
  "arrival|41732|0.9|E2E_TAPE=arrival|E2E_FLOOR=500"
  "enrich|41734|0.9|E2E_TAPE=enrich;E2E_ENRICH=1|"
  "fanout|41736|0.75|E2E_TAPE=fanout|"
  "rules|41735|0.9|E2E_TAPE=rules|"
  "fork|41737|0.75|E2E_TAPE=fork|"
  "plans|41738|0.99|E2E_TAPE=plans;E2E_NO_AUX_MODEL=1|"
)
want=("$@"); [[ ${#want[@]} -eq 0 ]] && want=(suite heavy arrival enrich fanout rules fork plans)

rmrf_tape() { [[ "${KEEP_TAPES:-}" == "1" ]] || rm -rf "tests/fixtures/model-tape/$1"; }
declare -a failed=()
for entry in "${specs[@]}"; do
  IFS='|' read -r proj port thr extra floor <<< "$entry"
  printf '%s' "${want[@]}" | grep -qw "$proj" || continue
  echo "=== distill $proj (port $port, threshold $thr) ==="
  rmrf_tape "$proj"
  # shellcheck disable=SC2086
  env E2E_MODEL=record E2E_PORT="$port" E2E_THRESHOLD="$thr" \
    $( [[ -n "$floor" ]] && echo "$floor" ) \
    $( [[ "$extra" == *";"* ]] && echo "E2E_ENRICH=1" ) \
    E2E_TAPE="$proj" \
    timeout "${DISTILL_TIMEOUT:-1800}" npx playwright test -c tests/e2e/playwright.config.ts --project="$proj" 2>&1 | tail -12
  rc=${PIPESTATUS[0]}
  count=$(ls "tests/fixtures/model-tape/$proj" 2>/dev/null | grep -c json || true)
  echo "--- $proj: rc=$rc, tape entries=$count"
  [[ "$rc" -ne 0 ]] && failed+=("$proj")
done
echo
if [[ ${#failed[@]} -eq 0 ]]; then echo "distill: all requested projects recorded"; else echo "distill FAILED: ${failed[*]}"; exit 1; fi
