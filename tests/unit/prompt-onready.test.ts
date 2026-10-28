/**
 * The loop fires off the PERSISTED offer, not off its own memory (#113).
 *
 * Why this edge exists: autorun starts a real turn, so "the offer the human would have seen" and "the offer
 * that ran" have to be the same fact. If the loop read the row itself after the fact it could race a newer
 * offer, and if it kept its own copy it could run text the bar never showed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makePromptRoundRunner } from '../../src/prompt-runner.ts'
import { freshSession, type SessionState } from '../../src/registry.ts'

function world(opts: { outcome?: { ok: boolean; text?: string; reason?: string; quiet?: boolean } } = {}) {
  const rows = new Map<string, SessionState>([['S', freshSession('S')]])
  const ready: Array<{ id: string; text: string; turnSeq: number | null }> = []
  const runner = makePromptRoundRunner({
    enabled: () => true,
    eligible: () => true,
    now: () => '2026-10-25T00:00:00.000Z',
    store: { mutate: async (id, fn) => { const next = fn(rows.get(id) ?? freshSession(id)); rows.set(id, next); return next } },
    generate: async () => opts.outcome ?? { ok: true, text: 'Run the plane.' },
    onReady: (sessionId, state) => { ready.push({ id: sessionId, text: state.text, turnSeq: state.turnSeq }) },
  })
  return { rows, ready, runner }
}

test('onReady carries exactly the offer that was written', async () => {
  const w = world()
  w.runner({ id: 'S' }, { type: 'turn/end', seq: 41, data: {} })
  const deadline = Date.now() + 2000
  while (w.ready.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(w.ready, [{ id: 'S', text: 'Run the plane.', turnSeq: 41 }])
  assert.equal(w.rows.get('S')!.promptSuggestion.text, 'Run the plane.', 'the row and the fired offer agree')
})

test('a quiet refusal or a failure never reaches the loop', async () => {
  const quiet = world({ outcome: { ok: false, quiet: true, reason: 'no completed assistant turn' } })
  quiet.runner({ id: 'S' }, { type: 'turn/end', seq: 41, data: {} })
  const failed = world({ outcome: { ok: false, reason: 'no route' } })
  failed.runner({ id: 'S' }, { type: 'turn/end', seq: 42, data: {} })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(quiet.ready.length, 0, 'nothing to recommend starts no turn')
  assert.equal(failed.ready.length, 0, 'and a failed generation must not be run at the human')
})
