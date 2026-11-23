#!/usr/bin/env bash
# corpus-campaign — #456 Tier B driver: re-distill the acceptance corpus, prove it by
# paired replay, stamp it. One build per corpus (#90) is enforced by owning the whole
# chain: build once, distill every project (own boot/port/cleared tape dir per
# distill-tapes law), replay each leg TWICE, and stamp ONLY a corpus both passes prove.
# A failed campaign never stamps — the previous corpus stays, and the manifest says so.
#
# Model reachability is NOT re-implemented here: boot resolves and credential-checks the
# harness-native route and refuses without it (#54's law, session.ts localModelUp).
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/var/toolchain/node-v24.22.0-linux-x64/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$PWD/var/ms-playwright}"
MANIFEST="var/corpus-campaign-$(date -u +%Y%m%dT%H%M%SZ).md"
LOG() { echo "$1" | tee -a "$MANIFEST"; }

{ echo "# corpus campaign manifest"; echo "started: $(date -u +%FT%TZ)"; echo "git: $(git rev-parse --short HEAD)"; echo "dirty-tree: $([[ -n $(git status --porcelain) ]] && echo yes-records-this || echo no)"; } > "$MANIFEST"

node ./node_modules/typescript/bin/tsc -p tsconfig.json 2>&1 | tail -1 | tee -a "$MANIFEST"

if bash scripts/distill-tapes.sh > var/campaign-distill.log 2>&1; then DISTILL=ok; else DISTILL=fail; fi
LOG "distill: ${DISTILL} (full log var/campaign-distill.log)"
tail -20 var/campaign-distill.log >> "$MANIFEST"

if [ "$DISTILL" = "ok" ]; then
  for PASS in 1 2; do
    if bash scripts/chain-replay.sh > "var/campaign-replay-${PASS}.log" 2>&1; then
      LOG "replay pass ${PASS}: ok"
    else
      LOG "replay pass ${PASS}: FAIL —"
      grep -E 'FAILED|failed' "var/campaign-replay-${PASS}.log" | head -8 >> "$MANIFEST"
    fi
  done
else
  LOG "replay: BLOCKED (distill failed — a corpus that cannot be recorded cannot be certified by replay)"
fi

if grep -q 'replay pass 1: ok' "$MANIFEST" && grep -q 'replay pass 2: ok' "$MANIFEST"; then
  npm run corpus:stamp 2>&1 | tail -1 | tee -a "$MANIFEST"
  npm run corpus:check 2>&1 | tail -1 | tee -a "$MANIFEST"
  LOG "RESULT: CAMPAIGN GREEN — re-distilled, paired-replay proven, stamped"
else
  LOG "RESULT: CAMPAIGN RED — previous corpus+stamp stay in place (never stamp what you cannot replay)"
fi
echo "manifest: $MANIFEST"
