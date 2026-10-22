/**
 * The bidirectional completeness guard (#59, record §4.3 amendment 2026-10-22).
 *
 * The record's guard only ever kept UNFINISHED work out. Composing from collections alone means a
 * COMPLETED turn that lost its signature is silently absent — no chapter, no index, no warning. That
 * is not hypothetical: `session-2edf9694` had 32 `turn/end` events and 31 collections, and the
 * 203-event span between chapters 27 and 28 (a complete turn: the maintainer's "I consider it
 * foundational to the project" hosting brief and its implementation) exists in no chapter in any
 * tree. The composer's own note claimed the opposite — "incomplete turn content … stays live".
 *
 * So: nothing unfinished is archived, AND nothing finished is dropped.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeChapters } from '../../src/compose.ts'
import { validateRanges } from '../../src/render.ts'
import { coverage } from '../../src/archive.ts'
import type { CollectionSignature } from '../../src/signature.ts'
import type { SessionEventLike } from '../../src/types.ts'

/** Two signed turns, then a THIRD completed turn with no signature at all — the SAIP shape. */
function log(withUnsignedThird: boolean): SessionEventLike[] {
  const ev: SessionEventLike[] = []
  const turn = (t: number, base: number, file: string): void => {
    ev.push({ type: 'turn/start', seq: base, data: { turn: t } })
    ev.push({ type: 'user/message', seq: base + 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `turn ${t} asks` }] } })
    ev.push({ type: 'assistant/message', seq: base + 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: `turn ${t} answers, touching ${file}` }] } } })
    ev.push({ type: 'turn/end', seq: base + 3, data: { turn: t, reason: { kind: 'completed' } } })
  }
  turn(1, 0, 'a.ts'); turn(2, 4, 'b.ts')
  if (withUnsignedThird) turn(3, 8, 'hosting.ts')
  return ev
}
const coll = (from: number, to: number, primary: string): CollectionSignature => ({
  seqs: Array.from({ length: to - from + 1 }, (_, i) => from + i),
  paths: [primary], commands: [], terms: ['x'], size: 100, by: 'deterministic',
})

test('an UNSIGNED but COMPLETED turn is absorbed, not dropped (the SAIP 203-event hole)', () => {
  const events = log(true)
  const anchor = 11 // third turn/end
  const out = composeChapters(events, 0, anchor, [coll(0, 3, 'a.ts'), coll(4, 7, 'b.ts')], {
    mergeThreshold: 0.3, chapterTokenTarget: 8000, chapterLimit: 8000,
  } as never)
  assert.ok(out.chapters.length > 0, 'composed something')
  const gaps = coverage(out.chapters.map((c) => ({ startSeq: c.startSeq, endSeq: c.endSeq })), anchor, 0).gaps
  assert.deepEqual(gaps, [], `composed ranges must cover 0..${anchor} with no hole; got ${JSON.stringify(gaps)}`)
  assert.equal(out.chapters[out.chapters.length - 1]!.endSeq, anchor, 'the last range reaches the anchor')
  // and the events are actually IN a range, so the renderer will print them
  const all = out.chapters.flatMap((c) => Array.from({ length: c.endSeq - c.startSeq + 1 }, (_, i) => c.startSeq + i))
  for (const seq of [8, 9, 10, 11]) assert.ok(all.includes(seq), `seq ${seq} (the unsigned turn) is archived`)
})

test('the composer no longer calls completed work "incomplete turn content"', () => {
  const out = composeChapters(log(true), 0, 11, [coll(0, 3, 'a.ts'), coll(4, 7, 'b.ts')], {
    mergeThreshold: 0.3, chapterTokenTarget: 8000, chapterLimit: 8000,
  } as never)
  assert.ok(!out.notes.some((n) => /stays live/.test(n)), `notes must not claim completed work is live: ${JSON.stringify(out.notes)}`)
})

test('unfinished work still stays out — the original half of the guard', () => {
  // anchor = the LAST turn/end only; nothing above it may be composed.
  const out = composeChapters(log(false), 0, 7, [coll(0, 3, 'a.ts'), coll(4, 7, 'b.ts')], {
    mergeThreshold: 0.3, chapterTokenTarget: 8000, chapterLimit: 8000,
  } as never)
  assert.ok(out.chapters.every((c) => c.endSeq <= 7), 'nothing above the anchor')
})

test('validateRanges refuses a GAP between model-supplied ranges', () => {
  const ok = [{ title: 'A', summary: 's', startSeq: 0, endSeq: 9 }, { title: 'B', summary: 's', startSeq: 10, endSeq: 20 }]
  assert.doesNotThrow(() => validateRanges(ok as never, 20))
  const gapped = [{ title: 'A', summary: 's', startSeq: 0, endSeq: 9 }, { title: 'B', summary: 's', startSeq: 12, endSeq: 20 }]
  assert.throws(() => validateRanges(gapped as never, 20), /gap|not contiguous|drops/i,
    'a hole between two submitted ranges silently drops seqs 10-11 — AGENTS.md forbids it and the check did not exist')
})

test('a model range that starts above the watermark is refused, not skipped past', () => {
  assert.throws(() => validateRanges([{ title: 'A', summary: 's', startSeq: 20, endSeq: 30 }] as never, 30, 0),
    /cover|gap|from/i, 'ranges must cover from the watermark, not start wherever the model felt like')
})
