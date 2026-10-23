/**
 * The arithmetic behind #78 option A. Two things are being protected here: that a node which makes
 * relief impossible is deferred (survivability), and that the deferral NEVER happens on a guess
 * (AGENTS: a floor below the chunk size silently makes compaction unnecessary — a passing heavy test
 * then proves nothing). Hence `null` on incomplete inputs rather than a plausible number.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { lastResortCeilingTokens } from '../../src/last-resort.ts'

const BASE = { windowTokens: 32_000, retainRatio: 0.16, reservedCompletionTokens: 15_000 }

test('the ceiling is the window minus what relief must keep (#78 A)', () => {
  // 32,000 − retain 5,120 (0.16 × window) − reservedCompletion 15,000 = **11,880**: a node above
  // this cannot coexist with the tail the base engine is obliged to retain, which is why range
  // selection finds nothing. Written as the arithmetic, not as a remembered number — my first draft
  // of this line asserted 21,880, which is what "composing before measuring" produces.
  assert.equal(lastResortCeilingTokens(BASE), 32_000 - Math.floor(32_000 * 0.16) - 15_000)
  assert.equal(lastResortCeilingTokens(BASE), 11_880)
})

test('an explicit retainTokens wins over the ratio, both being base config', () => {
  assert.equal(lastResortCeilingTokens({ ...BASE, retainTokens: 4_000 }), 32_000 - 4_000 - 15_000)
})

test('no conclusion is returned as null, never as a permissive number', () => {
  assert.equal(lastResortCeilingTokens({ ...BASE, windowTokens: Number.NaN }), null, 'unmeasured window')
  assert.equal(lastResortCeilingTokens({ ...BASE, retainRatio: 0 }), null, 'a ratio of zero is not a fact, it is an absent one')
  assert.equal(lastResortCeilingTokens({ ...BASE, retainRatio: 1.4 }), null, 'out-of-range ratio cannot yield a budget')
  assert.equal(lastResortCeilingTokens({ windowTokens: 20_000, retainRatio: 0.16, reservedCompletionTokens: 17_000 }), null,
    'when the tail plus completion exceed the window there is NO ceiling to enforce — do not invent one')
})

test('the field numbers this rule was written for stay reachable', () => {
  // heavy's measured decline: surface 33,442 tokens with trigger 16,000 on a 32,000 window, and the
  // blocking node was a ~30K-token single read. The ceiling must sit below that node and above a
  // fittable one, or the rule either never fires or fires vacuously.
  const c = lastResortCeilingTokens(BASE) as number
  assert.ok(c < 30_000, `ceiling ${String(c)} must be under the oversized node that blocked relief`)
  assert.ok(c > 9_000, `ceiling ${String(c)} must be over ordinary tool results, or arrival does all the work`)
})

/**
 * The ordering, pinned where it can actually be broken. A row over the wiring is not laziness —
 * the ONLY thing separating "survivability" from "arrival quietly does the work and `heavy` proves
 * nothing" (AGENTS' named trap) is that the deferral sits behind a measured decline.
 */
test('the deferral is reachable only from the declined branch (#78 A, anti-vacuity)', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'engine.ts'), 'utf8')
  const callsite = src.indexOf('const deferred = await this.#lastResortRelief')
  assert.ok(callsite > 0, 'the engine must call it')
  const branch = src.slice(src.lastIndexOf('if (result === null)', callsite), callsite)
  assert.match(branch, /if \(result === null\) \{/, 'from inside the declined branch, not beside it')
  // Bound the slice to the method's own body: a fixed 3000-char window spilled into the NEXT
  // member (which is `#lastResortRelief`'s doc comment) and accused the engine of a call that is
  // not there. A shape row that fails for its own slicing bug is worse than no row — it teaches
  // people to distrust the gate.
  const arriveAt = src.indexOf('async #arrive(')
  const nextMember = /(\n  (?:private |async )?[#a-zA-Z][\w]*\(|\n  \/\*\*)/.exec(src.slice(arriveAt + 20))
  const arrive = src.slice(arriveAt, arriveAt + 20 + (nextMember ? nextMember.index : 1500))
  assert.ok(arrive.length > 200, `the arrival method body must be resolvable, got ${String(arrive.length)} chars`)
  assert.match(arrive, /applyArrivalStubs\(/, 'and it really is the arrival body (it calls the stubber)')
  assert.doesNotMatch(arrive, /#lastResortRelief/, 'and NEVER from arrival, which would make relief untestable')
  const switchOff = src.indexOf('if (this.chaptersConfig.lastResortArtifact !== true) return 0')
  assert.ok(switchOff > 0 && switchOff < src.indexOf('const ceiling = lastResortCeilingTokens('),
    'the operator switch is honored BEFORE anything is computed')
})
