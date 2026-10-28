/**
 * One generation per completed turn, and no more (#113). The runner is the door that decides whether this
 * feature costs a model call per turn or per step — the latter is precisely what the maintainer rejected
 * ("ran three different times and created three different prompts"), so the claims here are about counting,
 * ordering and failure visibility, not wording.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makePromptRoundRunner, type GenerateOutcome } from '../../src/prompt-runner.ts'
import { freshSession, type SessionState } from '../../src/registry.ts'

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
