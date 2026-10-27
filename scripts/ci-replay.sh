#!/usr/bin/env bash
# CI acceptance: replay the committed model tapes — no local model, no GPU, no
# LLM API key. Every model turn is served by tests/e2e/model-proxy.ts from the
# committed corpus under tests/fixtures/model-tape/<project>/ (nine projects:
# suite, fork, heavy, arrival, enrich, fanout, rules, plans, prompt). A tape MISS is a loud proxy
# 503 that fails the run; with E2E_MODEL=replay (and no E2E_TAPE_FALLBACK=1)
# the proxy never reaches a live server — this proves the acceptance suite
# green on a machine with no model present.
#
# Prerequisites, verified below, failing LOUDLY (never skipped) if unmet:
#   - the pinned DSH host on PATH (the e2e boot spawns the INSTALLED `dsh`,
#     not a devDependency) — installed project-scoped in its own prefix (see
#     ci.yml's tree-shape note; plain `npm i -g` yields a broken host tree)
#   - Playwright chromium (this script installs it into var/ms-playwright)
#   - the host itself comes from dev/dsh-host-lock (npm ci, hermetic lock)
#   - git with the http-backend (knowledge.spec drives a real smart-HTTP
#     remote; ubuntu-latest ships it)
set -euo pipefail
cd "$(dirname "$0")/.."

# ONE source of truth for the host version this plugin is verified against — and it is
# the host LOCK, not a literal here. The comment used to claim "one source" while a second
# copy of the version sat in this file next to dev/dsh-host-lock/package.json and
# .github/workflows/ci.yml, which is precisely how #54 found the pin stale in three places:
# the lock moves, the chain does not, and the mismatch check then (correctly) refuses to run.
# Bump deliberately: change dev/dsh-host-lock/package.json, resolve, re-distill the tapes.
DSH_HOST_VERSION="${DSH_HOST_VERSION:-$(node -p "require('./dev/dsh-host-lock/package.json').dependencies['@deepseek-ai/dsh']")}"

command -v dsh >/dev/null 2>&1 || {
  echo "ci-replay: 'dsh' not on PATH. Install the hermetic host lock first:" >&2
  echo "           (cd dev/dsh-host-lock && npm ci)  # then put its node_modules/.bin on PATH" >&2
  exit 2
}
INSTALLED="$(dsh --version 2>&1 | tr -d '[:space:]')"
if [[ "$INSTALLED" != "$DSH_HOST_VERSION" ]]; then
  echo "ci-replay: dsh on PATH is '$INSTALLED'; this plugin is verified against '$DSH_HOST_VERSION'." >&2
  echo "           npm i -g @deepseek-ai/dsh@$DSH_HOST_VERSION" >&2
  exit 2
fi

# Host-tree sanity: npm's hoisting has proven version-sensitive (npm 11 dropped
# the whole sandbox family). Fail HERE with a diagnosis, not in a 60s boot
# timeout with a truncated log.
# The host's plugins live in the node_modules NEAR the dsh binary — works for
# both install shapes (global: <prefix>/lib/node_modules/.bin; isolated
# project-scope: <prefix>/node_modules/.bin).
DSH_REAL="$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)"
case "$DSH_REAL" in
  */node_modules/@deepseek-ai/dsh/*) NM_DIR="${DSH_REAL%/node_modules/@deepseek-ai/dsh/*}/node_modules" ;;
  *)                                 NM_DIR="$(dirname "$(dirname "$DSH_REAL")")/node_modules" ;;
esac
if [[ ! -d "$NM_DIR/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sandbox-local" && ! -d "$NM_DIR/@deepseek-ai/dsh-sandbox-local" ]]; then
  echo "ci-replay: the dsh tree beside $NM_DIR is missing @deepseek-ai/dsh-sandbox-local." >&2
  echo "           npm's GLOBAL mode rewrites the host tree (see ci.yml install note);" >&2
  echo "           install project-scoped, one package per prefix." >&2
  exit 2
fi

rm -f var/e2e-tape-misses.log var/e2e-engine-errors*.log 2>/dev/null || true
npm ci
npm run build

# The e2e boot copies a scratch DSH home (profile + link-installed plugin +
# chapters preset) from .dshdev-local; build it if the checkout lacks it.
[[ -d .dshdev-local ]] || bash scripts/bootstrap-dev-profile.sh --home .dshdev-local

# Chromium for Playwright, cached in the workspace so it survives across steps.
PLAYWRIGHT_BROWSERS_PATH="$PWD/var/ms-playwright" npx playwright install chromium

# Strict tape replay across all NINE projects (seven model-distilled + the plans
# carriage and the prompt ghost, whose tapes are scripted-upstream distilled —
# tests/fixtures/model-tape/*/PROVENANCE.md); any miss fails the chain.
#
# A red chain has to name its project (the lesson of the 0.1.9 ship): playwright's
# diagnosis goes to stdout, the job's other artifact is behind a token, and "Process
# completed with exit code 1" is not a bug report. The proxy journals every miss with
# the prefixes it compared — that journal is the thing a maintainer needs.
STATUS=0
E2E_MODEL=replay npm run test:e2e 2>&1 | tee var/ci-replay.log || STATUS=${PIPESTATUS[0]}
if [[ "$STATUS" -ne 0 ]]; then
  # ONE annotation, not twenty. GitHub truncates a check run to 10 annotations, and
  # the 97bd603 run proved what that costs: the boot-pin lines and the ✘ consumed
  # the budget, and the actual `Error:` text — the only thing I was chasing — was
  # silently dropped. A single multi-line message (newlines %-encoded) cannot be
  # truncated into meaninglessness.
  # Order matters because GitHub truncates an oversized annotation to its FIRST line: the 97bd603 run proved
  # that the details I most needed were the ones dropped. So the header states what happened, the rig-fault and
  # MISS lines come next (the tape key is the thing being chased), then assertion text, then the bulkier
  # artifacts last — and the whole message is capped so a long tail cannot cost the head.
  DIAG="ci-replay: tape replay exited $STATUS"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    DIAG+=$'\n'"${line:0:280}"
  done < <(
    grep -E "RIG FAULT|MISS tape=|No tests found|[0-9]+ failed" var/ci-replay.log | tail -6
    # Unconditional tail: every targeted grep above can legitimately match nothing (a failure that died in the
    # boot, a spec timeout whose summary line differs, a grep I have not thought of yet). A header-only
    # annotation teaches nothing, so the last lines of the run always ride along.
    echo "— raw tail of var/ci-replay.log"
    tail -12 var/ci-replay.log
    grep -E "^\[e2e\] boot pins" var/ci-replay.log | tail -2
    grep -E "✘|Error:|expect\(|Received:|Expected:|falling back to an ephemeral|reaped orphan" var/ci-replay.log | head -14
    # playwright's own saved context: the snippet plus the page snapshot, i.e. the
    # difference between "an assertion failed" and why it failed.
    for f in $(ls -1 test-results/*/error-context.md 2>/dev/null | head -2); do
      echo "— $f"
      head -24 "$f"
    done
    for f in var/e2e-engine-errors-*.log; do
      [[ -s "$f" ]] || continue
      echo "— $f"
      tail -4 "$f"
    done
    if [[ -s var/e2e-tape-misses.log ]]; then
      echo "— tape misses"
      tail -4 var/e2e-tape-misses.log
    fi
  )
  DIAG=$(printf '%s' "$DIAG" | sed -e 's/%/%25/g' -e 's/$/%0A/' | tr -d '\n')
  DIAG=${DIAG%$'%0A'}
  echo "::error::${DIAG:0:16000}"
  exit "$STATUS"
fi
echo "ci-replay: PASS — nine browser projects replayed green on committed tapes, no LLM present."
