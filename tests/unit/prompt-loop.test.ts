/**
 * Autorun is a loop with a budget and an off switch (#113), and every rule here is copied from the host goal
 * driver's observed semantics rather than invented: starts disarmed, one fire per offer, a human takes the
 * wheel, and a cap that cannot be re-armed past.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makePromptLoop, suggestPromptMessage } from '../../src/prompt-loop.ts'
import type { PromptSuggestionState } from '../../src/prompt-state.ts'

const ready = (turnSeq: number, text = 'Run the plane.'): PromptSuggestionState =>
  ({ status: 'ready', text, turnSeq, error: '', at: 'now' })

function world(opts: { maxRounds?: number } = {}) {
  const fired: Array<{ id: string; text: string }> = []
  const logs: string[] = []
  const warns: string[] = []
  const loop = makePromptLoop({
    followup: (id, text) => { fired.push({ id, text }) },
    maxRounds: () => opts.maxRounds ?? 3,
    log: (m) => { logs.push(m) },
    warn: (m) => { warns.push(m) },
  })
  return { loop, fired, logs, warns }
}

test('nothing fires until a human arms it, and arming alone fires nothing (#113)', () => {
  const w = world()
  assert.equal(w.loop.maybeFire('S', ready(10)), false, 'disarmed by construction — a restart cannot resume a loop')
  assert.equal(w.loop.statusOf('S').autorun, 'disarmed')
  w.loop.setArmed('S', true)
  assert.equal(w.fired.length, 0, 'arming is a promise about the NEXT offer, not a trigger for a stale one')
  assert.equal(w.loop.maybeFire('S', ready(10)), true, 'and the offer on screen is then fair game')
  assert.equal(w.fired[0]!.text, 'Run the plane.')
})

test('one offer fires exactly once, however many pulls ask (#113)', () => {
  const w = world()
  w.loop.setArmed('S', true)
  const offer = ready(10)
  w.loop.maybeFire('S', offer)
  w.loop.maybeFire('S', offer)
  w.loop.maybeFire('S', offer)
  assert.equal(w.fired.length, 1, 'a retry storm would be the same bug the ghost had, one layer down')
  w.loop.maybeFire('S', ready(24))
  assert.equal(w.fired.length, 2, 'a NEW turn is a new offer')
})

test('a human prompt disarms the loop; the budget survives re-arming (#113)', () => {
  const w = world({ maxRounds: 2 })
  w.loop.setArmed('S', true)
  w.loop.maybeFire('S', ready(1))
  w.loop.maybeFire('S', ready(2))
  assert.equal(w.loop.statusOf('S').fired, 2)
  assert.equal(w.loop.disarmForHuman('S'), 'disarmed')
  assert.equal(w.loop.maybeFire('S', ready(3)), false, 'nothing fires after the human took over')
  assert.ok(w.logs.some((l) => l.includes('human prompt')), 'and it says why')

  w.loop.setArmed('S', true)
  const warnsBefore = w.warns.length
  assert.equal(w.loop.maybeFire('S', ready(4)), false, 're-arming does not buy a fresh budget')
  assert.equal(w.warns.length, warnsBefore + 1, 'the cap reports itself instead of silently going quiet')
  assert.match(w.warns[warnsBefore]!, /promptMaxRounds/)
})

test('the authored message carries our producer kind and form — never the human kind (#113)', () => {
  const data = suggestPromptMessage('Land #114.', 'turn-41')
  assert.equal(data.role, 'user')
  assert.equal(data.id, 'suggested-turn-41', 'an identified message, or the kernel refuses the row')
  assert.equal((data.source as Record<string, string>).kind, 'plugin:dsh-chapters')
  assert.equal((data.source as Record<string, string>).form, 'notice', 'a published ContextForm, not an invented one')
  assert.deepEqual(data.content, [{ type: 'text', text: 'Land #114.' }])
  // `kind:'user'` satisfies the host goal tool's direct-human test and would let this loop authorize
  // pause/resume on goals; `kind:'goal'` is deep-equal-checked against the host's own round template.
  assert.notEqual((data.source as Record<string, string>).kind, 'user', 'a suggestion must not impersonate the human')
  assert.notEqual((data.source as Record<string, string>).kind, 'goal', 'nor impersonate the goal driver')

  // NOTE, kept because it records a correction: an earlier version of this row asserted that an empty id
  // throws. It cannot — the id is composed as `suggested-${id}`, so it is never empty whatever the caller
  // passes. That is a fabricated failing case, the exact habit this repo keeps having to root out, so the
  // real protection here is that `assertKernelAcceptedUserMessage` runs at all: it refused my invented
  // `form: 'prompt-suggestion'` and forces any future variant to fail at the authorship boundary instead of
  // at row admission inside the host.
})
