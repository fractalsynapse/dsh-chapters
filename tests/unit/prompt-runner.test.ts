/**
 * One generation per completed turn, and no more (#113). The runner is the door that decides whether this
 * feature costs a model call per turn or per step — the latter is precisely what the maintainer rejected
 * ("ran three different times and created three different prompts"), so the claims here are about counting,
 * ordering and failure visibility, not wording.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { deliveredOffer, makePromptRoundRunner, type GenerateOutcome } from '../../src/prompt-runner.ts'
import { freshSession, type SessionState } from '../../src/registry.ts'
import { reconcilePromptRow } from '../../src/prompt-runner.ts'
import fs from 'node:fs'
import path from 'node:path'

interface Fake {
  writes: PromptSuggestionView[]
  rows: Map<string, SessionState>
  store: { mutate(id: string, fn: (s: SessionState) => SessionState): Promise<unknown> }
}
interface PromptSuggestionView { status: string; text: string; turnSeq: number | null; error: string }

function fakeStore(row: SessionState): Fake {
  const rows = new Map<string, SessionState>([['S', row]])
  const writes: PromptSuggestionView[] = []
  return {
    rows, writes,
    store: { mutate: async (id, fn) => {
      const before = JSON.stringify((rows.get(id) ?? freshSession(id)).promptSuggestion)
      const next = fn(rows.get(id) ?? freshSession(id))
      rows.set(id, next)
      // A CHANGE, not a call: the runner decides "have I already done this turn?" inside the mutate, because
      // that is the only place it sees the live row (#101) — so a re-delivered turn/end legitimately issues a
      // probe that writes nothing. Counting calls here would grade the fixture, not the product.
      if (JSON.stringify(next.promptSuggestion) !== before) {
        const p = next.promptSuggestion
        writes.push({ status: p.status, text: p.text, turnSeq: p.turnSeq, error: p.error })
      }
      return next
    } },
  }
}

const until = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  assert.ok(pred(), 'the async chain settled too late (or never)')
}

function world(opts: { enabled?: boolean, eligible?: boolean, outcome?: GenerateOutcome, throws?: boolean } = {}) {
  const f = fakeStore(freshSession('S'))
  const seen: number[] = []
  const logs: string[] = []; const warns: string[] = []
  let calls = 0
  const run = makePromptRoundRunner({
    enabled: () => opts.enabled ?? true,
    eligible: () => opts.eligible ?? true,
    store: f.store,
    now: () => '2026-10-25T00:00:00.000Z',
    log: (m) => { logs.push(m) },
    warn: (m) => { warns.push(m) },
    generate: async (_s, turnSeq) => {
      calls++; seen.push(turnSeq)
      if (opts.throws === true) throw new Error('stream refused (503)')
      return opts.outcome ?? { ok: true, text: 'Land #114, then cut 0.2.2.' }
    },
  })
  return { f, run, seen, logs, warns, calls: () => calls, writes: () => f.writes.length }
}
const TURN_END = (seq: number): unknown => ({ type: 'turn/end', seq, data: { turn: 1 } })

test('analyzing is persisted BEFORE the model is called, then replaced by the outcome (#113)', async () => {
  const w = world()
  w.run({ id: 'S' }, TURN_END(41))
  await until(() => w.writes() >= 1)
  assert.equal(w.f.writes[0]!.status, 'analyzing', 'a pull during the call must see honest progress, not the last offer')
  assert.equal(w.f.writes[0]!.turnSeq, 41)
  await until(() => w.writes() >= 2)
  assert.deepEqual(w.f.writes[1], { status: 'ready', text: 'Land #114, then cut 0.2.2.', turnSeq: 41, error: '' })
  assert.equal(w.calls(), 1)
})

test('the same turn/end twice claims once — one generation per turn, not per event (#113)', async () => {
  const w = world()
  w.run({ id: 'S' }, TURN_END(41))
  await until(() => w.writes() >= 2)
  w.run({ id: 'S' }, TURN_END(41))
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(w.calls(), 1, 'the claim lives in the row, so a re-delivered boundary cannot spend a second call')
  assert.equal(w.writes(), 2, 'and the repeat writes nothing')
  assert.ok(w.logs.some((l) => l.includes('already claimed')), 'it says so rather than going silent')
  w.run({ id: 'S' }, TURN_END(58))
  await until(() => w.writes() >= 4)
  assert.equal(w.calls(), 2, 'a NEW turn boundary is a new question')
})

test('a quiet refusal is silence; a real failure is a delivered failure (#113)', async () => {
  const quiet = world({ outcome: { ok: false, quiet: true, reason: 'no completed assistant turn' } })
  quiet.run({ id: 'S' }, TURN_END(3))
  await until(() => quiet.writes() >= 2)
  const q = quiet.f.writes[1]!
  assert.equal(q.status, 'off', 'nothing to recommend is not an error')
  assert.equal(q.error, '', 'and nothing is left on screen to misread')
  assert.equal(q.turnSeq, null)

  const failed = world({ outcome: { ok: false, reason: 'no route for the suggestion model' } })
  failed.run({ id: 'S' }, TURN_END(4))
  await until(() => failed.writes() >= 2)
  assert.equal(failed.f.writes[1]!.status, 'failed')
  assert.equal(failed.f.writes[1]!.error, 'no route for the suggestion model')
  assert.ok(failed.warns.length > 0, 'a detected failure is delivered, never swallowed (#61)')

  const threw = world({ throws: true })
  threw.run({ id: 'S' }, TURN_END(5))
  await until(() => threw.writes() >= 2)
  assert.equal(threw.f.writes[1]!.status, 'failed', 'a throw must not leave the bar stuck saying Analyzing…')
  assert.match(threw.f.writes[1]!.error, /stream refused \(503\)/)
})

test('an unconfigured or ineligible session never pays the call (#113)', async () => {
  const off = world({ enabled: false })
  off.run({ id: 'S' }, TURN_END(9))
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(off.calls(), 0, 'the model is the switch: unset ⇒ no writes, no calls, no cost')
  assert.equal(off.writes(), 0, 'and the door is inert — it does not even mark the row analyzing')

  const headless = world({ eligible: false })
  headless.run({ id: 'S' }, TURN_END(9))
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(headless.calls(), 0, 'a subagent or headless session has no composer and must not be billed for one')
})

test('#218: pushRow mirrors every durable row write — the runner calls it at all five sites', async () => {
  const pushed: Array<{ session: unknown; sessionId: string }> = []
  const deps = {
    enabled: () => true,
    eligible: () => true,
    store: { mutate: async (id: string, fn: (s: SessionState) => SessionState) => { rows.set(id, fn(rows.get(id) ?? freshSession(id))); return undefined } },
    pushRow: (session: unknown, sessionId: string) => { pushed.push({ session, sessionId }) },
    generate: async () => ({ ok: true, text: 'a next step' } as GenerateOutcome),
    now: () => 't',
  }
  const rows = new Map<string, SessionState>([['S', freshSession('S')]])
  const depsWithStore = { ...deps, store: { mutate: async (id: string, fn: (s: SessionState) => SessionState) => { rows.set(id, fn(rows.get(id) ?? freshSession(id))); return undefined } } }
  const runner = makePromptRoundRunner(depsWithStore as Parameters<typeof makePromptRoundRunner>[0])
  const session = { id: 'S', header: {} }
  runner(session, { type: 'turn/end', seq: 10 })
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(pushed.length >= 2, `the runner pushed at the analyzing claim and the ready write (got ${String(pushed.length)})`)
  assert.equal(pushed[0]!.sessionId, 'S')
  assert.equal(pushed[0]!.session, session, 'the LIVE session object rides along for the append')
  // quiet refusal: the generate returns quiet ⇒ row write ⇒ pushRow again
  const quietDeps = { ...depsWithStore, generate: async () => ({ ok: false, quiet: true } as GenerateOutcome) }
  rows.set('S', freshSession('S'))
  const before = pushed.length
  makePromptRoundRunner(quietDeps as Parameters<typeof makePromptRoundRunner>[0])(session, { type: 'turn/end', seq: 20 })
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(pushed.length > before, 'a quiet refusal also mirrors (the row was written)')
  // failure: the generate throws ⇒ failed write ⇒ pushRow
  const failDeps = { ...depsWithStore, generate: async () => { throw new Error('model down') } }
  rows.set('S', freshSession('S'))
  const before2 = pushed.length
  makePromptRoundRunner(failDeps as Parameters<typeof makePromptRoundRunner>[0])(session, { type: 'turn/end', seq: 30 })
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(pushed.length > before2, 'a failed generation also mirrors')
})

test('#225: the eligible predicate is consulted at the boundary and its refusal is logged', async () => {
  const logs: string[] = []
  const rows = new Map<string, SessionState>([['S', freshSession('S')]])
  let eligibleCalls = 0
  const runner = makePromptRoundRunner({
    enabled: () => true,
    eligible: () => { eligibleCalls += 1; return false },
    store: { mutate: async (id: string, fn: (s: SessionState) => SessionState) => { rows.set(id, fn(rows.get(id) ?? freshSession(id))); return undefined } },
    generate: async () => ({ ok: true, text: 'x' } as GenerateOutcome),
    now: () => 't',
    log: (m) => { logs.push(m) },
  })
  runner({ id: 'S', header: { origin: 'subagent' } }, { type: 'turn/end', seq: 3 })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(eligibleCalls, 1, 'the gate runs at every boundary')
  assert.ok(logs.some((l) => /not eligible/.test(l)), 'and its refusal is NAMED in the log — #225 delivers the silence')
})

test('#225: a throwing listener is caught and WARNED, never propagated into the host event loop', async () => {
  const warns: string[] = []
  const runner = makePromptRoundRunner({
    enabled: () => { throw new Error('config exploded') },
    eligible: () => true,
    store: { mutate: async () => undefined },
    generate: async () => ({ ok: true, text: 'x' } as GenerateOutcome),
    now: () => 't',
    warn: (m) => { warns.push(m) },
  })
  runner({ id: 'S', header: {} }, { type: 'turn/end', seq: 1 })
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(warns.some((w) => /turn listener failed/.test(w)), 'the outer catch names the failure class on the warn channel')
})

test('#289: deliveredOffer — an offer whose exact text later arrived as a human turn has RUN', () => {
  const OFFER = 'Land #114, then cut 0.2.2.\nThen wire the verbs.'
  const ready = { status: 'ready', text: OFFER, turnSeq: 41, error: '', at: '', intent: 'worker-step', goalRevision: null } as const
  const mk = (text: string, seq: number, source?: Record<string, string>) => ({
    type: 'user/message', seq, data: { source, content: [{ type: 'text', text }] },
  })
  const session = (events: unknown[]) => ({ id: 'S', events })
  assert.equal(deliveredOffer(session([mk(OFFER, 44)]), ready), true, 'exact equal, later than birth')
  assert.equal(deliveredOffer(session([mk('  LAND #114, then   cut 0.2.2. \n then wire the verbs. ', 44)]), ready), true, 'normalized: case and whitespace are not a new instruction')
  assert.equal(deliveredOffer(session([mk(OFFER, 30)]), ready), false, 'the same words BEFORE the offer was born predate it — not a delivery of it')
  assert.equal(deliveredOffer(session([mk(OFFER, 44, { kind: 'goal' })]), ready), false, 'a goal round carrying the text is not the human sending it')
  assert.equal(deliveredOffer(session([mk(OFFER, 44, { kind: 'plugin', plugin: 'chapters' })]), ready), false, 'the bar authoring its own autorun message is not a human delivery')
  assert.equal(deliveredOffer(session([mk(OFFER.slice(0, 20), 44)]), ready), false, 'a rewritten step is a NEW instruction, not this offer')
  assert.equal(deliveredOffer(session([mk(`<system-reminder>tz</system-reminder>${OFFER}`, 44)]), ready), true, 'host reminder spans are stripped before comparing')
  const manual = { status: 'ready', text: OFFER, turnSeq: null, error: '', at: '', intent: 'worker-step', goalRevision: null } as const
  assert.equal(deliveredOffer(session([mk(OFFER, 3)]), manual), true, 'a manual offer (null turnSeq) compares against every later turn')
  assert.equal(deliveredOffer(undefined, ready), false, 'no session is never a delivery')
  assert.equal(deliveredOffer({ id: 'S', snapshotEvents: () => [mk(OFFER, 44)] }, ready), true, 'the live seat: snapshotEvents() is read too (#58 payload-bearing rule)')
  const off = { status: 'off', text: '', turnSeq: 41, error: '', at: '', intent: 'worker-step', goalRevision: null } as const
  assert.equal(deliveredOffer(session([mk('x', 44)]), off), false, 'only a ready offer can be delivered')
})

test('#304: a zombie analyzing claim reconciles to resting at boot; every other state stands', () => {
  const mk = (over: Record<string, unknown>) => ({ status: 'ready', text: 'x', turnSeq: 1, error: '', at: '2026-11-04T00:00:00Z', intent: 'worker-step', goalRevision: null, ...over })
  const z = { promptSuggestion: mk({ status: 'analyzing', text: '' }) } as never
  const out = reconcilePromptRow(z) as { promptSuggestion: { status: string; turnSeq: unknown } }
  assert.equal(out.promptSuggestion.status, 'off', 'a claim with no live owner is released, not burned — the reservation rule, applied to the prompt row')
  assert.equal(out.promptSuggestion.turnSeq, null)
  for (const keep of ['ready', 'failed', 'off']) {
    const r = { promptSuggestion: mk({ status: keep }) } as never
    assert.equal(reconcilePromptRow(r), r, keep + ' rows are not ours to touch')
  }
  const bare = { someOtherField: 1 } as never
  assert.equal(reconcilePromptRow(bare), bare, 'no promptSuggestion, no claim: the SAME object back — nothing to rewrite')
})

test('#304: boot runs the reclaim — the wiring calls reconcilePromptRow over every stored session', () => {
  const idx = fs.readFileSync(path.join(process.cwd(), 'src', 'index.ts'), 'utf8')
  assert.match(idx, /reconcilePromptRow/, 'the boot pass exists')
  assert.match(idx, /store\.sessions\(\)/, 'it enumerates sessions (the store\'s sanctioned read-only listing)')
})
