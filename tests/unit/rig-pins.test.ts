import test from 'node:test'
import assert from 'node:assert/strict'
import { RIG_PINS } from '../../tests/e2e/rig-pins.ts'


/**
 * Every leg that is not the pressure journey must pin `noAuxModel` (#129, root cause found 2026-10-27).
 *
 * CI's miss set moved between runs — `plans`/`prompt`, then `fork`/`prompt-off`, then
 * `suite`/`heavy`/`fanout`/`rules`/`prompt` — while the header kept matching. The runner's own uploaded session
 * log explains it: the same journey ran (`grep` at seq 20, `glob` at seq 25), but the capture's first main request
 * carries an *"automatically generated checkpoint condensing an earlier span"* notice. Both machines compact, at
 * different moments, so the same assistant turn lands at message index 6 on one and index 2 on the other, and
 * message 0 is the tape key. `noAuxModel: true` already exists for exactly this (boot.ts: it disables automatic
 * compaction AND plot elicitation so the request sequence in the tape is the whole story) — yet only `plans`
 * pinned it, and only `heavy` has a legitimate reason to let the model-involving machinery fire.
 *
 * This is the "the arrival floor is a behavior switch, not a knob" rule applied to our own rig: a tape that
 * depends on whether pressure compaction happens to fire is not an acceptance test, it is a coin flip.
 */
test('only the pressure journeys leave model-involving machinery enabled', () => {
  const PRESSURE_LEGS = new Set(['heavy'])   // the leg that exists to exercise post-compaction retries
  const open = Object.entries(RIG_PINS)
    .filter(([name]) => !PRESSURE_LEGS.has(name))
    .filter(([, pins]) => pins.noAuxModel !== true)
    .map(([name]) => name)
  assert.deepEqual(open, [], `these legs would let automatic compaction fire mid-journey, making the tape depend on machine timing: ${open.join(', ')}`)
  assert.equal(RIG_PINS.heavy?.noAuxModel, undefined,
    'heavy deliberately keeps the pressure machinery on — pinning it would make the leg measure a boot where nothing is wrong')
})
