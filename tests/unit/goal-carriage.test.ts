/**
 * #349 (conservative slice) — the goal carried into a child's notice.
 *
 * Fixtures use the REAL `goal/change` shape measured from three production logs
 * (`kind, version, operation, goal{id,revision,objective,phase,maxGoalRounds,blockedReason},
 * roundsStarted, createdAt, updatedAt`; operations create/edit/pause/resume/block/complete/clear).
 * Not an invented shape — that is the mistake #339/#345/#355 all caught.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldGoalFromLog, renderGoalCarriage, type GoalSnapshot } from '../../src/goal-carriage.ts'
import type { SessionEventLike } from '../../src/types.ts'

const goalEvent = (seq: number, operation: string, goal: Record<string, unknown>, roundsStarted = 0): SessionEventLike => ({
  type: 'goal/change', seq, time: 0, surfaceOp: 'append',
  data: {
    kind: 'goal/change', version: 1, operation, roundsStarted,
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 + seq,
    goal: { id: 'goal-d93c8613', revision: 1, objective: 'Ship 0.2.33 and re-anchor the corpus', phase: 'active', ...goal },
  },
})

const other = (seq: number): SessionEventLike =>
  ({ type: 'user/message', seq, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } })

test('#349: an active goal folds with objective, revision, phase and round cap', () => {
  const g = foldGoalFromLog([
    other(0),
    goalEvent(1, 'create', { objective: 'Ship 0.2.33 and re-anchor the corpus', maxGoalRounds: 256 }),
  ])!
  assert.ok(g !== null)
  assert.deepEqual(
    { objective: g.objective, revision: g.revision, phase: g.phase, cap: g.maxGoalRounds, finished: g.finished },
    { objective: 'Ship 0.2.33 and re-anchor the corpus', revision: 1, phase: 'active', cap: 256, finished: false },
  )
})

test('#349: later operations win — edit bumps, pause/resume/block set phase, unknown operations are ignored', () => {
  const edited = foldGoalFromLog([
    goalEvent(1, 'create', { objective: 'first wording' }),
    goalEvent(5, 'edit', { objective: 'second wording', revision: 2 }),
  ])!
  assert.deepEqual({ o: edited.objective, r: edited.revision }, { o: 'second wording', r: 2 }, 'the live objective wins')

  const paused = foldGoalFromLog([goalEvent(1, 'create', {}), goalEvent(9, 'pause', {})])!
  assert.equal(paused.phase, 'paused', 'a bare pause carries no objective and must not blank the one we have')
  assert.equal(paused.objective, 'Ship 0.2.33 and re-anchor the corpus', 'objective is retained across a no-op edit')

  const resumed = foldGoalFromLog([goalEvent(1, 'create', { phase: 'paused' }), goalEvent(9, 'resume', { phase: 'paused' })])!
  assert.equal(resumed.phase, 'active', 'resume is folded, not passed through from the event payload')

  const unknown = foldGoalFromLog([
    goalEvent(1, 'create', { objective: 'keep me' }),
    { ...goalEvent(2, 'teleport_to_other_model', { objective: 'CORRUPTED' }), seq: 2 } as SessionEventLike,
  ])!
  assert.equal(unknown.objective, 'keep me', 'an operation this build has never seen must not rewrite the purpose')
  assert.equal(unknown.seq, 1, 'and the folded provenance stays the last known event')
})

test('#349: clear means NO goal — a finished purpose is not carried forward as direction', () => {
  const cleared = foldGoalFromLog([
    goalEvent(1, 'create', { objective: 'do the old thing' }),
    goalEvent(7, 'clear', {}),
  ])
  assert.equal(cleared, null, 'a cleared goal folds to nothing')
  assert.equal(renderGoalCarriage(cleared, 600), '', 'and renders zero bytes')
  // And a goal created AFTER a clear is live again.
  const again = foldGoalFromLog([goalEvent(1, 'create', {}), goalEvent(7, 'clear', {}), goalEvent(9, 'create', { revision: 1, objective: 'new purpose' })])
  assert.equal(again?.objective, 'new purpose', 'clear is not a tombstone for the whole session')
})

test('#349: a completed goal is stated as finished, never as live direction', () => {
  const done = foldGoalFromLog([goalEvent(1, 'create', {}), goalEvent(20, 'complete', {})])!
  assert.equal(done.finished, true)
  const text = renderGoalCarriage(done, 600)
  assert.match(text, /completed — do not resume it/, 'header says so')
  assert.doesNotMatch(text, /Only the human can send \/goal resume/, 'a finished goal gets no re-arm instruction')
})

test('#349: the notice states that the CHILD CANNOT ARM ITS OWN GOAL — the point of the conservative path', () => {
  // (maxGoalRounds set explicitly: an earlier draft of this row asserted 'round cap 256'
  // against a fixture that never supplied it, and the renderer correctly printed 'unbounded'.)
  const g = foldGoalFromLog([goalEvent(1, 'create', { maxGoalRounds: 256 })])!
  const text = renderGoalCarriage(g, 600)
  assert.match(text, /## Goal \(carried from the parent session\)/)
  assert.match(text, /NOT armed in the child/, 'says plainly that carrying the text is not carrying the driver')
  assert.match(text, /only the human|Only the human/, 'and names who can change it')
  assert.match(text, /\/goal resume/)
  assert.match(text, /round cap 256, revision 1, phase active \(from seq 1\)/, 'with the numbers and the seq to check')
  // #349's fuller ask (creating the child goal via the service) must stay visibly undone, not implied done.
  assert.doesNotMatch(text.toLowerCase(), /goal (has been )?(created|re-established) in this child/)
})

test('#349: no goal at all renders ZERO bytes — ordinary notices and tapes are untouched', () => {
  assert.equal(renderGoalCarriage(null, 600), '')
  const g = foldGoalFromLog([other(0), other(1)])
  assert.equal(g, null, 'a session with no goal/change events folds to null')
  // A goal event with an empty objective must not produce an empty header either.
  const blank: GoalSnapshot = { id: 'x', revision: 1, objective: '', phase: 'active', operation: 'create', seq: 3, finished: false }
  assert.equal(renderGoalCarriage(blank, 600), '', 'no objective means no block, not a bare heading')
})

test('#349: the budget bounds the objective display, never the instruction', () => {
  const long = 'coordinate the release train and re-anchor the tape corpus after each request-byte change. '.repeat(20)
  const g = foldGoalFromLog([goalEvent(1, 'create', { objective: long })])!
  const text = renderGoalCarriage(g, 120)
  assert.match(text, /first 120 of \d+ chars/, 'states what it cut and how much was there')
  assert.ok(text.includes('display budget, never a data decision'), 'says the bytes are elsewhere, not gone')
  assert.match(text, /NOT armed in the child/, 'the instruction survives truncation in full')
  const objLine = text.split('\n').find((l) => l.startsWith('Objective (first'))!
  assert.ok(objLine.length < 120 + 60, `objective line blew past its budget: ${String(objLine.length)}`)
  // And a short objective is NOT truncated or annotated.
  const short = renderGoalCarriage(foldGoalFromLog([goalEvent(1, 'create', { objective: 'land 340' })])!, 600)
  assert.match(short, /^Objective: land 340$/m)
  assert.doesNotMatch(short, /first \d+ of/)
})

test('#349: folding is deterministic over the same log and order-independent of non-goal events', () => {
  const events = [other(0), goalEvent(1, 'create', { revision: 1 }), other(2), goalEvent(3, 'pause', {}), other(4)]
  const a = foldGoalFromLog(events)
  const b = foldGoalFromLog(events)
  assert.deepEqual(a, b, 'same bytes, same snapshot (the notices are hashed in tapes)')
  assert.equal(a?.phase, 'paused')
  // Dropping the goal events leaves only non-goal traffic, which must fold to null rather than throw.
  assert.equal(foldGoalFromLog([other(0), other(2), other(4)]), null)
  assert.equal(foldGoalFromLog([]), null, 'and an empty log is simply no goal')
})

// ───────────────────────────────────────────────────────────── the notice itself

test('#349: assembleNotice places the goal block above the fold, and injects nothing when absent', async () => {
  const { assembleNotice } = await import('../../src/continue-core.ts')
  const base = {
    title: 'T', handoffNote: 'note', entries: [], rootSession: 'r', parentSession: 'p', storeRoot: '.dsh-chapters',
  }
  const goal = renderGoalCarriage(foldGoalFromLog([goalEvent(1, 'create', { maxGoalRounds: 64 })]), 600)
  const withGoal = assembleNotice({ ...base, goalSection: goal })
  assert.match(withGoal, /## Goal \(carried from the parent session\)/, 'the block is present')
  assert.match(withGoal, /round cap 64/, 'with its numbers')

  // Position matters: below the fold the child may never read it, and that is the whole claim.
  const foldIndex = withGoal.indexOf('This session continues an archived conversation')
  const goalIndex = withGoal.indexOf('## Goal (carried')
  assert.ok(goalIndex >= 0 && foldIndex >= 0 && goalIndex < foldIndex,
    'the goal must sit with the plans block, ABOVE the prose the child reads first')

  const bare = assembleNotice({ ...base })
  assert.doesNotMatch(bare, /## Goal/, 'no goal in, zero bytes out')
  assert.equal(bare.includes('(carried from'), false, 'and no empty heading or dangling label')

  const empty = assembleNotice({ ...base, goalSection: '' })
  assert.equal(empty, bare, 'an empty section is byte-identical to omitting it (tape-safe both ways)')
})

test('#349: the fold is fed the CALLER log, so a child of a goal session inherits the objective verbatim', async () => {
  const { assembleNotice } = await import('../../src/continue-core.ts')
  const objective = 'Land 0.2.33, then re-anchor the prompt leg once, then close #340/#379/#351.'
  const callerEvents = [
    other(0),
    goalEvent(2, 'create', { objective, maxGoalRounds: 256, revision: 3 }),
    goalEvent(9, 'pause', { objective, revision: 3 }),
  ]
  const section = renderGoalCarriage(foldGoalFromLog(callerEvents), 600)
  const notice = assembleNotice({
    title: 'T', handoffNote: 'n', entries: [], rootSession: 'r', parentSession: 'p',
    storeRoot: '.dsh-chapters', goalSection: section,
  })
  assert.ok(notice.includes(objective), 'the objective is carried WHOLE, not paraphrased (invariant 4 in spirit)')
  assert.match(notice, /phase paused/, 'and the folded state, not the first event state')
  assert.match(notice, /Goal is paused\. The child cannot change that — only the human can send \/goal resume\./,
    'the instruction matches the phase — an active-goal sentence on a paused goal would be a new lie')
})
