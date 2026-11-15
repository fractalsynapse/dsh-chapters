/**
 * #360 — the engine-ownership witness.
 *
 * Fixtures here are built from the REAL `compaction/summary` bytes read out of a production session
 * (`35d42b02`, arcnexus), not from an imagined shape — the rule this release keeps re-learning
 * (#339, #345, #355 item Z) is that a hand-written host-shaped fixture passes happily against dead
 * code. The real event's data keys are:
 *   compactionId, summary, rawOutput, llmStreamCall, shadowedRange, shadowedSeqs,
 *   shadowedTokenCount, provider, model, maxTokens, usage
 * with provider `qwen-token-plan`, and ZERO `dsh-chapters*` summaries anywhere in that log — which is
 * the incident, not a detail.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeProvenance, CHAPTERS_PROVIDER } from '../../src/engine-core.ts'

type Ev = { type: string; seq: number; data: Record<string, unknown> }

/** A session shim over an event list, matching what the reader actually uses (`seq`, `eventAt`). */
function fakeSession(events: Ev[]) {
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  return {
    seq: events.length === 0 ? 0 : Math.max(...events.map((e) => e.seq)) + 1,
    eventAt: (seq: number) => bySeq.get(seq),
  }
}

/** The foreign summary exactly as the host wrote it (keys copied from the real bytes). */
const foreignSummary = (seq: number, provider = 'qwen-token-plan'): Ev => ({
  type: 'compaction/summary', seq,
  data: {
    compactionId: 'cba3ad72-274f-42a2-b099-3e43c318d98b',
    summary: '…', rawOutput: '…', llmStreamCall: {}, shadowedRange: { start: 0, end: 9 },
    shadowedSeqs: Array.from({ length: 12 }, (_, i) => i), shadowedTokenCount: 4096,
    provider, model: 'qwen3.8-flash', maxTokens: 4096, usage: { totalTokens: 1 },
  },
})

const ourSummary = (seq: number, degraded = false): Ev => ({
  type: 'compaction/summary', seq,
  data: {
    compactionId: `ch-${String(seq)}`, summary: '…', rawOutput: '', llmStreamCall: {},
    shadowedRange: { start: 0, end: 3 }, shadowedSeqs: [0, 1, 2, 3], shadowedTokenCount: 10,
    provider: degraded ? `${CHAPTERS_PROVIDER}-degraded` : CHAPTERS_PROVIDER,
    model: 'deterministic', maxTokens: 0, usage: {},
  },
})

test('#360: a session compacted entirely by another engine is counted, not skipped', () => {
  // This is the arcnexus / platfolio shape: 6 and 8 summaries, all `qwen-token-plan`, none ours.
  const events = [foreignSummary(10), foreignSummary(900), foreignSummary(18000)]
  const prov = summarizeProvenance(fakeSession(events) as never)
  assert.deepEqual(
    { ours: prov.ours, foreign: prov.foreign, total: prov.total, providers: prov.foreignProviders },
    { ours: 0, foreign: 3, total: 3, providers: ['qwen-token-plan'] },
    'the count is the fact the old `continue` threw away')
  assert.deepEqual(prov.foreignSeqs, [10, 900, 18000], 'and the seqs are named so a human can go read one')
})

test('#360: our own summaries are not mistaken for foreign — including the degraded form', () => {
  const prov = summarizeProvenance(fakeSession([ourSummary(5), ourSummary(6, true)]) as never)
  assert.equal(prov.foreign, 0, 'provider `dsh-chapters` and `dsh-chapters-degraded` are both ours')
  assert.equal(prov.ours, 2)
  // Control in the other direction, so "starts with" cannot quietly become "matches nothing".
  const mixed = summarizeProvenance(fakeSession([ourSummary(1), foreignSummary(2), ourSummary(3, true)]) as never)
  assert.deepEqual({ ours: mixed.ours, foreign: mixed.foreign }, { ours: 2, foreign: 1 }, 'a mixed log counts both')
})

test('#360: a session that never compacted is NOT reported as a fault', () => {
  // The distinction that matters for not shouting: absence of our summaries means either a foreign
  // engine took over OR nothing ever needed compacting. Only the first is a complaint, and it is only
  // visible when a summary event exists at all.
  const prov = summarizeProvenance(fakeSession([]) as never)
  assert.deepEqual({ ours: prov.ours, foreign: prov.foreign, total: prov.total }, { ours: 0, foreign: 0, total: 0 })
  const otherEvents = fakeSession([{ type: 'user/message', seq: 0, data: {} }, { type: 'turn/end', seq: 1, data: {} }] as never)
  assert.equal(summarizeProvenance(otherEvents as never).foreign, 0, 'non-summary events are not counted either way')
})

test('#360: a summary with no provider field is treated as foreign, not silently as ours', () => {
  // Fail-toward-reporting: the incident we are guarding is a chapters session whose archive silently
  // did not happen. A summary that names no provider is not evidence that our engine wrote it.
  const prov = summarizeProvenance(fakeSession([{ type: 'compaction/summary', seq: 3, data: { compactionId: 'x', shadowedSeqs: [] } }]) as never)
  assert.equal(prov.foreign, 1)
  assert.deepEqual(prov.foreignProviders, ['(no provider field)'], 'and the report says why rather than an empty string')
})

test('#360: scanChaptersSummaries still ignores foreign work — the two functions answer different questions', async () => {
  // Guards against someone "fixing" the silence by widening the reconstruction reader, which would
  // make the engine claim ownership of summaries it cannot reconstruct.
  const { scanChaptersSummaries } = await import('../../src/engine-core.ts')
  const session = fakeSession([ourSummary(1), foreignSummary(2)])
  const oursOnly = scanChaptersSummaries(session as never)
  assert.equal(oursOnly.length, 1, 'reconstruction still sees exactly our own')
  assert.equal(summarizeProvenance(session as never).total, 2, 'while the witness sees all of them')
})
