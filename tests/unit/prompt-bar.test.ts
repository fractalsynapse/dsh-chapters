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
import { ACTIVE_POLL_MS, QUIET_POLL_MS, barLabel, barVisible, initialBarState, mountPullDecision, parseBarAutorun, parseBarState, parseModelAbsent, pollSpacingFor, promptBarReducer, shouldAutoFire, stateFromCache, pushEventsOf, pushIsFresher, deriveRunning, edgeKickDelayMs, EDGE_DEBOUNCE_MS, EDGE_FLOOR_MS, turnEndPulse, configureQuietHeartbeat } from '../../src/client/prompt-bar.ts'

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
  // #229 supersedes the minute-heartbeat: with no ambient clock configured, a stable disarmed bar
  // schedules NOTHING. The sanctioned moments (pulse, visibility, mount) are the freshness paths.
  assert.equal(pollSpacingFor(base), null, '#229: a stable disarmed bar schedules nothing')
  assert.equal(pollSpacingFor({ ...base, status: 'analyzing' }), ACTIVE_POLL_MS, 'generation in flight: watch it closely')
  assert.equal(pollSpacingFor({ ...base, autorun: 'armed' }), ACTIVE_POLL_MS, 'an armed loop must fire promptly')
  // #221 supersedes: a KNOWN running turn needs no clock — the idle edge (or the quiet heartbeat)
  // on signal-less hosts) catches what follows. The fast clock is for analyzing/armed only.
  assert.equal(pollSpacingFor({ ...base, running: true }), null, '#221+#229: running alone buys no clock at all by default')
  assert.equal(pollSpacingFor({ ...base, status: 'idle' }), null, '#229: idle-and-stable schedules nothing')
  assert.equal(pollSpacingFor({ ...base, hidden: true }), null, 'a hidden quiet tab writes NO history nodes at all')
  assert.equal(pollSpacingFor({ ...base, hidden: true, autorun: 'armed' }), ACTIVE_POLL_MS, 'walking away from an armed loop is the POINT of autorun — never pause it')
  assert.equal(pollSpacingFor({ ...base, hidden: true, status: 'analyzing' }), ACTIVE_POLL_MS, 'and never pause mid-generation')
  // #229: the default IS silence (QUIET = 0); when an operator re-arms a heartbeat it must still be
  // slower than the active clock — that ordering is what "quiet" ever meant.
  configureQuietHeartbeat(60)
  assert.ok(QUIET_POLL_MS > ACTIVE_POLL_MS, 'a configured heartbeat is still slower than the active clock')
  configureQuietHeartbeat(0)
})

test('#203: the mount pull is a decision — a fresh cache renders for free, and only an untrustworthy cache pulls', () => {
  assert.equal(mountPullDecision({ hasCache: false, ageMs: 0, status: 'idle', autorun: 'disarmed' }), true, 'a cold mount (page load) must fetch the truth once')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 1_000, status: 'ready', autorun: 'disarmed' }), false, 'fresh cache + stable + disarmed: activating a session costs ZERO runs')
  // #229: staleness ALONE never pulls without a heartbeat — their tab left open for ten minutes must
  // not resurrect the drumbeat through the mount path; the pulse and visibility edges answer instead.
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 7 * 60_000, status: 'ready', autorun: 'disarmed' }), false, '#229: stale cache + no heartbeat ⇒ no pull')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 1_000, status: 'analyzing', autorun: 'disarmed' }), true, 'generation in flight: see it through')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 1_000, status: 'ready', autorun: 'armed' }), true, 'an armed loop syncs against server truth on sight')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 1_000, status: 'off', autorun: 'disarmed' }), false, 'a FRESH cached off renders hidden for free')
  // #208 SUPERSEDES the #203 revival arm on the maintainer's direction ("not relevant, not
  // visible"): off is TERMINAL for the page lifetime. Revival is a page reload, and the commands
  // that re-enable say so — a guarded pull per reactivation was one visible node too many for a
  // feature that is not on.
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 10 * QUIET_POLL_MS, status: 'off', autorun: 'disarmed' }), false, 'a STALE off stays hidden — the page reload is the revival path, stated by the enabling command')
  // #272: "the page reload is the revival path" only means something if a reload can still SEE that
  // the off predates the page. #251 moved the mirror to localStorage, so it doesn't — an `off`
  // restored from disk was never observed by this page and must pay the one honest reload pull.
  // (The maintainer's tab proved the alternative: a pre-enable off vetoed every reload forever, and
  // the bar stayed invisible behind a mounted component with a ready server row.)
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 1_000, status: 'off', autorun: 'disarmed', cacheFromDisk: true }), true, 'a disk-restored off pays the one honest reload pull (#208 stays terminal for OBSERVED off)')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 1_000, status: 'ready', autorun: 'disarmed', cacheFromDisk: true }), false, '#251 unchanged: a disk-restored READY offer renders with zero commands')
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
  assert.equal(pollSpacingFor({ ...base, running: true }), null, '#221: even a known-running turn keeps no clock — the edge IS the schedule')
  assert.equal(pollSpacingFor({ ...base, status: 'analyzing' }), ACTIVE_POLL_MS, 'a generation completing fires no edge — watch it')
  assert.equal(pollSpacingFor({ ...base, autorun: 'armed' }), ACTIVE_POLL_MS, 'the armed belt: a missed edge must not stall the loop')
  assert.equal(pollSpacingFor({ ...base, hidden: true }), null, 'hidden and stable: still nothing')
  const legacy = { ...base, edges: false }
  assert.equal(pollSpacingFor(legacy), null, '#229 supersedes even the legacy quiet arm: signal-less hosts get NO ambient clock by default')
  assert.equal(pollSpacingFor({ ...legacy, running: true }), null, '#221+#229: the legacy running arm is gone too')
  assert.equal(pollSpacingFor({ ...legacy, hidden: true }), null)
})

test('#208: parseModelAbsent reads the plane-wide fact from the state block — unset model means the feature does not exist', () => {
  const unset = [
    'suggested next step: off',
    '  model: unset (config) — the bar is absent',
    '  autorun: disarmed',
    '  turn: -',
  ].join('\n')
  assert.equal(parseModelAbsent(unset), true, 'the unset line is the one discovery that silences the page')
  const set = [
    'suggested next step: idle',
    '  model: p/m (override) — one offer per completed turn',
    '  autorun: disarmed',
  ].join('\n')
  assert.equal(parseModelAbsent(set), false, 'a set model is relevance, not absence')
  assert.equal(parseModelAbsent('garbage without the line'), false, 'an unrecognised block is never guessed at')
  assert.equal(parseModelAbsent(''), false)
})

test('#194: a pushed payload becomes the same reducer events the pull path uses — and nothing unrecognised ever folds', () => {
  const good = { v: 1, status: 'ready', text: 'ship it', turnSeq: 9, error: '', intent: 'goal-edit', autorun: 'armed' }
  const evs = pushEventsOf(good)
  assert.ok(evs !== null)
  const st = promptBarReducer(promptBarReducer(initialBarState(), evs.polled), evs.autorun)
  assert.equal(st.status, 'ready')
  assert.equal(st.text, 'ship it')
  assert.equal(st.turnSeq, 9)
  assert.equal(st.intent, 'goal-edit', 'a pushed GOAL: classification still holds the offer for the keystroke')
  assert.equal(st.autorun, 'armed')
  assert.equal(pushEventsOf({ v: 2, status: 'ready', text: 'x' }), null, 'a future version never folds')
  assert.equal(pushEventsOf(null), null)
  assert.equal(pushEventsOf({ v: 1, status: 'bogus', text: 'x' }), null, 'an unknown status is ignored, not guessed at')
  // analyzing with no text is honest progress, not a malformed push — the earlier draft of this row
  // asserted a value against ITSELF (a tautology is a row that can never fail, which is worse than no row)
  const analyzing = pushEventsOf({ v: 1, status: 'analyzing' })
  assert.ok(analyzing !== null)
  assert.deepEqual(analyzing.polled, { t: 'polled', status: 'analyzing' })
})

test('#194: deriveRunning folds the useSession snapshot — the seat the contract names', () => {
  // The precedence expression itself (scalar → snapshot → unknown) lives in the dock as ONE
  // expression, pinned by the source-scan row in prompt-dock-placement.test.ts; these arms pin the
  // snapshot fold. A second pure helper for the same decision was removed — #59.
  assert.equal(deriveRunning({ running: true }), true)
  assert.equal(deriveRunning({ running: false }), false)
  assert.equal(deriveRunning(undefined), undefined, 'no snapshot: unknown stays unknown')
})

test('#194: the staleness-confirm fires only when the push stayed silent past the edge', () => {
  assert.equal(pushIsFresher(150, 100), true, 'a push after the edge cancels the confirm')
  assert.equal(pushIsFresher(50, 100), false, 'a push from before the edge confirms nothing')
  assert.equal(pushIsFresher(null, 100), false, 'no push ever: the confirm runs and the pull covers')
})

test('#211: the edge kick is debounced and rate-floored — step-granular running flicker costs ZERO pulls', () => {
  assert.equal(edgeKickDelayMs(Number.MAX_SAFE_INTEGER), EDGE_DEBOUNCE_MS, 'a cold edge waits just the debounce')
  assert.equal(edgeKickDelayMs(0), EDGE_FLOOR_MS, 'an edge immediately after a pull waits out the whole floor')
  assert.equal(edgeKickDelayMs(10_000), 5_000, 'mid-floor: the remainder, never less than the debounce')
  assert.equal(edgeKickDelayMs(EDGE_FLOOR_MS + 1), EDGE_DEBOUNCE_MS, 'past the floor: the debounce is the minimum')
  assert.ok(EDGE_FLOOR_MS > EDGE_DEBOUNCE_MS)
})

test('#218: pushEventsOf arms — turnSeq/error defaults and the goalRevision field ride the payload', () => {
  const evs = pushEventsOf({ v: 1, status: 'failed', text: '', turnSeq: 5, error: 'the model call failed', intent: 'worker-step', goalRevision: 3, autorun: 'armed' })
  assert.ok(evs !== null)
  const st = promptBarReducer(promptBarReducer(initialBarState(), evs.polled), evs.autorun)
  assert.equal(st.status, 'failed')
  assert.ok((st.error ?? '').includes('model call'), 'the error rides the pushed event')
  assert.equal(st.autorun, 'armed')
  const noTurn = pushEventsOf({ v: 1, status: 'ready', text: 'x' })
  assert.ok(noTurn !== null, 'a payload without turnSeq/goalRevision is still accepted (defaults)')
  const st2 = promptBarReducer(initialBarState(), noTurn.polled)
  assert.equal(st2.turnSeq, null, 'absent turnSeq defaults to null')
  assert.equal(pushEventsOf(undefined), null)
  assert.equal(pushEventsOf('string'), null)
  assert.ok(pushEventsOf({ v: 1, status: 'ready', text: 'x', intent: 'bogus' } as unknown) !== null, 'an unknown intent defaults to worker-step — the payload gate is version + status, not every field')
})

test('#221: the fast clock serves only real work — analyzing or armed; unknown-running never pins it', () => {
  const base = { status: 'idle' as const, autorun: 'disarmed' as const, running: false, hidden: false, edges: false }
  assert.equal(pollSpacingFor(base), null, 'idle + disarmed + no signal: silence — #229 killed the ambient clock')
  assert.equal(pollSpacingFor({ ...base, running: true }), null, 'a stuck-true running signal gets NOTHING by default (#229)')
  assert.equal(pollSpacingFor({ ...base, status: 'analyzing' }), ACTIVE_POLL_MS, 'generation in flight deserves the fast clock')
  assert.equal(pollSpacingFor({ ...base, autorun: 'armed' }), ACTIVE_POLL_MS, 'an armed loop deserves it too')
  assert.equal(pollSpacingFor({ ...base, status: 'ready', autorun: 'armed' }), ACTIVE_POLL_MS)
})

test('#229: schedule simulation over the maintainer\'s measured session shape — ZERO ambient pulls', () => {
  // Their log after 0.2.11: exact 60.0s gaps while a tab sat open doing nothing. The fixed rule has
  // no ambient arm at all: simulate 60 minutes of idle (status ready/idle, disarmed, no pulse) and
  // count scheduled pulls through pollSpacingFor — the honest answer is zero.
  let t = 0
  let pulls = 0
  const spacing = pollSpacingFor({ status: 'ready', autorun: 'disarmed', running: true, hidden: false, edges: false })
  assert.equal(spacing, null, 'the default schedule for an idle bar is NO TIMER')
  while (t < 60 * 60_000) { t += 10_000 } // the old drumbeat's period; nothing fires against a null timer
  assert.equal(pulls, 0, `zero ambient pulls in an hour (counted ${String(pulls)})`)
})

test('#221: a turn-end pulse pulls fast in BOTH modes — it is the sanctioned moment, not a clock', () => {
  const calm = { status: 'idle' as const, autorun: 'disarmed' as const, running: false, hidden: false }
  assert.equal(pollSpacingFor({ ...calm, edges: false }), null, 'no pulse: silence on a signal-less host (#229 default)')
  assert.equal(pollSpacingFor({ ...calm, edges: false, turnEndPulse: true }), ACTIVE_POLL_MS, 'pulse: follow up fast until the offer lands')
  assert.equal(pollSpacingFor({ ...calm, edges: true, turnEndPulse: true }), ACTIVE_POLL_MS, 'edge hosts get the same courtesy')
})

test('#221: turnEndPulse fires exactly once per new turn boundary, never on absence or repeats', () => {
  assert.deepEqual(turnEndPulse(5, 0), { pulse: true, seen: 5 }, 'a new boundary pulses')
  assert.deepEqual(turnEndPulse(5, 5), { pulse: false, seen: 5 }, 'the SAME boundary never re-pulses')
  assert.deepEqual(turnEndPulse(undefined, 0), { pulse: false, seen: 0 }, 'absent projection: silence, not a storm')
  assert.deepEqual(turnEndPulse(null, 7), { pulse: false, seen: 7 }, 'null is absence')
  assert.deepEqual(turnEndPulse(3, 9), { pulse: false, seen: 9 }, 'a smaller seq (session swap) never rewinds the stamp')
})

test('#229: the ambient heartbeat is OFF by default — a disarmed idle bar schedules NOTHING', () => {
  // The maintainer's rule, absolute after six incidents: never repeated chapters-prompt executions.
  // Measured on their live log even with 0.2.11 installed correctly: exact 60.0s pull gaps — the
  // quiet heartbeat WAS the drumbeat. Default QUIET_POLL_MS = 0 ⇒ no clock while disarmed+stable.
  assert.equal(QUIET_POLL_MS, 0, 'the shipped default has no ambient clock')
  const calm = { status: 'idle' as const, autorun: 'disarmed' as const, running: false, hidden: false }
  assert.equal(pollSpacingFor({ ...calm, edges: false }), null, 'signal-less host, disarmed: silence, not a minute-timer')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 10 * 60_000, status: 'idle', autorun: 'disarmed' }), false, 'staleness alone never pulls without a heartbeat (#229)')
  assert.equal(mountPullDecision({ hasCache: false, ageMs: 0, status: 'idle', autorun: 'disarmed' }), true, 'mount discovery still happens once per page load')
  assert.equal(mountPullDecision({ hasCache: true, ageMs: 10 * 60_000, status: 'analyzing', autorun: 'disarmed' }), true, 'in-flight generation stays trustworthy-pullable')
})

test('#229: configureQuietHeartbeat re-arms only from a real positive setting; parse learns it from the reply', () => {
  configureQuietHeartbeat(30)
  assert.equal(QUIET_POLL_MS, 30_000, 'an operator CAN ask for a heartbeat')
  const calm = { status: 'idle' as const, autorun: 'disarmed' as const, running: false, hidden: false }
  assert.equal(pollSpacingFor({ ...calm, edges: false }), 30_000, 'and it behaves exactly like the old quiet arm')
  configureQuietHeartbeat(0)
  assert.equal(QUIET_POLL_MS, 0, 'zero means none')
  configureQuietHeartbeat(undefined)
  assert.equal(QUIET_POLL_MS, 0, 'absent means none')
  // the state reply carries it end-to-end
  const ev = parseBarState(['suggested next step: idle', '  model: p/m (override) — one offer per completed turn', '  autorun: disarmed', '  turn: -', '  intent: worker-step', '  goal: none', '  heartbeat: 45s'].join('\n'))
  assert.ok(ev !== null, 'a reply WITH the heartbeat line parses')
  assert.equal(QUIET_POLL_MS, 45_000, 'and configures the client schedule from the SERVER setting')
  configureQuietHeartbeat(0)
})

test('#243: the click-to-expand contract — expand never hides, and a re-pull of the same row keeps it visible', () => {
  // The maintainer's report: clicking the prompt text made the WHOLE bar disappear. Ruled in here:
  // the reducer path must be innocent — expand flips a flag; `polled` with the SAME facts keeps the
  // row visible; only off/dismiss-empty-ready hide. If this stays green while the field fails, the
  // fault is render-side (stale bundle or a throw), which is what #243's reproduction plan checks.
  const ready = { t: 'polled', status: 'ready', text: 'run the tests', turnSeq: 12 } as const
  let s = promptBarReducer(initialBarState(), ready)
  assert.equal(barVisible(s), true, 'a ready offer renders')
  s = promptBarReducer(s, { t: 'expand' })
  assert.equal(barVisible(s), true, 'expanding keeps it rendering')
  // a sanctioned re-read of the same durable row after the click (the state verb answers from peekRow)
  s = promptBarReducer(s, ready)
  assert.equal(barVisible(s), true, 're-folding the identical row does not hide the bar')
  assert.equal(s.text, 'run the tests', 'and the offer survives the click intact')
})
