#!/usr/bin/env bash
# host-matrix (issue #443) — sweep the supported harness versions in per-version isolation.
# The judgment layer is unit-tested (tests/unit/host-matrix-support.test.ts); this wrapper only
# pins the toolchain the rig uses (Node 24; system Node 22 cannot run the TS entry) and the
# browsers path the e2e plane already relies on. Never two boots at once — the sweep boots
# sequentially ON PURPOSE (the 2026-09-23 same-home corruption lesson, applied across versions).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/var/toolchain/node-v24.22.0-linux-x64/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/var/ms-playwright"
exec node --experimental-strip-types --no-warnings scripts/host-matrix.mts "$@"
