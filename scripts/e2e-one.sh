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
if [ -z "${LEG:-}" ]; then
  # An explicit usage line, exit 2. The previous form was `${LEG:?…}`, which bash reports as
  # `scripts/e2e-one.sh: line 30: LEG: set LEG=…` — a parameter-expansion error that looks like a broken
  # script rather than guidance. The maintainer read that line and reasonably concluded nothing worked; the
  # cause was a stale checkout, but the message earned none of the credit.
  echo "usage: LEG=<suite|heavy|arrival|enrich|fanout|rules|fork|plans> MODE=<live|replay|record|heal> bash scripts/e2e-one.sh" >&2
  echo "   or: npm run corpus:heal -- --project=suite" >&2
  exit 2
fi
if [ -z "${MODE:-}" ]; then
  echo "usage: LEG=… MODE=<live|replay|record|heal> bash scripts/e2e-one.sh  (no default: the mode decides whether a tape is written)" >&2
  exit 2
fi
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

# DRY=1 resolves everything and runs nothing. This exists because "did my flags land?" used to require a full
# harness boot to answer — minutes of GPU/port/credential work to check a line of parsing — which is how a
# broken script gets handed to a human to discover. Prove the resolution, then decide whether to boot.
if [ "${DRY:-0}" = "1" ]; then
  echo "[e2e-one] DRY RUN — would exec: npx playwright test -c tests/e2e/playwright.config.ts ${ARGS[*]-}"
  echo "[e2e-one] DRY RUN — no boot, no browser, no model call, no tape written"
  exit 0
fi
exec npx playwright test -c tests/e2e/playwright.config.ts "${ARGS[@]}"
