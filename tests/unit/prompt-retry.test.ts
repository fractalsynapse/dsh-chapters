// #583: an ARMED loop must not stall silently on a transient model failure. A failed offer
// re-decides at 60s/3m/9m (the drains' own schedule); exhaustion prints ONE loud STALLED line.
// Unarmed: single attempt — background calls nobody asked for are as wrong as a silent stall.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makePromptRoundRunner, type GenerateOutcome } from '../../src/prompt-runner.ts'
import { freshSession, type SessionState } from '../../src/registry.ts'

interface Fake {
  writes: Array<{ status: string; text: string; turnSeq: number | null; error: string }>
  rows: Map<string, SessionState>
  store: { mutate(id: string, fn: (s: SessionState) => SessionState): Promise<unknown> }
}
function fakeStore(row: SessionState): Fake {
  const rows = new Map<string, SessionState>([['S', row]])
  const writes: Fake['writes'] = []
  return {
    rows, writes,
    store: { mutate: async (id, fn) => {
      const before = JSON.stringify((rows.get(id) ?? freshSession(id)).promptSuggestion)
      const next = fn(rows.get(id) ?? freshSession(id))
      rows.set(id, next)
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
const TURN_END = (seq: number): unknown => ({ type: 'turn/end', seq, data: { turn: 1 } })

function retryWorld(plan: (call: number) => GenerateOutcome, opts: { armed?: boolean } = {}) {
  const f = fakeStore(freshSession('S'))
  const logs: string[] = []
  const warns: string[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  let calls = 0
  const run = makePromptRoundRunner({
    enabled: () => true,
    eligible: () => true,
    store: f.store,
    now: () => new Date().toISOString(),
    log: (m) => { logs.push(m) },
    warn: (m) => { warns.push(m) },
    armed: () => opts.armed ?? true,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return { cancel: () => { const i = timers.findIndex((t) => t.fn === fn); if (i >= 0) timers.splice(i, 1) } }
    },
    generate: async (_s, turnSeq) => { calls += 1; return plan(calls) },
  })
  return { f, run, logs, warns, timers, calls: () => calls }
}
const FAIL: GenerateOutcome = { ok: false, reason: 'prompt model call failed: host llm.stream failed: 429 Too Many Requests' }
const OK: GenerateOutcome = { ok: true, text: 'Verify the release chain, then file the follow-up.' }

test('#583: armed + failed offer -> a 60s re-decide, and the recovery DELIVERS (the loop rides out)', async () => {
  const w = retryWorld((c) => (c === 1 ? FAIL : OK))
  w.run({ id: 'S' }, TURN_END(41))
  await until(() => w.f.writes.some((x) => x.status === 'failed'))
  assert.equal(w.timers.length, 1, 'exactly one re-decide scheduled')
  assert.equal(w.timers[0]!.ms, 60_000)
  assert.match(w.logs.join('\n'), /re-decide 1\/3 in 60s/)
  const t = w.timers.shift()!
  t.fn()
  await until(() => w.calls() === 2)
  await until(() => w.f.writes.some((x) => x.status === 'ready'))
  assert.equal(w.timers.length, 0, 'success clears the chain')
})

test('#583: unarmed -> ONE attempt, ZERO scheduled retries', async () => {
  const w = retryWorld(() => FAIL, { armed: false })
  w.run({ id: 'S' }, TURN_END(41))
  await until(() => w.f.writes.some((x) => x.status === 'failed'))
  assert.equal(w.calls(), 1)
  assert.equal(w.timers.length, 0, 'no model calls a human did not arm for')
})

test('#583: exhaustion = one loud STALLED line after exactly three backoffs (never silence)', async () => {
  const w = retryWorld(() => FAIL)
  w.run({ id: 'S' }, TURN_END(41))
  await until(() => w.timers.length === 1)
  const seen: number[] = []
  for (let i = 0; i < 3; i += 1) {
    const t = w.timers.shift()!
    seen.push(t.ms)
    t.fn()
    await until(() => w.f.writes.filter((x) => x.status === 'failed').length === i + 2)
  }
  assert.deepEqual(seen, [60_000, 180_000, 540_000], 'the drains\' own ladder')
  await until(() => w.calls() === 4)
  assert.equal(w.timers.length, 0, 'the chain STOPS — no eternal polling behind a dead provider')
  assert.equal(w.warns.filter((m) => m.includes('OFFER STALLED')).length, 1, 'exactly one stall line')
})

test('#583: a newer boundary retires the old chain (stale re-decide drops; the fresh turn owns the plane)', async () => {
  const w = retryWorld(() => FAIL)
  w.run({ id: 'S' }, TURN_END(41))
  await until(() => w.timers.length === 1)
  // another door instance (or a restart replay) moved the plane on:
  const row = w.f.rows.get('S')!
  w.f.rows.set('S', { ...row, promptSuggestion: {
    ...(row.promptSuggestion as object), status: 'ready', text: 'newer', turnSeq: 60, error: '',
  } as SessionState['promptSuggestion'] })
  const t = w.timers.shift()!
  t.fn()
  await until(() => w.logs.some((m) => m.includes('retry dropped for S')))
  assert.match(w.logs.join('\n'), /retry dropped for S — a newer turn owns the plane/)
  assert.equal(w.calls(), 1, 'the stale boundary never spends another call')
})
