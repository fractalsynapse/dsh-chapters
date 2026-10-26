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

# `npm run corpus:heal -- --project=suite` is the shape everyone reaches for, because that is how
# Playwright selects a project and how this repo's scripts worked BEFORE the single-leg runner existed.
# Refusing to accept it would be pedantry that costs the maintainer another round-trip, so the flag is
# translated into LEG here, in one place — and a conflicting `LEG=` plus `--project=` is an error rather
# than a silent winner, because guessing which leg was meant is how a suite heals a fork tape.
PROJECT_ARG=""
ARGS=()
for a in "$@"; do
  case "$a" in
    --project=*) PROJECT_ARG="${a#--project=}"; ARGS+=("$a") ;;
    *) ARGS+=("$a") ;;
  esac
done
if [ -n "$PROJECT_ARG" ] && [ -n "${LEG:-}" ] && [ "$PROJECT_ARG" != "$LEG" ]; then
  echo "e2e-one: LEG=$LEG conflicts with --project=$PROJECT_ARG — name the leg once" >&2; exit 2
fi
[ -n "$PROJECT_ARG" ] && LEG="$PROJECT_ARG"
export LEG
: "${LEG:?set LEG=<suite|heavy|arrival|enrich|fanout|rules|fork|plans>, or pass --project=<leg>}"
: "${MODE:?set MODE=<live|replay|record|heal>}"
case "$MODE" in
  live)   export E2E_MODEL=live ;;
  replay) export E2E_MODEL=replay ;;
  record) export E2E_MODEL=record ;;
  heal)   export E2E_MODEL=replay E2E_TAPE_FALLBACK=1 ;;
  *) echo "e2e-one: unknown MODE=$MODE" >&2; exit 2 ;;
esac
# ONLY `live` may drop the pinned window. HEAL MUST NOT: the proxy enforces the window in RECORD and REPLAY
# alike (#78) because the regime is part of what the tape records — a distill that saw a refusal and retried
# after relief must see the same refusal on replay. Setting 0 on a heal would let through requests the tape's
# own run refused, diverging the sequence and producing exactly the MISS storm this script is meant to avoid.
# (My first cut defaulted 0 for both modes, caught by running heal with LEG unset and reading the line it
# printed: `window=0` on a tape-regime run is a regime change, not a convenience.)
if [ "$MODE" = live ]; then export E2E_WINDOW_TOKENS="${E2E_WINDOW_TOKENS:-0}"; fi
export PLAYWRIGHT_BROWSERS_PATH="$PWD/var/ms-playwright"
echo "[e2e-one] leg=$LEG mode=$MODE provider=${E2E_PROVIDER:-tracked-local} window=${E2E_WINDOW_TOKENS:-pinned-32K}"
exec npx playwright test -c tests/e2e/playwright.config.ts "${ARGS[@]}"
