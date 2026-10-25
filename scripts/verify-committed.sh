#!/usr/bin/env bash
# verify-committed.sh — check the COMMITTED tree, not the working directory (2026-10-25).
#
# Why this exists: a merge-conflict resolution was staged, then the file was edited further, and `git commit`
# recorded the STAGED blob. Local `npm run typecheck`, `typecheck:client`, the whole deterministic plane, and
# the build all ran against a clean working tree, so everything said green — while the pushed commit contained
# `=======` and `>>>>>>> origin/staging` and CI's build failed with `[PARSE_ERROR] Encountered diff marker`.
# Every one of those checks is correct and none of them can see the bug, because they read files I had already
# fixed. The only thing that matters is what HEAD says.
#
# Usage: bash scripts/verify-committed.sh   (run it BEFORE pushing, after every commit)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

REF="${1:-HEAD}"
fail=0

# 1. no conflict markers anywhere in the committed tree — the exact defect that reached GitHub.
if markers=$(git grep -nE '^(<<<<<<< |>>>>>>> |=======$)' "$REF" -- . 2>/dev/null); then
  echo "FAIL: conflict markers in the committed tree:"; echo "$markers" | head -20; fail=1
else
  echo "ok: no conflict markers in $REF"
fi

# 2. no staged-but-uncommitted work hiding a different file from the one just committed.
if ! git diff-index --quiet --cached "$REF" -- 2>/dev/null; then
  echo "FAIL: the index differs from $REF — you committed a staged snapshot that has since been edited"; fail=1
else
  echo "ok: index matches $REF"
fi
if ! git diff-index --quiet "$REF" -- 2>/dev/null; then
  echo "note: working tree differs from $REF (uncommitted edits — they are NOT in what you push)"
fi

# 3. build and check the COMMITTED bytes in a scratch checkout, so a clean tree cannot mask a bad commit.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/verify-committed-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
git archive "$REF" | tar -x -C "$SCRATCH"
for link in node_modules var; do
  [ -e "$link" ] && ln -s "$(pwd)/$link" "$SCRATCH/$link"
done
cd "$SCRATCH"
export PATH="$(pwd)/var/toolchain/node-v24.22.0-linux-x64/bin:${PATH}"
echo "--- typecheck (committed bytes) ---"; npm run typecheck >/dev/null 2>&1 && echo "ok" || { echo "FAIL"; fail=1; }
echo "--- typecheck:client (committed bytes) ---"; npm run typecheck:client >/dev/null 2>&1 && echo "ok" || { echo "FAIL"; fail=1; }
echo "--- build (committed bytes) ---"; npm run build >/dev/null 2>&1 && echo "ok" || { echo "FAIL"; fail=1; }

if [ "$fail" -eq 0 ]; then echo "verify-committed: $REF is clean — safe to push"; else echo "verify-committed: $REF would fail CI"; exit 1; fi
