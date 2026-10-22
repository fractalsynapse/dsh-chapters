#!/usr/bin/env bash
# distill-tapes — re-record the acceptance corpus, one project at a time (#54).
#
# Why a script instead of `npm run test:e2e:record`: that target chains eight projects with
# `&&`, so the FIRST failure hides the other seven and the run tells you nothing about the
# rest. A re-distill is exactly the run where you want every project's verdict. Each project
# gets its own boot, port and pins (the same env the npm script uses), and its tape directory
# is cleared first — a stale entry from another host is a prefix collision waiting to happen.
#
#   scripts/distill-tapes.sh                     # all eight, sequential
#   scripts/distill-tapes.sh fork rules          # just these
#   KEEP_TAPES=1 scripts/distill-tapes.sh rules  # archive onto the existing tape, don't clear
#
# SEQUENTIAL ON PURPOSE: never two boots at once (measured 2026-09-23 — a live loop recording
# mid-test can be OOM-killed; same-home sibling boots have corrupted captures).
#
# plans is a special case the script does NOT paper over: its upstream is the SCRIPTED stub
# (tests/e2e/stub-model.ts), because a tape must not freeze one model's decision to plan
# (tests/fixtures/model-tape/plans/PROVENANCE.md). Run that leg with the stub serving
# E2E_UPSTREAM, or it distills a different fact than the one the journey claims.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
export PATH="${NODE_BIN:-$ROOT/var/toolchain/node-v24.22.0-linux-x64/bin}:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/var/ms-playwright}"

# endpoint resolution: local stress server if it answers, hosted otherwise (scripts/llm.mjs
# owns the credential; nothing here prints it)
if [[ -z "${E2E_UPSTREAM:-}" ]]; then
  if curl -s --max-time 2 http://localhost:8080/v1/models >/dev/null 2>&1; then
    export E2E_UPSTREAM="http://localhost:8080"
  else
    export E2E_UPSTREAM="https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode"
    export E2E_UPSTREAM_MODEL="${E2E_UPSTREAM_MODEL:-qwen3.8-flash}"
    export E2E_UPSTREAM_KEY="${E2E_UPSTREAM_KEY:-$(node -e "import('./scripts/llm.mjs').then(m=>process.stdout.write(m.apiKey()||''))" 2>/dev/null || true)}"
    [[ -z "${E2E_UPSTREAM_KEY:-}" ]] && { echo "distill: no credential for the hosted endpoint (scripts/llm.mjs found none)" >&2; exit 2; }
  fi
fi

# project:port:threshold:extra — mirrors `npm run test:e2e`'s pins exactly
declare -A PORTS=([suite]=41731 [heavy]=41733 [arrival]=41732 [enrich]=41734 [fanout]=41736 [rules]=41735 [fork]=41737 [plans]=41738)
declare -A THRESH=([suite]=0.75 [heavy]=0.5 [arrival]=0.9 [enrich]=0.9 [fanout]=0.75 [rules]=0.9 [fork]=0.75 [plans]=0.99)
declare -A EXTRA=([heavy]="E2E_FLOOR=1000000" [arrival]="E2E_FLOOR=500" [enrich]="E2E_ENRICH=1" [plans]="E2E_NO_AUX_MODEL=1")
ORDER=(suite heavy arrival enrich fanout rules fork plans)
want=("${@:-}")
[[ -z "${want[0]:-}" ]] && want=("${ORDER[@]}")

declare -a failed=()
for proj in "${want[@]}"; do
  if [[ -z "${PORTS[$proj]:-}" ]]; then
    echo "distill: unknown project '$proj' (known: ${ORDER[*]})" >&2; failed+=("$proj:unknown"); continue
  fi
  echo "=== distill $proj — port ${PORTS[$proj]}, threshold ${THRESH[$proj]} ${EXTRA[$proj]:-} ==="
  [[ "${KEEP_TAPES:-}" == "1" ]] || rm -rf "tests/fixtures/model-tape/$proj"
  # shellcheck disable=SC2086
  # FULL output to a per-leg file, never through `tail`: #54 measured a leg that produced no
  # tape entry for 20 minutes while the runner buffered every line until the leg ENDED — so
  # "progressing or hung?" was unanswerable from the artifacts this script itself produces.
  mkdir -p var/distill
  leg_log="var/distill/${proj}-$(date +%H%M%S).log"
  started=$(date +%s)
  env E2E_MODEL=record E2E_PORT="${PORTS[$proj]}" E2E_THRESHOLD="${THRESH[$proj]}" E2E_TAPE="$proj" ${EXTRA[$proj]:-} \
    timeout "${DISTILL_TIMEOUT:-1800}" npx playwright test -c tests/e2e/playwright.config.ts --project="$proj" > "$leg_log" 2>&1 &
  leg_pid=$!
  # heartbeat: tape entries + last upstream journal line, every 60s. A stall becomes
  # visible AS a stall instead of being inferred from silence an hour later.
  while kill -0 "$leg_pid" 2>/dev/null; do
    sleep 60
    kill -0 "$leg_pid" 2>/dev/null || break
    hn=$(find "tests/fixtures/model-tape/$proj" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    hj=$(tail -1 var/e2e-upstream.log 2>/dev/null | cut -c1-120)
    echo "    …${proj} +$(( $(date +%s) - started ))s tapeEntries=${hn} | upstream: ${hj:-no journal yet}"
  done
  wait "$leg_pid"; rc=$?
  echo "    full leg output: ${leg_log}"
  if [[ "$rc" -ne 0 ]]; then
    echo "    --- last 12 lines of ${leg_log} ---"; tail -12 "$leg_log" 2>/dev/null | sed 's/^/    /'
    echo "    --- upstream journal tail ---"; tail -6 var/e2e-upstream.log 2>/dev/null | sed 's/^/    /'
  fi
  n=$(find "tests/fixtures/model-tape/$proj" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  echo "--- $proj: exit=$rc tapeEntries=$n"
  [[ "$rc" -ne 0 ]] && failed+=("$proj")
done
echo
if [[ ${#failed[@]} -eq 0 ]]; then echo "distill: all requested projects recorded"; else echo "distill FAILED: ${failed[*]}"; exit 1; fi
