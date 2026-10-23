#!/usr/bin/env bash
# Fail only on GROWTH of tests/e2e type errors (#83), so the gate is real today instead of waiting
# for a cleanup that has never happened on its own. Shrinking is the desired direction and only ever
# prints a suggestion.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/var/toolchain/node-v24.22.0-linux-x64/bin:$PATH"
BASE=$(node -e "console.log(require('./tests/e2e/typecheck-baseline.json').errors)")
OUT=$(npx tsc -p tsconfig.e2e.json --noEmit 2>&1 | grep -cE "error TS" || true)
echo "e2e typecheck: $OUT errors (baseline $BASE)"
if [ "$OUT" -le "$BASE" ]; then
  if [ "$OUT" -lt "$BASE" ]; then
    echo "::notice::tests/e2e type errors fell to $OUT — lower tests/e2e/typecheck-baseline.json in this PR (a ratchet only counts if someone tightens it)"
  fi
  exit 0
fi
echo "::error::tests/e2e grew from $BASE to $OUT type errors. tsc's project config excludes this directory and Playwright never type-checks specs, so this is where a 'cannot find name' class bug hides (#83; measured: \`rotated is not defined\` cost a nine-leg re-record)."
npx tsc -p tsconfig.e2e.json --noEmit 2>&1 | grep -E "error TS" | head -25
exit 1
