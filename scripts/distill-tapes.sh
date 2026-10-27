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

# project:port — DISPLAY ONLY (the boot port comes from the project env in playwright.config.ts)
declare -A PORTS=([suite]=41731 [heavy]=41733 [arrival]=41732 [enrich]=41734 [fanout]=41736 [rules]=41735 [fork]=41737 [plans]=41738 [prompt]=41739)
# #56: THRESHOLD/EXTRA tables DELETED. The regime lives in `playwright.config.ts` as
# per-project `env`, because three copies (this file, `npm run test:e2e`, boot defaults) had
# silently diverged: replay booted suite/rules/fork with no threshold while distill had recorded
# them at 0.75/0.9/0.75 — a different realm than the tape, so the surface diverged and replay
# MISSed. PORTS below is display-only; a row asserts it still agrees with the config's env.
trap 'stop_stub' EXIT
# prompt-off is the switch's OFF half (#113): it has its own port, boot, and tape, so it distills like any leg.
ORDER=(suite heavy arrival enrich fanout rules fork plans prompt prompt-off)

# #56, measured: `plans` and `prompt` MUST be recorded through the scripted stub
# (tests/e2e/stub-model.ts, :8081). Their PROVENANCE.md files say so, and the reason is the
# product's: a tape must not freeze one model's decision to plan, and `prompt`'s assertion
# compares a CONSTANT only the stub's `suggest` arm mints. Tonight the endpoint resolution above
# sent them to the hosted model (nothing pinned or started :8081), so `prompt` failed an
# unsatisfiable line and `plans` recorded a real model's improvisation. These two legs own their
# upstream: start the stub, pin it, stop it — and fail loudly if it will not come up.
STUB_PROJECTS="plans prompt"
STUB_PORT="${STUB_PORT:-8081}"
stub_pid=""
start_stub() {
  node tests/e2e/stub-model.ts > "var/stub-${1}.log" 2>&1 &
  stub_pid=$!
  for _ in $(seq 1 40); do
    if curl -s --max-time 1 "http://127.0.0.1:${STUB_PORT}/v1/models" >/dev/null 2>&1        || curl -s --max-time 1 -o /dev/null "http://127.0.0.1:${STUB_PORT}/" ; then return 0; fi
    sleep 0.5
  done
  echo "distill: the scripted stub never answered on :${STUB_PORT} — refusing to record $1 against a live model (its PROVENANCE.md forbids that)" >&2
  return 1
}
stop_stub() { if [[ -n "${stub_pid}" ]]; then kill "${stub_pid}" 2>/dev/null || true; wait "${stub_pid}" 2>/dev/null || true; stub_pid=""; fi; }
want=("${@:-}")
[[ -z "${want[0]:-}" ]] && want=("${ORDER[@]}")

declare -a failed=()
for proj in "${want[@]}"; do
  if [[ -z "${PORTS[$proj]:-}" ]]; then
    echo "distill: unknown project '$proj' (known: ${ORDER[*]})" >&2; failed+=("$proj:unknown"); continue
  fi
  leg_extra=""
  # plans/prompt own their upstream: the scripted stub, or nothing (see STUB_PROJECTS above).
  if [[ " ${STUB_PROJECTS} " == *" ${proj} "* ]]; then
    if ! start_stub "${proj}"; then failed+=("${proj}:stub-down"); continue; fi
    leg_extra="${leg_extra} E2E_UPSTREAM=http://127.0.0.1:${STUB_PORT}"
  fi
  # the header prints the EFFECTIVE regime, read from the one table the boot uses, so a tape's
  # provenance is auditable from the runner log alone (the row in distill-upstream-pins insists).
  regime=$(node --experimental-strip-types --input-type=module -e "
    const m = await import('./tests/e2e/rig-pins.ts');
    const p = m.RIG_PINS['$proj'];
    process.stdout.write(p ? 'port=' + p.port + ' threshold=' + p.threshold + (p.floor ? ' floor=' + p.floor : '') + (p.enrich ? ' enrich=1' : '') + (p.noAuxModel ? ' noAux=1' : '') + (p.promptModel ? ' prompt=1' : '') : 'UNPINNED')
  " 2>/dev/null)
  echo "=== distill ${proj} — port ${PORTS[${proj}]} regime:${regime:-UNREADABLE} ${leg_extra} ==="
  [[ "${KEEP_TAPES:-}" == "1" ]] || rm -rf "tests/fixtures/model-tape/$proj"
  # shellcheck disable=SC2086
  # FULL output to a per-leg file, never through `tail`: #54 measured a leg that produced no
  # tape entry for 20 minutes while the runner buffered every line until the leg ENDED — so
  # "progressing or hung?" was unanswerable from the artifacts this script itself produces.
  mkdir -p var/distill
  leg_log="var/distill/${proj}-$(date +%H%M%S).log"
  started=$(date +%s)
  # ${leg_extra} is the stub upstream only — the pins are the config's (#56).
  env E2E_MODEL=record ${leg_extra:-} \
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
  stop_stub   # the scripted stub belongs to one leg; a leaked :8081 would mis-pin the next one
  echo "    full leg output: ${leg_log}"
  if [[ "$rc" -ne 0 ]]; then
    echo "    --- last 12 lines of ${leg_log} ---"; tail -12 "$leg_log" 2>/dev/null | sed 's/^/    /'
    echo "    --- upstream journal tail ---"; tail -6 var/e2e-upstream.log 2>/dev/null | sed 's/^/    /'
  fi
  n=$(find "tests/fixtures/model-tape/$proj" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  # A model-driven leg that recorded NOTHING did not talk to a model, whatever its exit code says:
  # a `test.skip` (unreachable upstream, missing git http-backend) yields `3 passed / 1 skipped` and
  # `exit 0`. Measured 2026-10-23: `--- suite: exit=0 tapeEntries=0` was read as green by me, for a
  # round, until a tape count was compared with an exit code. Refuse it here, in the one place that
  # summarises legs, and name the VACUOUS condition so a log scanner cannot read it as a pass.
  if [[ "$rc" -eq 0 && "$n" -eq 0 ]]; then
    echo "--- $proj: VACUOUS — exit 0 with zero tape entries (the journey never ran; refusing)" >&2
    rc=1
    failed+=("$proj:vacuous")
  fi
  echo "--- $proj: exit=$rc tapeEntries=$n"
  # Provenance is GENERATED, not hand-authored: the `rm -rf` above destroys whatever was in the
  # project directory, and hand-written PROVENANCE.md files (plans, prompt — the records saying
  # those legs come from the scripted stub, not a live model) were deleted by exactly that on the
  # re-anchor (#56). One line per leg, with the verdict only the runner knows.
  node --experimental-strip-types scripts/write-provenance.mjs --project "$proj" --verdict "exit=$rc tapeEntries=$n" \
    >/dev/null 2>&1 || echo "    distill: provenance regeneration FAILED for $proj" >&2
  [[ "$rc" -ne 0 ]] && failed+=("$proj")
done
echo
if [[ ${#failed[@]} -eq 0 ]]; then echo "distill: all requested projects recorded"; else echo "distill FAILED: ${failed[*]}"; exit 1; fi
