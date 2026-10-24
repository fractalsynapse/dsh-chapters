import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')


/**
 * An idle-triggered subsystem makes a tape depend on machine speed (#90, measured 2026-10-24).
 *
 * The `suite` journey's tape has five entries: title, then the main conversation at 6/9/12/14 messages.
 * Its replay missed on a **1-message** request — `You annotate one archived chapter…`, the enrichment
 * ladder — that the tape has never contained. At RECORD the leg was slower than the idle debounce, so
 * the ladder's call landed after teardown; at REPLAY every turn is served from tape, the leg finishes in
 * seconds, and the ladder fires INSIDE the window. Identical product behavior, different tape, and a
 * miss that looks like a matcher bug. Fix: a leg's realm states whether enrichment is on.
 */
test('every boot pins enrichment explicitly, so idle work cannot race the tape (#90)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'globalSetup.ts'), 'utf8')
  assert.match(src, /pins\.enrichment = process\.env\.E2E_ENRICH === '1'/,
    'the pin must be assigned in BOTH states — an absent pin lets the realm default decide, and the default is ON')
  assert.match(src, /E2E_ENRICH/, 'the opt-in switch stays the enrich/heavy legs use')
})
