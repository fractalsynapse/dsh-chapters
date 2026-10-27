#!/usr/bin/env bash
# Distill the tape corpus where a runner can replay it.                                    #56
#
# Why this exists, measured 2026-10-27: the SAME 33-entry `suite` tape replays GREEN from
# /home/adrian/Projects/dsh-chapters and MISSES (every entry tied, msg0 diverging) from a clean clone at
# /var/tmp/dsh-probe. The only difference is Node's module walk: from the working copy the ancestors run
# through /home/adrian/node_modules — 289 @deepseek-ai packages, including a linked dev build — while a CI
# checkout walks paths that contain nothing. Mounted bundles differ, so the composed SYSTEM HEADER differs
# (7,276 chars vs 2,783), and the header is message 0 of every request: the thing tapes are keyed on.
#
# So a corpus recorded inside the developer tree is only replayable by that machine. This script records it
# where a runner CANNOT see a developer tree, then copies back exactly one thing: tests/fixtures/model-tape.
#
# Usage: scripts/distill-in-scratch.sh [leg …]        (default: the full ORDER in distill-tapes.sh)
#         SCRATCH=/var/tmp/dsh-rig KEEP=1 scripts/distill-in-scratch.sh suite
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="${SCRATCH:-/var/tmp/dsh-rig}"
NODE_BIN="${NODE_BIN:-$SRC/var/toolchain/node-v24.22.0-linux-x64/bin}"
TAPE_REL="tests/fixtures/model-tape"

log() { printf '[scratch-distill] %s\n' "$*"; }
die() { printf '[scratch-distill] FATAL: %s\n' "$*" >&2; exit 2; }

# Guard 1: the scratch path must not sit under the developer's home. Nothing else about it matters — the whole
# point is an ancestor chain with no node_modules.
case "$SCRATCH" in
  "$HOME"|"$HOME"/*) die "SCRATCH=$SCRATCH is under \$HOME; the ancestor walk would reach the developer's node_modules and prove nothing" ;;
esac
[[ -d "$SCRATCH" || -d "$(dirname "$SCRATCH")" ]] || die "parent of $SCRATCH does not exist"

# Guard 2: assert the ancestor chain is actually clean. If a future host puts node_modules at / or /var/tmp,
# this script's premise is void and it should say so instead of producing a corpus that only replays here.
# Start at the PARENT: the clone's own node_modules is legitimate — CI installs it — and my first version
# refused the scratch path because of it, which is a guard that rejects its own premise. What must be clean is
# every ancestor above the checkout.
probe="$(dirname "$SCRATCH")"; while [[ "$probe" != "/" ]]; do
  if [[ -d "$probe/node_modules/@deepseek-ai" ]]; then
    die "ancestor $probe/node_modules/@deepseek-ai exists — this path is NOT CI-shaped; choose another SCRATCH"
  fi
  probe="$(dirname "$probe")"
done
[[ -d "/node_modules/@deepseek-ai" ]] && die "root filesystem has @deepseek-ai packages; no CI-shaped path exists"

command -v rsync >/dev/null || die "rsync is required"
[[ -x "$NODE_BIN/node" ]] || die "pinned node missing at $NODE_BIN/node"
export PATH="$NODE_BIN:$PATH"

log "syncing working tree (uncommitted state included) to $SCRATCH"
mkdir -p "$SCRATCH"
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'var' --exclude '.dshdev-local' --exclude '.dsh-chapters' \
  --exclude 'dist' --exclude 'test-results' --exclude 'playwright-report' \
  "$SRC/" "$SCRATCH/" || die "rsync to $SCRATCH failed"

log "installing exactly CI's steps (pinned host lock, then repo root)"
( cd "$SCRATCH" && npm ci --prefix ./dev/dsh-host-lock --no-save --no-audit --no-fund ) \
  || die "npm ci of dev/dsh-host-lock failed in the scratch clone"
( cd "$SCRATCH" && npm ci --no-audit --no-fund ) || die "npm ci at the scratch repo root failed"
( cd "$SCRATCH" && npm run build ) >/dev/null 2>&1 || die "npm run build failed in the scratch clone"

# Browsers are cached in the WORKSPACE (var/ms-playwright), which the rsync deliberately excludes. Copy the
# already-downloaded build rather than re-fetching it: same version, no network.
if [[ -d "$SRC/var/ms-playwright" ]]; then
  mkdir -p "$SCRATCH/var"
  rsync -a "$SRC/var/ms-playwright/" "$SCRATCH/var/ms-playwright/" || die "browser cache copy failed"
  log "browser cache copied ($(ls "$SCRATCH/var/ms-playwright" | wc -l) builds)"
else
  log "no workspace browser cache in $SRC — the run will fail with an explicit Playwright message"
fi

# E2E_PROVIDER=harness makes the tape proxy dial the maintainer's route for RECORD. Provider identity is NOT
# changed (that was the bug that produced a machine-local corpus): the header still says the fixture provider,
# so a CI runner replays what was recorded here.
# Credentials: reuse the rig's OWN chain, invent nothing. `boot.ts` resolves the route key in a documented order
# — (1) the parent environment, (2) `.dshdev-local/e2e.env` — and that file is excluded from the rsync because
# the rest of `.dshdev-local` is developer plugin state. So it is placed into the clone verbatim, and nothing is
# parsed, printed, or guessed (project rule dev2/001: raw tokens never appear in command output).
#
# Why this line exists: the first version of this block parsed `~/.dsh/.credentials.yaml` with a regex and
# exported the result. The endpoint answered 401 to every request and `suite` recorded ZERO tape entries across
# ten minutes, while the working copy distills the same leg in 40 seconds. A self-invented credential path is
# worse than no credential path, because the rig refuses loudly when the chain finds nothing.
mkdir -p "$SCRATCH/.dshdev-local"
if [[ -f "$SRC/.dshdev-local/e2e.env" ]]; then
  cp "$SRC/.dshdev-local/e2e.env" "$SCRATCH/.dshdev-local/e2e.env"
  log "the rig's own credential file placed in the clone (contents not printed)"
else
  log "no .dshdev-local/e2e.env in the working copy — RECORD will refuse without a route key; replay is unaffected"
fi

log "distilling legs: ${*:-(full ORDER)}"
( cd "$SCRATCH" && E2E_PROVIDER=harness bash scripts/distill-tapes.sh "$@" )
STATUS=$?
log "distill exit=$STATUS"

# Copy back ONE directory, and say what moved. Everything else in the scratch clone is disposable by design.
# Sync-back is a DELETE operation against the working corpus, so it gets two checks before it runs. Measured
# against myself 2026-10-27: the first version of this script synced back an EMPTY scratch tape directory
# (the distill had failed) and wiped the committed `suite` corpus; `git checkout` recovered it, but a script
# whose failure mode is "destroy the thing it was written to produce" is not a tool.
log "refusing to sync back unless the distill succeeded and produced tapes"
[[ "$STATUS" -eq 0 ]] || die "distill exited $STATUS — not syncing back; the working corpus is left untouched"
SCRATCH_TAPES=$(find "$SCRATCH/$TAPE_REL" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
[[ "$SCRATCH_TAPES" -gt 0 ]] || die "no tape entries in $SCRATCH/$TAPE_REL — refusing to sync an empty corpus over a real one"
LOCAL_TAPES=$(find "$SRC/$TAPE_REL" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
if [[ "$SCRATCH_TAPES" -lt $(( LOCAL_TAPES / 2 )) ]]; then
  die "scratch has $SCRATCH_TAPES entries, working copy has $LOCAL_TAPES — a halving looks like a failed leg, not a re-anchor"
fi
log "syncing $TAPE_REL back to $SRC ($SCRATCH_TAPES entries replacing $LOCAL_TAPES)"
rsync -a --delete "$SCRATCH/$TAPE_REL/" "$SRC/$TAPE_REL/" || die "tape sync-back failed"

# Sanity: print the header length now recorded. If it is ~7,276 the scratch path was not CI-shaped after all.
HDR=$(node -e '
  const fs = require("fs"), p = process.argv[1];
  let n = null, best = 0;
  for (const f of fs.readdirSync(p).filter((x) => x.endsWith(".json")).sort()) {
    const pre = (JSON.parse(fs.readFileSync(p + "/" + f, "utf8")).prefix || []).map(String);
    const h = pre.find((s) => s.includes("You are an AI agent"));
    if (h && h.length > best) { best = h.length; n = f; }
  }
  process.stdout.write(String(best) + (n ? " (" + n + ")" : ""));
' "$SRC/$TAPE_REL/suite" 2>/dev/null || echo "unknown")
log "largest recorded system header in the suite corpus: $HDR chars"
[[ "${KEEP:-0}" = "1" ]] || log "scratch kept at $SCRATCH (KEEP=1 leaves it; remove it when done)"
exit $STATUS
