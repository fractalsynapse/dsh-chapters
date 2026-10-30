/**
 * The goal reaches the model that writes the suggestion (#113).
 *
 * This is the composition the maintainer asked for in one line: *"the prompt suggestion must always take the
 * goal into account if there is an active goal."* It is stated BEFORE the history rather than as a footnote,
 * because the thing that decides whether a candidate next step counts as progress is the purpose, not the
 * tail. And the directive is passed as text: goal semantics live in `prompt-state.ts`, and a second module
 * that decodes `goal/change` would be the #59 mistake again (two predicates for one decision).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSuggestInput } from '../../src/prompt.ts'
import { goalDirectiveOf, readActiveGoal } from '../../src/prompt-state.ts'
import type { SessionEventLike } from '../../src/types.ts'

const FACTS = {
  title: 'Ship the bar',
  chapters: [{ number: 1, title: 'Prior work', summary: 'measured the seam', plots: [] }],
  lastTurn: [{ role: 'user' as const, text: 'continue' }, { role: 'assistant' as const, text: 'wired the runner' }],
}

// #188: the assembly now returns { input } | { refusal }; these rows always fit at 4000, so unwrap.
const build = (f: Parameters<typeof buildSuggestInput>[0], b = 4000, m = 240): string => {
  const r = buildSuggestInput(f, b, m)
  assert.ok('input' in r, `expected an input, got a refusal: ${'refusal' in r ? r.refusal : ''}`)
  return (r as { input: string }).input
}

test('an active goal is stated before the history and constrains the next step', () => {
  const events = [{ seq: 3, type: 'goal/change', data: { operation: 'create', goal: {
    id: 'goal-1', revision: 2, objective: 'Land #114 and cut 0.2.2', phase: 'active', maxGoalRounds: 256,
  } } }] as unknown as SessionEventLike[]
  const goal = readActiveGoal(events)
  assert.ok(goal)
  const input = build({ ...FACTS, goalDirective: goalDirectiveOf(goal) }, 4000, 240)
  const atGoal = input.indexOf('Land #114 and cut 0.2.2')
  const atTail = input.indexOf('wired the runner')
  assert.ok(atGoal > -1, 'the objective is in the input')
  assert.ok(atTail > -1, 'so is the history')
  assert.ok(atGoal < atTail, 'the goal is stated BEFORE the history it constrains, not appended after it')
  assert.match(input, /MUST advance/)
  assert.match(input, /revision 2/, 'and it is the live revision, so a stale suggestion is recognisable')
})

test('no goal means no goal block — the suggestion stands alone', () => {
  const withoutDirective = build(FACTS, 4000, 240)
  assert.ok(!/ACTIVE GOAL|MUST advance/.test(withoutDirective), 'no goal text leaks in')
  const withNone = build({ ...FACTS, goalDirective: goalDirectiveOf(null) }, 4000, 240)
  assert.match(withNone, /No goal is active/, 'but an explicit none still says so, rather than going silent')
})

test('a completed goal does not keep constraining the loop', () => {
  const events = [{ seq: 3, type: 'goal/change', data: { operation: 'complete', goal: {
    id: 'goal-1', revision: 4, objective: 'Land #114', phase: 'complete', maxGoalRounds: 256,
  } } }] as unknown as SessionEventLike[]
  const goal = readActiveGoal(events)
  assert.equal(goal, null, 'a completed goal is not an active purpose')
  assert.match(goalDirectiveOf(goal), /No goal is active/)
})
