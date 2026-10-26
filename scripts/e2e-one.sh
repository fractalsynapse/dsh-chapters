#!/usr/bin/env bash
# Run EXACTLY ONE acceptance leg. `npm run test:e2e` is a chain over every leg, so it must never be
# composed with `--project=` the way my first cut of corpus:heal did — that ran the whole chain anyway and
# burned 25 minutes of a real model on a journey nobody asked for (maintainer-reported 2026-10-25).
#
#   LEG=suite MODE=heal  npm run e2e:one      # tape hits, misses go live and self-heal onto the tape
#   LEG=suite MODE=live  npm run e2e:one      # no tape at all: the real model, the real browser
#   LEG=suite MODE=record npm run e2e:one     # distill a fresh tape for this leg
set -euo pipefail
cd "$(dirname "$0")/.."
: "${LEG:?set LEG=<suite|heavy|arrival|enrich|fanout|rules|fork|plans> — one of the eight committed legs}"
: "${MODE:?set MODE=<live|replay|record|heal>}"
case "$MODE" in
  live)   export E2E_MODEL=live ;;
  replay) export E2E_MODEL=replay ;;
  record) export E2E_MODEL=record ;;
  heal)   export E2E_MODEL=replay E2E_TAPE_FALLBACK=1 ;;
  *) echo "e2e-one: unknown MODE=$MODE" >&2; exit 2 ;;
esac
# LIVE/HEAL run against the endpoint's REAL window unless asked otherwise: the pinned 32K is a STRESS
# regime that exists to make `context-overflow` fire on tape replay. Proven not to be the blocker for the
# knowledge-loop stall (zero OVERFLOW lines in var/e2e-tape-misses.log), but a real multi-turn journey on a
# hosted model has no reason to wear the stress window, so the live lanes default to the endpoint's own.
if [ "$MODE" = live ] || [ "$MODE" = heal ]; then export E2E_WINDOW_TOKENS="${E2E_WINDOW_TOKENS:-0}"; fi
export PLAYWRIGHT_BROWSERS_PATH="$PWD/var/ms-playwright"
echo "[e2e-one] leg=$LEG mode=$MODE provider=${E2E_PROVIDER:-tracked-local} window=${E2E_WINDOW_TOKENS:-pinned-32K}"
exec npx playwright test -c tests/e2e/playwright.config.ts --project="$LEG" "$@"
