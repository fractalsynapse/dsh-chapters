/**
 * The Suggested Next Step bar's decisions, pure and un-React'd (#113) — the same discipline as
 * `prompt-ghost.ts` had, and the same reason: everything the maintainer complained about (firing at the
 * wrong time, shouting a refusal, an offer that can't be read or acted on) is a DECISION, and a decision
 * belongs where a row can pin it.
 *
 * State split mirrors the goal bar exactly: `status`/`text`/`turnSeq` are the server's durable facts,
 * `autorun`/`expanded` are process-local intent and are never persisted.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { barLabel, barVisible, initialBarState, parseBarAutorun, parseBarState, promptBarReducer, shouldAutoFire, pollSpacingFor, ACTIVE_POLL_MS, QUIET_POLL_MS, mountPullDecision, stateFromCache} from '../../src/client/prompt-bar.ts'

test('labels and visibility: analyzing, ready, failed, and the silence cases', () => {
  let s = promptBarReducer(initialBarState(), { t: 'polled', status: 'analyzing' })
  assert.equal(barLabel(s), 'Analyzing situation…')
  assert.equal(barVisible(s), true, 'the bar appears as soon as work is in flight — that is the goal bar behavior')

  s = promptBarReducer(s, { t: 'polled', status: 'ready', text: 'Land #114 and cut 0.2.2.', turnSeq: 41 })
  assert.equal(barLabel(s), 'Recommended Next Step')

  const failed = promptBarReducer(s, { t: 'polled', status: 'failed', error: 'model call failed (503)', turnSeq: 41 })
  assert.equal(barLabel(failed), 'Recommended Next Step')
  assert.equal(failed.error, 'model call failed (503)', 'a detected failure is a DELIVERED failure (#61) — never a blank row')

  assert.equal(barVisible(promptBarReducer(s, { t: 'polled', status: 'off' })), false, 'off renders nothing')
})

test('expanding is a reading action; collapsing keeps the offer, and only an armed bar may auto-fire', () => {
  let s = promptBarReducer({ ...initialBarState('armed'), status: 'ready', text: 'Do the thing.', turnSeq: 7 }, { t: 'polled', status: 'ready', text: 'Do the thing.', turnSeq: 7 })
  // The row that pins the DEFAULT is the one that matters: a fresh bar is never armed (#113 spec — nothing
  // autoruns that a human did not opt into). Expanding is orthogonal to that.
  assert.equal(initialBarState().autorun, 'disarmed', 'disarmed by construction; `armed` must be opted into')
  s = promptBarReducer(s, { t: 'expand' })
  assert.equal(s.expanded, true)
  assert.equal(shouldAutoFire({ ...s, running: false }), true, 'armed + ready + idle fires; the component then does setDraft→submit')

  const collapsed = promptBarReducer(s, { t: 'collapse' })
  assert.equal(collapsed.expanded, false, 'collapsing keeps the offer — it does not dismiss it')
  assert.equal(collapsed.text, 'Do the thing.', 'and keeps its text: dismissal is a different event entirely')
})

test('autorun fires only when armed, ready, idle, and not hiding this turn', () => {
  const ready = { ...initialBarState(), status: 'ready' as const, text: 'Go.', turnSeq: 9 }
  assert.equal(shouldAutoFire({ ...ready, running: false }), false, 'disarmed by default — nothing autoruns a human did not opt into')
  assert.equal(shouldAutoFire({ ...ready, autorun: 'armed', running: false }), true)
  assert.equal(shouldAutoFire({ ...ready, autorun: 'armed', running: true }), false, 'never while a turn is running')
  assert.equal(shouldAutoFire({ ...ready, autorun: 'armed', running: false, hiddenTurnSeq: 9 }), false, 'a suspended offer stays suspended')
})

test('a human prompt suspends autorun and hides that offer, but later turns still suggest', () => {
  let s = promptBarReducer({ ...initialBarState('armed'), status: 'ready', text: 'Go.', turnSeq: 9 }, { t: 'polled', status: 'ready', text: 'Go.', turnSeq: 9 })
  s = promptBarReducer(s, { t: 'human/prompt' })
  assert.equal(s.autorun, 'disarmed', 'the human took the wheel — autorun yields until re-armed')
  assert.equal(s.hiddenTurnSeq, 9, 'the offer that was on screen is dismissed, not left dangling')
  const next = promptBarReducer(s, { t: 'polled', status: 'ready', text: 'Continue?', turnSeq: 12 })
  assert.equal(barVisible(next), true, 'a NEW turn is a fresh offer')
  assert.equal(next.autorun, 'disarmed', 'and it does not silently re-arm')
})

test('the goal completes: autorun disarms itself, per spec', () => {
  const armed = { ...initialBarState('armed'), status: 'ready' as const, text: 'Go.', turnSeq: 3 }
  const done = promptBarReducer(armed, { t: 'goal', phase: 'complete' })
  assert.equal(done.autorun, 'disarmed', 'the suggestion loop served a purpose; when the purpose ends, it stops')
  assert.equal(shouldAutoFire({ ...armed, running: false, goalPhase: 'complete' }), false)
  assert.equal(promptBarReducer(armed, { t: 'goal', phase: 'active' }).autorun, 'armed', 'an active goal runs ALONGSIDE it, not instead of it')
})

test('off hides and keeps the model, so back-on is one action', () => {
  const on = { ...initialBarState('armed'), status: 'ready' as const, text: 'Go.', turnSeq: 3 }
  const off = promptBarReducer(on, { t: 'off' })
  assert.equal(barVisible(off), false)
  assert.equal(off.status, 'off')
  assert.equal(off.text, null, 'the stale offer is dropped, not kept out of sight to be resumed later')
})

test('the state payload parses without guessing at what it did not say', () => {
  const ready = [
    'suggested next step: ready',
    '  model: local/qwen (config) — one offer per completed turn',
    '  autorun: armed (2 round(s) started this process)',
    '  turn: 41',
    '  prompt:',
    '    Land #114 and cut 0.2.2.',
    '    Then wire the docked bar.',
  ].join('\n')
  const ev = parseBarState(ready)
  assert.ok(ev && ev.t === 'polled')
  assert.equal(ev.status, 'ready')
  assert.equal(ev.turnSeq, 41)
  assert.equal(ev.text, 'Land #114 and cut 0.2.2.\nThen wire the docked bar.', 'multi-line prompt rejoined, indent stripped')
  assert.equal(parseBarAutorun(ready), 'armed')

  const failed = ['suggested next step: failed', '  turn: 12', '  error: no route for the suggestion model'].join('\n')
  const fev = parseBarState(failed)
  assert.ok(fev && fev.t === 'polled')
  assert.equal(fev.status, 'failed')
  assert.equal(fev.error, 'no route for the suggestion model', 'the reason survives the wire (#61)')

  // Absence is not a state. A payload we cannot read must NOT become `off` — that would hide a bar whose
  // server is merely mid-reply, which is the "silence where there should be a fact" class again.
  assert.equal(parseBarState('some other command output'), null)
  assert.equal(parseBarAutorun('no autorun line here'), null)
})

test('a parsed payload drives the same reducer the component uses', () => {
  const ev = parseBarState('suggested next step: ready\n  turn: 7\n  prompt:\n    Go on.')
  assert.ok(ev)
  const s = promptBarReducer(initialBarState(), ev)
  assert.equal(barLabel(s), 'Recommended Next Step')
  assert.equal(s.text, 'Go on.')
  assert.equal(s.turnSeq, 7)
})

/**
 * Autorun's idle edge, derived from the hook shape the dock actually receives (#113).
 *
 * The gate must fail SAFE: `unknown` means "do not start a turn the human did not ask for", and conflating
 * unknown with idle would let the loop fire blind. These rows exist because my first implementation waited for
 * a scalar `props.running` that no host supplies, so the feature reported itself unavailable forever.
 */
test('deriveRunning folds every host shape, and keeps unknown unknown', async () => {
  const { deriveRunning } = await import('../../src/client/prompt-bar.ts')
  assert.equal(deriveRunning('running'), true)
  assert.equal(deriveRunning('idle'), false)
  assert.equal(deriveRunning({ status: 'streaming' }), true)
  assert.equal(deriveRunning({ state: 'waiting' }), false)
  assert.equal(deriveRunning({ running: true }), true)
  assert.equal(deriveRunning(undefined), undefined, 'absent hook result is unknown, never idle')
  assert.equal(deriveRunning(null), undefined)
  assert.equal(deriveRunning('something else entirely'), undefined, 'an unrecognized word is not evidence of idle')
  assert.equal(deriveRunning({}), undefined)
})

test('#188: a BLOCKED goal disarms autorun and blocks firing, exactly like a completed one — both planes stop together', () => {
  const armed = promptBarReducer({ ...initialBarState('armed'), status: 'ready', text: 'step', turnSeq: 1 }, { t: 'goal', phase: 'blocked' })
  assert.equal(armed.autorun, 'disarmed', 'a loop firing offers at a blocked goal outlived its purpose')
  assert.equal(armed.goalPhase, 'blocked')
  const ready = { ...initialBarState('armed'), status: 'ready' as const, text: 'step', turnSeq: 1, goalPhase: 'blocked' as const }
  assert.equal(shouldAutoFire(ready), false, 'and the fire predicate agrees with the reducer')
})

test('#193: cadence is a decision — active while state can change, quiet while stable, SILENT in a hidden tab unless the loop is armed', () => {
  const base = { status: 'ready' as const, autorun: 'disarmed' as const, running: false, hidden: false, edges: false }
  assert.equal(pollSpacingFor(base), QUIET_POLL_MS, 'a stable bar costs one pull a minute, not six — every pull is two history nodes')
  assert.equal(pollSpacingFor({ ...base, status: 'analyzing' }), ACTIVE_POLL_MS, 'generation in flight: watch it closely')
  assert.equal(pollSpacingFor({ ...base, autorun: 'armed' }), ACTIVE_POLL_MS, 'an armed loop must fire promptly')
  assert.equal(pollSpacingFor({ ...base, running: true }), ACTIVE_POLL_MS, 'a turn in flight ends into a new offer')
  assert.equal(pollSpacingFor({ ...base, status: 'idle' }), QUIET_POLL_MS, 'idle-and-stable is the quiet case')
  assert.equal(pollSpacingFor({ ...base, hidden: true }), null, 'a hidden quiet tab writes NO history nodes at all')
  assert.equal(pollSpacingFor({ ...base, hidden: true, autorun: 'armed' }), ACTIVE_POLL_MS, 'walking away from an armed loop is the POINT of autorun — never pause it')
  assert.equal(pollSpacingFor({ ...base, hidden: true, status: 'analyzing' }), ACTIVE_POLL_MS, 'and never pause mid-generation')
  assert.ok(QUIET_POLL_MS > ACTIVE_POLL_MS, 'quiet must actually be quieter')
})

test('#203: the mount pull is a decision — a fresh cache renders for free, and only an untrustworthy cache pulls', () => {
  assert.equal(mountPullDecision({ hasCache: false, ageMs: 0, status: 'idle', autorun: 'disarmed' }), true, 'a cold mount (page load) must fetch the truth once')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 1_000, status: 'ready', autorun: 'disarmed' }), false, 'fresh cache + stable + disarmed: activating a session costs ZERO runs')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: QUIET_POLL_MS + 1, status: 'ready', autorun: 'disarmed' }), true, 'the staleness guard: a turn could have ended since — this is what keeps Run honest')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 1_000, status: 'analyzing', autorun: 'disarmed' }), true, 'generation in flight: see it through')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 1_000, status: 'ready', autorun: 'armed' }), true, 'an armed loop syncs against server truth on sight')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 1_000, status: 'off', autorun: 'disarmed' }), false, 'a FRESH cached off renders hidden for free')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 10 * QUIET_POLL_MS, status: 'off', autorun: 'disarmed' }), true, 'a STALE off must be revisitable — /chapters-prompt on happened somewhere, and the staleness guard is the revival path')
})

test('#203: stateFromCache folds cached wire events back through the SAME reducer — no second fold path to drift', () => {
  const st = stateFromCache({ t: 'polled', status: 'ready', text: 'ship it', turnSeq: 7, intent: 'worker-step' }, 'armed')
  assert.equal(st.status, 'ready')
  assert.equal(st.text, 'ship it')
  assert.equal(st.turnSeq, 7)
  assert.equal(st.intent, 'worker-step')
  assert.equal(st.autorun, 'armed')
  const off = stateFromCache({ t: 'polled', status: 'off' }, null)
  assert.equal(off.status, 'off')
  assert.equal(off.autorun, 'disarmed')
})

test('#203: where the host publishes the running edge, a stable disarmed bar has NO clock at all', () => {
  const base = { status: 'ready' as const, autorun: 'disarmed' as const, running: false, hidden: false, edges: true }
  assert.equal(pollSpacingFor(base), null, 'edges + stable: a timer could only re-read truth into history nodes — the idle edge IS the schedule')
  assert.equal(pollSpacingFor({ ...base, running: true }), null, 'a turn in flight ends into the edge, and the edge pulls')
  assert.equal(pollSpacingFor({ ...base, status: 'analyzing' }), ACTIVE_POLL_MS, 'a generation completing fires no edge — watch it')
  assert.equal(pollSpacingFor({ ...base, autorun: 'armed' }), ACTIVE_POLL_MS, 'the armed belt: a missed edge must not stall the loop')
  assert.equal(pollSpacingFor({ ...base, hidden: true }), null, 'hidden and stable: still nothing')
  const legacy = { ...base, edges: false }
  assert.equal(pollSpacingFor(legacy), QUIET_POLL_MS, 'a host without the prop keeps the #193 cadence UNCHANGED')
  assert.equal(pollSpacingFor({ ...legacy, running: true }), ACTIVE_POLL_MS)
  assert.equal(pollSpacingFor({ ...legacy, hidden: true }), null)
})
