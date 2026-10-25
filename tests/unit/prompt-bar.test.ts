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
import { barLabel, barVisible, initialBarState, parseBarAutorun, parseBarState, promptBarReducer, shouldAutoFire } from '../../src/client/prompt-bar.ts'

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
