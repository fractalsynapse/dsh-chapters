/**
 * Goals and suggested prompts must behave like they were built for one another (#113).
 *
 * The maintainer's workflow, which these rows are the contract for: a large model reads the session and
 * re-cuts the goal over time, a small worker executes, and autorun keeps the process moving between those
 * re-cuts. That only works if the two loops never fight for the same turn and never overstep the authority
 * the host split between them. Both rules are measured facts about host 0.2.0-rc.2, not preferences:
 *
 *  - `dsh-goal-round-driver` queues its own round on idle when `phase==='active' && activation==='armed'`
 *    (`dsh-goal-round-driver/lib/index.js:124`), so a second followup at that boundary is a race against its
 *    reservation fence — this loop yields the turn and keeps the eye open.
 *  - `dsh-tool-goal`'s `requireDirectHuman` gates goal create/edit/pause/resume on a `user/message` with
 *    `source.kind==='user'` in the open turn (`:49-65`), so an autorun (plugin-kinded) message CANNOT re-cut
 *    a goal. A `GOAL:` offer is therefore held for the human's keystroke, and Run stays enabled for it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makePromptLoop, suggestPromptMessage } from '../../src/prompt-loop.ts'
import { classifyOffer, goalDriverOwnsTheTurn } from '../../src/prompt-state.ts'
import type { PromptSuggestionState } from '../../src/prompt-state.ts'
import { parseBarState, promptBarReducer, initialBarState, shouldAutoFire } from '../../src/client/prompt-bar.ts'

const offer = (over: Partial<PromptSuggestionState> = {}): PromptSuggestionState => ({
  status: 'ready', text: 'Run the eight-leg replay and report.', turnSeq: 10, error: '', at: 'now',
  intent: 'worker-step', goalRevision: null, ...over,
})
const GOAL = { phase: 'active' as const, activation: 'armed' as const, revision: 3 }

function loop(deps: { maxRounds?: number, displace?: (id: string) => boolean } = {}) {
  const fired: Array<{ id: string; text: string }> = []
  const logs: string[] = []
  const warns: string[] = []
  const l = makePromptLoop({
    followup: (id, text) => { fired.push({ id, text }) },
    maxRounds: () => deps.maxRounds ?? 10,
    ...(deps.displace === undefined ? {} : { displaceGoal: deps.displace }),
    log: (m) => { logs.push(m) },
    warn: (m) => { warns.push(m) },
  })
  l.setArmed('S', true)
  return { l, fired, logs, warns }
}

test('an armed goal driver owns the next turn — the suggestion loop yields, and says why', () => {
  const { l, fired, logs } = loop()
  assert.equal(goalDriverOwnsTheTurn(GOAL), true)
  assert.equal(l.maybeFire('S', offer({ goalRevision: 3 }), GOAL), false,
    'two turn-starters at one boundary would race the driver\'s own reservation fence')
  assert.equal(fired.length, 0)
  assert.ok(logs.some((m) => m.includes('yielding the next turn to the goal driver')),
    'a yield that is invisible looks like a broken loop (#61: deliver what you know)')

  // …and the moment the driver is NOT owning it, the same loop does drive the worker.
  assert.equal(l.maybeFire('S', offer({ goalRevision: 3 }), { ...GOAL, activation: 'disarmed' }), true,
    'active but disarmed: the goal holds the objective, the suggestion runs the work')
  assert.equal(l.maybeFire('S', offer({ turnSeq: 11, goalRevision: 3 }), { phase: 'paused', activation: 'disarmed', revision: 3 }), true,
    'a paused goal is not a competing turn-starter')
})

test('a goal edit is never auto-run — Run is the human\'s keystroke, and the only one the host authorises', () => {
  const { l, fired, logs } = loop()
  const cut = offer({ intent: 'goal-edit', text: 'Narrow the goal to the eight remaining defects.', goalRevision: 3 })
  assert.equal(l.maybeFire('S', cut, null), false, 'no goal active still does not auto-run a re-cut')
  assert.equal(l.maybeFire('S', cut, { phase: 'paused', activation: 'disarmed', revision: 3 }), false)
  assert.equal(fired.length, 0)
  assert.ok(logs.some((m) => /re-cuts the goal/.test(m) && /keystroke/.test(m)),
    `the reason must name the authority boundary, not just refuse: ${logs.join(' | ')}`)
  // The loop is NOT disarmed by holding one offer: the next worker step still runs on its own.
  assert.equal(l.statusOf('S').autorun, 'armed')
  assert.equal(l.maybeFire('S', offer({ turnSeq: 12, goalRevision: 3 }), { phase: 'paused', activation: 'disarmed', revision: 3 }), true)
})

test('a goal re-cut invalidates the outstanding offer rather than executing last cycle\'s directive', () => {
  const { l, fired, logs } = loop()
  const stale = offer({ goalRevision: 3 })
  assert.equal(l.maybeFire('S', stale, { phase: 'active', activation: 'disarmed', revision: 4 }), false,
    'revision moved 3 → 4: the objective the offer was written for no longer exists')
  assert.equal(fired.length, 0)
  assert.ok(logs.some((m) => /stale offer/.test(m) && /revision 3/.test(m) && /now 4/.test(m)),
    `the numbers are stated: ${logs.join(' | ')}`)
  assert.equal(l.maybeFire('S', offer({ turnSeq: 13, goalRevision: 4 }), { phase: 'active', activation: 'disarmed', revision: 4 }), true,
    'and the fresh offer, cut against the new revision, goes straight through')
  assert.equal(fired.length, 1)
})

test('no goal at all: the suggestion stands alone and governs the worker', () => {
  const { l, fired } = loop()
  assert.equal(goalDriverOwnsTheTurn(null), false)
  assert.equal(l.maybeFire('S', offer(), null), true)
  assert.equal(fired.length, 1, 'the loop works without a goal, as the maintainer required')
  assert.equal(l.maybeFire('S', offer(), null), false, 'but still one turn per offer')
})

test('a director re-cut survives authorship: clean bytes to the worker, our kind, never the human kind', () => {
  const classified = classifyOffer('GOAL: narrow the objective to the replay failures')
  assert.equal(classified.intent, 'goal-edit')
  assert.equal(classified.text, 'narrow the objective to the replay failures', 'the worker never sees the protocol prefix')
  const message = suggestPromptMessage(classified.text, 'turn-9') as { source: { kind: string; form: string }; content: Array<{ text: string }> }
  assert.equal(message.source.kind, 'plugin:dsh-chapters', 'autorun authorship stays ours — kind user would launder goal-edit authority')
  assert.equal(message.content[0]!.text, 'narrow the objective to the replay failures')
})

test('the intent rides the wire and gates the client gate too, so the bar cannot disagree with the server', () => {
  const text = [
    'suggested next step: ready',
    '  model: big/qwen (config) — one offer per completed turn',
    '  autorun: armed (1 round(s) started this process)',
    '  turn: 21',
    '  intent: goal-edit — re-cuts the goal, so Run it yourself; autorun will not',
    '  goal: revision 4',
    '  prompt:',
    '    Narrow the goal to the eight remaining defects.',
  ].join('\n')
  const ev = parseBarState(text)
  assert.ok(ev && ev.t === 'polled')
  assert.equal(ev.intent, 'goal-edit')
  assert.equal(ev.text, 'Narrow the goal to the eight remaining defects.')
  let s = promptBarReducer({ ...initialBarState('armed'), running: false }, ev)
  assert.equal(shouldAutoFire({ ...s, goal: { phase: 'paused', activation: 'disarmed', revision: 4 } }), false,
    'the client refuses to auto-run a re-cut even before the server says no — belt and braces on an authority rule')
  s = promptBarReducer(s, { t: 'polled', status: 'ready', text: 'Run the replay.', turnSeq: 22, intent: 'worker-step' })
  assert.equal(shouldAutoFire({ ...s, running: false, goal: GOAL }), false, 'and refuses to double-fire while the driver owns the turn')
  assert.equal(shouldAutoFire({ ...s, running: false, goal: { ...GOAL, activation: 'disarmed' } }), true)
})

test('the full director cycle: offers keep coming while a goal is armed, and one turn starts per boundary', () => {
  const { l, fired, logs } = loop()
  const armedGoal = GOAL
  let turnsStarted = 0
  for (const [turnSeq, revision] of [[30, 3], [31, 3], [32, 4]] as Array<[number, number]>) {
    const state = offer({ turnSeq, goalRevision: revision })
    if (l.maybeFire('S', state, armedGoal)) turnsStarted += 1
  }
  assert.equal(turnsStarted, 0, 'while the driver is armed, our loop starts nothing — at any number of boundaries')
  assert.equal(fired.length, 0)
  assert.equal(logs.filter((m) => m.includes('yielding')).length, 3, 'each yield is reported, once per boundary')
})

test('arming the director loop DISPLACES the goal\'s own continuation — it does not stand aside', () => {
  // The maintainer\'s rule, quoted in docs/contract.md: prompt autorun "can either introduce or replace the
  // autorun by the goal if it is running". My first pass yielded to an armed goal instead, which made the two
  // features mutually exclusive — with a goal armed, a director\'s autorun would have quietly done nothing.
  const disarmed: string[] = []
  const l = makePromptLoop({
    followup: () => undefined,
    maxRounds: () => 10,
    displaceGoal: (id) => { disarmed.push(id); return true },
    log: () => undefined,
  })
  const state = l.setArmed('S', true)
  assert.equal(state.displaced, true, 'the caller is told a handover happened, so the message can name it')
  assert.deepEqual(disarmed, ['S'])
  // …and with the driver disarmed but the goal still ACTIVE as an objective, firing is allowed: the suggestion
  // carries the goal (it was generated from goal/change), it does not compete with it.
  assert.equal(l.maybeFire('S', offer({ goalRevision: 3 }), { phase: 'active', activation: 'disarmed', revision: 3 }), true)
})

test('without the disarm seam the loop degrades to yielding, never to double-firing', () => {
  const l = makePromptLoop({ followup: () => undefined, maxRounds: () => 10, log: () => undefined })
  const state = l.setArmed('S', true)
  assert.equal(state.displaced, false, 'no seam is reported, not faked')
  assert.equal(l.maybeFire('S', offer({ goalRevision: 3 }), GOAL), false,
    'so the armed goal driver still owns the boundary — one turn-starter, either way')
})

test('displacement changes nothing durable: the goal stays the objective the next offer is built from', () => {
  // `GoalService.disarm` is chosen precisely because the host documents it as "without changing durable goal
  // phase or revision". The offer stream must therefore still read the live objective after a handover.
  const { l, fired } = loop({ displace: () => true })
  l.setArmed('S', true)
  assert.equal(l.maybeFire('S', offer({ goalRevision: 3 }), { phase: 'active', activation: 'disarmed', revision: 3 }), true)
  assert.equal(fired.length, 1)
  assert.equal(l.maybeFire('S', offer({ turnSeq: 31, goalRevision: 4 }), { phase: 'active', activation: 'disarmed', revision: 4 }), true,
    'and a human goal edit (revision 3 → 4) keeps the loop alive on the NEW objective')
  assert.equal(fired.length, 2)
})
