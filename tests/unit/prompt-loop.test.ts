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

// #188 — the budget is a governor for open-ended iteration, not a guillotine for a goal.
test('an ACTIVE goal suspends the round budget: the pursuit is bounded by the goal, never by promptMaxRounds', () => {
  const fired: string[] = []
  const loop = makePromptLoop({
    followup: (id, text) => { fired.push(`${id}:${text}`) },
    maxRounds: () => 2,
    goalSignal: () => null,
  })
  loop.setArmed('s1', true)
  const offer = (n: number): PromptSuggestionState => ({ status: 'ready', text: `step ${n}`, turnSeq: n, error: '', at: '', intent: 'worker-step', goalRevision: 1 })
  const activeGoal = { phase: 'active' as const, activation: 'disarmed' as const, revision: 1 }
  assert.equal(loop.maybeFire('s1', offer(1), activeGoal), true)
  assert.equal(loop.maybeFire('s1', offer(2), activeGoal), true)
  // budget spent (2 of 2) — but the goal is still being pursued, so round 3 FIRES:
  assert.equal(loop.maybeFire('s1', offer(3), activeGoal), true, 'the budget must never cut off the pursuit of an active goal')
  // a paused goal may resume: still goal-bounded
  assert.equal(loop.maybeFire('s1', offer(4), { phase: 'paused', activation: 'disarmed', revision: 1 }), true)
  // terminal phases hand control back to the budget — it was spent, so the loop stops now
  assert.equal(loop.maybeFire('s1', offer(5), { phase: 'complete', activation: 'disarmed', revision: 1 }), false, 'a completed goal restores the budget, which is already spent')
  assert.equal(fired.length, 4)
})

test('with NO goal the budget governs exactly as before', () => {
  const loop = makePromptLoop({ followup: () => {}, maxRounds: () => 1, goalSignal: () => null })
  loop.setArmed('s2', true)
  const offer = (n: number): PromptSuggestionState => ({ status: 'ready', text: `step ${n}`, turnSeq: n, error: '', at: '', intent: 'worker-step', goalRevision: null })
  assert.equal(loop.maybeFire('s2', offer(1), null), true)
  assert.equal(loop.maybeFire('s2', offer(2), null), false, 'open-ended iteration stays bounded')
})
