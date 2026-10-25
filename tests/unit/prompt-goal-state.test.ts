/**
 * Goal awareness for the Suggested Next Step bar (#113). Fixtures use the field names measured out of a real
 * session's `goal/change` events — `operation`, `goal.{id,revision,objective,phase,maxGoalRounds}` — because
 * guessing at a host-authored shape is how this repo keeps re-learning that it should read the bytes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readActiveGoal, goalAuthorizesAutorun, goalDirectiveOf } from '../../src/prompt-state.ts'
import type { SessionEventLike } from '../../src/types.ts'

const gc = (seq: number, operation: string, goal: Record<string, unknown>): SessionEventLike =>
  ({ seq, type: 'goal/change', data: { kind: 'goal/change', version: 1, operation, goal } }) as SessionEventLike
const OTHER: SessionEventLike = { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }
const GOAL = { id: 'goal-1', revision: 1, objective: 'Land #114 and cut 0.2.2', phase: 'active', maxGoalRounds: 256 }

test('the newest goal declaration wins, and a no-goal session reads as null', () => {
  assert.equal(readActiveGoal([OTHER]), null, 'no goal, no directive')
  const g = readActiveGoal([gc(10, 'create', GOAL), OTHER, gc(20, 'pause', { ...GOAL, revision: 2, phase: 'paused' })])
  assert.ok(g)
  assert.equal(g.phase, 'paused', 'later operations replace the earlier one — the goal is not its first row')
  assert.equal(g.revision, 2)
  assert.equal(g.maxGoalRounds, 256)
  assert.equal(goalAuthorizesAutorun(g), false, 'a paused goal is not a purpose the loop should keep serving')
})

test('completion and removal end the loop; active authorizes it', () => {
  assert.equal(readActiveGoal([gc(1, 'create', GOAL), gc(2, 'complete', { ...GOAL, phase: 'complete' })]), null)
  assert.equal(goalAuthorizesAutorun(readActiveGoal([gc(1, 'create', GOAL)])), true)
  for (const op of ['clear', 'delete', 'remove'])
    assert.equal(readActiveGoal([gc(1, 'create', GOAL), gc(2, op, {})]), null,
      `removal spelling '${op}' ends the goal — 'clear' is the real one per dsh-goal's GoalOperation; delete/remove stay handled because a host rename must not resurrect a finished goal`)
})

test('host rows that surprise us are skipped, never fatal', () => {
  const junk = [{ seq: 3, type: 'goal/change', data: {} }, { seq: 4, type: 'goal/change', data: { operation: 'edit' } },
    { seq: 5, type: 'goal/change', data: { operation: 'edit', goal: { id: 'x' } } }] as unknown as SessionEventLike[]
  assert.equal(readActiveGoal(junk), null, 'an unreadable goal row is not a license to throw across a plugin boundary')
  const g = readActiveGoal([...junk, gc(6, 'create', GOAL)])
  assert.ok(g && g.objective === 'Land #114 and cut 0.2.2', 'and it must not swallow the real row that follows')
})

test('the directive constrains the next step instead of restating the goal', () => {
  const none = goalDirectiveOf(null)
  assert.match(none, /No goal is active/)
  const withGoal = goalDirectiveOf({ id: 'goal-1', revision: 3, objective: 'Ship the bar', phase: 'active', maxGoalRounds: null })
  assert.match(withGoal, /Ship the bar/)
  assert.match(withGoal, /revision 3/, 'the revision is stated so a stale suggestion can be recognised as stale')
  assert.match(withGoal, /MUST advance/, 'the constraint is the point — an adjacent step is not progress')
  assert.match(withGoal, /close it out|mark it complete/, 'and the loop must be able to END, not merely continue')
})
