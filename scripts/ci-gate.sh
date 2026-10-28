#!/usr/bin/env bash
# scripts/ci-gate.sh — run the deterministic coverage gate and, when it fails,
# put the WHY into the run's annotations.
#
# Why this exists (measured 2026-10-10, the 0.1.6 ship): `npm run coverage:ci`
# exits 1 with its whole diagnosis on stdout, the `test summary` step is gated
# `if: always()`… no it wasn't — it was a plain step, so a red gate SKIPPED it and
# the job's only surviving artifact was a 5.7 MB coverage bundle that the API
# serves behind a token. A maintainer watching from the API (or from a phone) got
# "Process completed with exit code 1" and nothing else, while the same commit
# passed on every local reproduction. The gate must state, in the annotations:
# which metric fell under the threshold, and which tests failed.
#
# Behaviour: runs the gate, tees its output to var/ci-gate.log, and on failure
# emits ::error:: lines (coverage totals + up to 20 failing-test lines) before
# re-exiting with the gate's own code. On success it prints one summary line.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p var

STATUS=0
npm run coverage:ci 2>&1 | tee var/ci-gate.log || STATUS=$?

# Name what skipped, and why. A gate that reports "skipped 19" is reporting an unknown: the same suite run on a
# developer machine skips 0 and passes the coverage threshold, while CI skips 19 and misses it by hundredths of a
# percent. The skips are almost certainly host-bundle lookups, and the row that skips already prints its own
# reason — this surfaces it as a notice so the next reader sees the cause instead of the count. It never changes
# the exit status: a skip is information, and lowering a gate to accommodate one is not the fix.
if [[ -s var/ci-gate.log ]]; then
  SKIP_LINES=$(grep -aE "# SKIP|skipped .*host bundle|not readable from any of" var/ci-gate.log | head -20 || true)
  SKIP_COUNT=$(printf '%s\n' "$SKIP_LINES" | grep -ac "SKIP" || true)
  if [[ -n "$SKIP_LINES" ]]; then
    printf '::notice::ci-gate: %s skipped-test reasons surfaced (a local run skips 0; each skip removes source branches from the gate):\n%s\n' "${SKIP_COUNT}" "$(printf '%s' "$SKIP_LINES" | head -12 | tr '\n' '|')"
  fi
fi

if [[ "$STATUS" -eq 0 ]]; then
  grep -E "^Statements|^Branches|^Functions|^Lines" var/ci-gate.log | sed 's/^/::notice::coverage gate /' || true
  echo "ci-gate: green (exit 0)"
  exit 0
fi

echo "::error::ci-gate: coverage:ci exited $STATUS"
# The four metric lines, if c8 printed them (a hard test failure can stop before).
grep -E "^(Statements|Branches|Functions|Lines) *:" var/ci-gate.log | while read -r line; do
  echo "::error::ci-gate ${line}"
done || true
# The tally line and every failing test, capped so the annotation list stays readable.
grep -E "^ℹ (tests|pass|fail|skipped)|^# (tests|pass|fail|skipped)|^not ok|^✖" var/ci-gate.log | head -24 | while read -r line; do
  echo "::error::ci-gate ${line}"
done || true
# The threshold verdict c8 writes when a metric, not a test, is the culprit.
grep -iE "ERROR: Coverage|does not meet threshold" var/ci-gate.log | head -5 | while read -r line; do
  echo "::error::ci-gate ${line}"
done || true
# Where the failure lives, even when the reporter hides the name: the first error
# frames in file order.
grep -nE "AssertionError|Error: at |TypeError|ERR_ASSERTION" var/ci-gate.log | head -8 | while read -r line; do
  echo "::error::ci-gate ${line:0:300}"
done || true
exit "$STATUS"
