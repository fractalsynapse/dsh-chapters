#!/usr/bin/env bash
# distill-tapes — re-record the acceptance corpus, one project at a time (#54).
#
# Why a script instead of `npm run test:e2e:record`: that target chains eight projects with
# `&&`, so the FIRST failure hides the other seven and the run tells you nothing about the
# rest. A re-distill is exactly the run where you want every project's verdict. Each project
# gets its own boot, port and pins (the same env the npm script uses), and its tape directory
# is cleared first — a stale entry from another host is a prefix collision waiting to happen.
#
#   scripts/distill-tapes.sh                     # all legs, sequential
#   scripts/distill-tapes.sh fork rules          # just these
#   KEEP_TAPES=1 scripts/distill-tapes.sh rules  # archive onto the existing tape, don't clear
#
# #411: every green RECORD is followed IN THIS SCRIPT by a strict REPLAY of the same leg — the
# tape's own acceptance. (Race-prone legs note: the replayed call-SET can differ machine to machine —
# a record that races away a call may pass its own replay and still MISS on a faster runner. The
# committed corpus is therefore the healed SUPERSET: extra keyed entries cost a replay nothing when
# the call never fires, a missing one fails the leg. If a fresh re-record would drop entries a prior
# heal proved, KEEP the superset — the green verdict stands on the superset too.) A failing replay with new MISS lines earns exactly one bounded heal
# (against the leg's own upstream) and a second replay must pass; a failing replay WITHOUT misses
# is a leg failure, never healed. Verdicts read `record+replay green (N entries)`. Classification
# lives in scripts/distill-replay-guard.mjs (pure, unit-tested).
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
declare -A PORTS=([suite]=41731 [heavy]=41733 [arrival]=41732 [enrich]=41734 [fanout]=41736 [rules]=41735 [fork]=41737 [plans]=41738 [prompt]=41739 [prompt-off]=41740 [prompt-revival]=41743)
# #56: THRESHOLD/EXTRA tables DELETED. The regime lives in `playwright.config.ts` as
# per-project `env`, because three copies (this file, `npm run test:e2e`, boot defaults) had
# silently diverged: replay booted suite/rules/fork with no threshold while distill had recorded
# them at 0.75/0.9/0.75 — a different realm than the tape, so the surface diverged and replay
# MISSed. PORTS below is display-only; a row asserts it still agrees with the config's env.
trap 'stop_stub' EXIT
# prompt-off is the switch's OFF half (#113): it has its own port, boot, and tape, so it distills like any leg.
ORDER=(suite heavy arrival enrich fanout rules fork plans prompt prompt-off prompt-revival)

# #56, measured: `plans` and `prompt` MUST be recorded through the scripted stub
# (tests/e2e/stub-model.ts, :8081). Their PROVENANCE.md files say so, and the reason is the
# product's: a tape must not freeze one model's decision to plan, and `prompt`'s assertion
# compares a CONSTANT only the stub's `suggest` arm mints. Tonight the endpoint resolution above
# sent them to the hosted model (nothing pinned or started :8081), so `prompt` failed an
# unsatisfiable line and `plans` recorded a real model's improvisation. These two legs own their
# upstream: start the stub, pin it, stop it — and fail loudly if it will not come up.
STUB_PROJECTS="plans prompt prompt-revival"
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
    # #409: the marker travels with the pin — one coupled source. boot.ts honors E2E_STUB_LEG only
    # against a stub-CLASS endpoint (all listed ids `stub-`-prefixed), and a live leg pointed at the
    # stub still refuses. Without this line, the #406 guard rejects the rig's OWN stub-path distill.
    leg_extra="${leg_extra} E2E_UPSTREAM=http://127.0.0.1:${STUB_PORT} E2E_STUB_LEG=1"
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
  # ── #411: a green RECORD is only half a verdict. The tape is proven by the strict REPLAY that
  # follows it: measured at #340's re-anchor, one call (the post-Run regeneration) won at replay's
  # instant cache but lost the teardown race at record time — invisible to the recording itself.
  # Now every green record is followed by an immediate strict replay; a failing replay WITH new
  # MISS lines gets exactly one bounded heal against the leg's own upstream (deterministic by
  # construction), then a second replay must pass. A failing replay WITHOUT new misses is a leg
  # failure, not a corpus gap — healing it would paper a defect onto the tape. The classification
  # table is pure and unit-tested (scripts/distill-replay-guard.mjs, tests/unit/…-guard.test.ts).
  final_rc=$rc
  verdict="exit=$rc tapeEntries=$n"
  if [[ "$rc" -eq 0 && "$n" -gt 0 ]]; then
    miss_before=$( { grep -c "MISS tape=${proj} " var/e2e-tape-misses.log 2>/dev/null || true; } | tr -d '[:space:]')
    timeout "${DISTILL_TIMEOUT:-1800}" env E2E_MODEL=replay npx playwright test -c tests/e2e/playwright.config.ts --project="$proj" > "var/distill/${proj}-replay-$(date +%H%M%S).log" 2>&1
    rrc=$?
    miss_after=$( { grep -c "MISS tape=${proj} " var/e2e-tape-misses.log 2>/dev/null || true; } | tr -d '[:space:]')
    nmiss=$(( ${miss_after:-0} - ${miss_before:-0} )); [[ $nmiss -lt 0 ]] && nmiss=0
    out=$(node --input-type=module -e "
      import { classifyLeg } from './scripts/distill-replay-guard.mjs';
      const v = classifyLeg({ recordRc: 0, entries: $n, replayRc: $rrc, newMisses: $nmiss });
      process.stdout.write(v.action + '|' + v.verdict)")
    action="${out%%|*}"; verdict="${out#*|}"
    if [[ "$action" == "heal" ]]; then
      echo "    $proj: $verdict"
      # one bounded heal — the leg's OWN upstream: the stub restarts for stub legs, live legs reuse
      # the exported E2E_UPSTREAM. KEEP-style: the heal appends; it never clears.
      if [[ " ${STUB_PROJECTS} " == *" ${proj} "* ]]; then
        if ! start_stub "${proj}-heal"; then failed+=("${proj}:stub-down"); final_rc=1; fi
      fi
      if [[ "$final_rc" -eq 0 ]]; then
        timeout "${DISTILL_TIMEOUT:-1800}" env E2E_MODEL=replay E2E_TAPE_FALLBACK=1 ${leg_extra:-} \
          npx playwright test -c tests/e2e/playwright.config.ts --project="$proj" > "var/distill/${proj}-heal-$(date +%H%M%S).log" 2>&1
        hrc=$?
        [[ "$hrc" -ne 0 ]] && { verdict="heal pass exit=$hrc"; final_rc=1; }
      fi
      stop_stub
      if [[ "$final_rc" -eq 0 ]]; then
        n=$(find "tests/fixtures/model-tape/$proj" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
        miss_before=$( { grep -c "MISS tape=${proj} " var/e2e-tape-misses.log 2>/dev/null || true; } | tr -d '[:space:]')
        timeout "${DISTILL_TIMEOUT:-1800}" env E2E_MODEL=replay npx playwright test -c tests/e2e/playwright.config.ts --project="$proj" > "var/distill/${proj}-replay2-$(date +%H%M%S).log" 2>&1
        rrc2=$?
        miss_after=$( { grep -c "MISS tape=${proj} " var/e2e-tape-misses.log 2>/dev/null || true; } | tr -d '[:space:]')
        nmiss2=$(( ${miss_after:-0} - ${miss_before:-0} )); [[ $nmiss2 -lt 0 ]] && nmiss2=0
        out=$(node --input-type=module -e "
          import { classifyLeg } from './scripts/distill-replay-guard.mjs';
          const v = classifyLeg({ recordRc: 0, entries: $n, replayRc: $rrc2, newMisses: $nmiss2, healed: true });
          process.stdout.write(v.action + '|' + v.verdict)")
        action="${out%%|*}"; verdict="${out#*|}"
      fi
    fi
    if [[ "$action" == "pass" ]]; then final_rc=0; else final_rc=1; fi
  fi
  echo "--- $proj: ${verdict} (#411 record+replay gate)"
  # Provenance is GENERATED, not hand-authored: the `rm -rf` above destroys whatever was in the
  # project directory, and hand-written PROVENANCE.md files (plans, prompt — the records saying
  # those legs come from the scripted stub, not a live model) were deleted by exactly that on the
  # re-anchor (#56). One line per leg, with the verdict only the runner knows.
  node --experimental-strip-types scripts/write-provenance.mjs --project "$proj" --verdict "$verdict" \
    >/dev/null 2>&1 || echo "    distill: provenance regeneration FAILED for $proj" >&2
  [[ "$final_rc" -ne 0 ]] && failed+=("$proj")
done
echo
if [[ ${#failed[@]} -eq 0 ]]; then echo "distill: all requested projects recorded"; else echo "distill FAILED: ${failed[*]}"; exit 1; fi
