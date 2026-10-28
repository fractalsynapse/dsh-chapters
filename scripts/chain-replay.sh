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
# #141: `heavy` is deliberately ABSENT from this list — it is a live-class leg now (see its spec's guard): relief
# auto-continues a model-written turn, so its request count is run-dependent (measured 5/7/12/23/24 entries for ONE
# commit across four designs, with CI's own widened miss diff naming the extra turn). These nine are the model-free
# acceptance set. Keep this comment OUTSIDE the node -e below: a `//` inside the quoted snippet is shell, not JS, and
# the bash parser dies on it ("line 21: syntax error near unexpected token `('") — measured on run 40780981969.
LEGS=$(node -e '
  import("./tests/e2e/rig-pins.ts").then((m) => {
    const order = ["suite", "arrival", "enrich", "fanout", "rules", "fork", "plans", "prompt", "prompt-off"];
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
  # Memory available at each boot, logged unconditionally: a leg that fails deep in a nine-boot sequence needs to
  # be distinguishable from a machine that simply ran out of room, and "rows (0), current session: null" reads
  # differently at 6 GB free than at 200 MB.
  MEM=$(awk '/MemAvailable/ {printf "%.1fGB", $2/1048576}' /proc/meminfo 2>/dev/null || echo '?')
  printf '%s [mem %s]: ' "$leg" "$MEM"
  PORT=$(node --experimental-strip-types -e "
    import('./tests/e2e/rig-pins.ts').then((m) => process.stdout.write(String(m.RIG_PINS['$leg']?.port ?? '')));
  " 2>/dev/null)
  if LEG=$leg MODE=replay E2E_MODEL=replay timeout 1200 bash scripts/e2e-one.sh > "var/chain-replay-$leg.log" 2>&1; then
    echo "ok (boot port ${PORT:-?})"
  else
    echo "FAILED (boot port ${PORT:-?}) — var/chain-replay-$leg.log"
    FAILED+=("$leg")
    tail -4 "var/chain-replay-$leg.log" | sed 's/^/    /' | cut -c1-140
  fi
  # Carry the throwaway home's durable logs into the workspace so they reach the CI artifact. E2E_HOME lives under
  # /tmp, OUTSIDE the repo, so every diagnostic uploaded so far has been blind to the one thing that settles
  # "did this session already contain a tool turn": the runner's own session log. Measured need: CI reported a
  # 4-message request whose msg2 held a `glob` call while the capture's first request has no call at that index,
  # and `findReplay` requires equal prefix length, so prefix collision is impossible — the remaining explanation
  # is state in the booted session, which is exactly what these files can prove or kill. Bounded per leg.
  for src_home in /tmp/dsh-e2e/e2e-home-417[0-9][0-9]; do
    [[ -d "$src_home/sessions" ]] || continue
    port_part=$(basename "$src_home" | sed 's/e2e-home-//')
    [[ "$port_part" == "${PORT:-}" ]] || continue
    dest="var/e2e-session-logs/$leg-$port_part"
    mkdir -p "$dest" 2>/dev/null || continue
    find "$src_home/sessions" -name 'session.v4.jsonl.zstd' -size -4M 2>/dev/null | head -6 |
      while read -r f; do cp "$f" "$dest/$(basename "$(dirname "$f")").zstd" 2>/dev/null || true; done
    cp "$src_home/sessions"/*/registry.json "$dest/registry.json" 2>/dev/null || true
  done

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
