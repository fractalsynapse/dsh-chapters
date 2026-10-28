import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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
  // The legs whose journey IS the model-involving machinery, established by measurement (2026-10-27 campaign on
  // the gated build), not by preference:
  //   heavy   — post-compaction retries are the point of the leg;
  //   suite   — the fork door only renders once the session has actually compacted and continued;
  //   arrival — the leg asserts an arrival stub pair, i.e. the deferral machinery firing on one oversized read;
  //   fanout  — the parent must consume its children's papers, and gating turned that synthesis away.
  // Pinning any of these does not make it deterministic; it deletes the behavior under test, which is the same
  // mistake as setting the arrival floor below the chunk size and calling the passing row a result.
  const PRESSURE_LEGS = new Set(['heavy', 'suite', 'arrival', 'fanout'])
  const open = Object.entries(RIG_PINS)
    .filter(([name]) => !PRESSURE_LEGS.has(name))
    .filter(([, pins]) => pins.noAuxModel !== true)
    .map(([name]) => name)
  assert.deepEqual(open, [], `these legs would let automatic compaction fire mid-journey, making the tape depend on machine timing: ${open.join(', ')}`)
  for (const leg of ['heavy', 'suite', 'arrival', 'fanout']) {
    assert.equal(RIG_PINS[leg]?.noAuxModel, undefined,
      `${leg} exercises the machinery — pinning it would make the leg measure a boot where nothing happens`)
  }
})

/**
 * The corpus itself must show the gate working (#129).
 *
 * `noAuxModel` is now consumed by the engine (guarded by `rig-realm-keys-consumed.test.ts`), but a consumer that
 * does nothing is still a green test, so the observable claim is checked where it lives: a recorded journey for any
 * leg that pins the flag must contain NO automatic-checkpoint notice. If pressure compaction fires anyway, the
 * tape says so in its own bytes and this row fails — including in CI, where the whole defect was found.
 */
test('no pinned leg recorded an automatic checkpoint mid-journey', () => {
  const dir = 'tests/fixtures/model-tape'
  for (const [leg, pins] of Object.entries(RIG_PINS)) {
    if (pins.noAuxModel !== true) continue
    const base = path.join(dir, leg)
    if (!fs.existsSync(base)) continue
    const files = fs.readdirSync(base).filter((f) => f.endsWith('.json'))
    for (const f of files) {
      const e = JSON.parse(fs.readFileSync(path.join(base, f), 'utf8')) as { prefix?: unknown[] }
      const text = (e.prefix ?? []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('')
      assert.ok(!text.includes('automatically generated checkpoint'),
        `${leg}/${f} recorded a mid-journey checkpoint while the leg pins noAuxModel — the gate is not holding`)
    }
  }
})
