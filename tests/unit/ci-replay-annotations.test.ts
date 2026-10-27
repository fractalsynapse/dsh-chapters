/**
 * `ci-replay.sh` must name the failure it was killed by (#108, measured 2026-10-27).
 *
 * CI's acceptance job went red while the local chain was green, and the annotation carried a single line —
 * `ci-replay: tape replay exited 1` — because the log grep only matched Playwright verdicts. The actual cause
 * was the rig aborting the leg on a strict-replay `MISS`, whose line the grep could not see. A diagnostic that
 * cannot report the failure mode you just built is the "detected and thrown away" bug again.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const script = readFileSync(path.join(ROOT, 'scripts', 'ci-replay.sh'), 'utf8')

test('the replay diagnostics cover rig-fault aborts, not only test verdicts', () => {
  const line = script.split('\n').find((l) => l.includes('var/ci-replay.log | head'))
  assert.ok(line !== undefined, 'the diagnostic grep exists at all')
  for (const needle of ['RIG FAULT', 'MISS tape=', 'reaped orphan', 'falling back to an ephemeral']) {
    assert.ok(line.includes(needle), `the grep must catch "${needle}" — it aborted a leg on CI and the annotation said only "exited 1"`)
  }
  assert.ok(/head -1[0-9]/.test(line), 'and it keeps a bounded but wider budget than 12 lines')
})

test('one annotation, not twenty (the truncation lesson stays enforced)', () => {
  assert.match(script, /ONE annotation, not twenty/, 'the comment names why the message is assembled once')
  assert.ok(!/echo "::error=.*\$\{?line/.test(script), 'lines are accumulated into DIAG, not emitted per-match')
})
