/**
 * The enrichment queue must say why it did nothing (#61a, measured 2026-10-23).
 *
 * The `enrich` leg failed a 420 s poll for ladder output; the tape showed only the conversation turn
 * and the title request, and the diagnostics sink contained **zero** lines mentioning enrichment. So
 * the queue had a reason — `enabled`, `trigger`, an unresolvable model, or simply nothing pending —
 * and kept it to itself. Every one of this branch's diagnoses has started the same way: something
 * knew, and nothing was written down.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnrichQueue } from '../../src/enrich-queue.ts'

const mk = (over: Record<string, unknown> = {}) => {
  const notes: string[] = []
  const q = createEnrichQueue({
    listPending: async () => [],
    enrichOne: async () => ({ ok: true }),
    resolveModel: async () => 'local/qwen-test',
    enabled: true,
    trigger: 'idle',
    idleMs: 1,
    log: (m: string) => { notes.push(m) },
    ...over,
  } as never)
  return { q, notes }
}

test('a drain that runs nothing states the reason it ran nothing', async () => {
  const { q, notes } = mk({ enabled: false })
  await q.drainNow()
  assert.ok(notes.some((n) => /disabled/i.test(n)), `disabled must be reported, got ${JSON.stringify(notes)}`)
})

test('a manual-trigger queue says so instead of resolving quietly to zero', async () => {
  const { q, notes } = mk({ trigger: 'manual' })
  await q.drainNow()
  assert.ok(notes.some((n) => /trigger=manual/i.test(n)), `manual is a decision worth logging, got ${JSON.stringify(notes)}`)
})

test('an unresolvable enrichment model is reported, not swallowed', async () => {
  const { q, notes } = mk({ resolveModel: async () => '' })
  await q.drainNow()
  assert.ok(notes.some((n) => /no enrichment model/i.test(n)), `got ${JSON.stringify(notes)}`)
})

test('the ordinary no-work case is reported once, with the pending count', async () => {
  const { q, notes } = mk({ listPending: async () => [] })
  await q.drainNow()
  assert.ok(notes.some((n) => /pending=0/.test(n)), `a quiet queue is still a claim, got ${JSON.stringify(notes)}`)
})
