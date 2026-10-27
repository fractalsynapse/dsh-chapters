#!/usr/bin/env bash
# Replay the acceptance corpus one journey per boot.                                        #129, #56
#
# `npm run test:e2e` hands every project to a single Playwright invocation, but `globalSetup` boots exactly one
# server — with the DEFAULT project's regime and a single `var/e2e-boot.json` handoff — because Playwright applies
# a project's `env` to workers, not to setup. So in a shared run every other spec reads session logs out of a home
# that is not its own, and a leg can pass alone and fail in the batch (`arrival` did exactly that: ✘✘✓ on identical
# inputs). This script runs each project the way `scripts/distill-tapes.sh` records it: one boot, one journey, one
# port, one store — the same shape the tape was captured in.
#
# Usage: scripts/chain-replay.sh [leg …]     (default: every project in RIG_PINS, in Playwright's order)
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SRC"

# The project list comes from the pins table — the same authority the boot reads — never a second list here.
LEGS=$(node -e '
  import("./tests/e2e/rig-pins.ts").then((m) => {
    const order = ["suite", "heavy", "arrival", "enrich", "fanout", "rules", "fork", "plans", "prompt", "prompt-off"];
    console.log(order.filter((k) => m.RIG_PINS[k] !== undefined).join(" "));
  }).catch(() => console.log(""));
' --experimental-strip-types 2>/dev/null)
if [[ -z "${LEGS// /}" ]]; then
  echo "[chain-replay] FATAL: could not read the project list from tests/e2e/rig-pins.ts" >&2
  exit 2
fi
[[ $# -gt 0 ]] && LEGS="$*"

echo "[chain-replay] projects (one boot each): $LEGS"
FAILED=()
for leg in $LEGS; do
  printf '%s: ' "$leg"
  PORT=$(node --experimental-strip-types -e "
    import('./tests/e2e/rig-pins.ts').then((m) => process.stdout.write(String(m.RIG_PINS['$leg']?.port ?? '')));
  " 2>/dev/null)
  if LEG=$leg MODE=replay timeout 1200 bash scripts/e2e-one.sh > "var/chain-replay-$leg.log" 2>&1; then
    echo "ok (boot port ${PORT:-?})"
  else
    echo "FAILED (boot port ${PORT:-?}) — var/chain-replay-$leg.log"
    FAILED+=("$leg")
    tail -4 "var/chain-replay-$leg.log" | sed 's/^/    /' | cut -c1-140
  fi
  # Strays from a killed leg hold the next leg's ports, which turns one failure into a cascade of meaningless
  # ones (measured repeatedly on this branch): clear by cwd so only this rig's processes are touched.
  for p in $(pgrep -f "dsh web --port 4173" 2>/dev/null); do
    case "$(readlink /proc/$p/cwd 2>/dev/null)" in "$SRC"*) kill "$p" 2>/dev/null || true ;; esac
  done
  sleep 2
done

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "[chain-replay] FAILED: ${FAILED[*]}"
  exit 1
fi
echo "[chain-replay] all ${LEGS// /} legs replayed green, each under its own boot"
