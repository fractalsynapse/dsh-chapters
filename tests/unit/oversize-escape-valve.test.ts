/**
 * The single-event escape valve (#117) — the difference between "this session can be continued" and "never".
 *
 * Measured on the live log: one `command/done` event rendered 77,903 est tokens against a hard ceiling of
 * 16,000 (`chapterTokenTarget` 8000 × factor 2), and `chapters_continue` was refused four times. The refusal
 * was correct in principle — clipping is forbidden — but a range of exactly ONE event has no boundary to
 * split at, so "split at the next boundary" is not advice, it is a lockout. These rows hold the two halves
 * of the fix: splittable oversize still refuses, indivisible oversize archives whole and SAYS SO.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { oversizeRanges } from '../../src/render.ts'

const R = (title: string, startSeq: number, endSeq: number): { range: { title: string; startSeq: number; endSeq: number }; stats: { estimatedTokens: number; events?: number } } =>
  ({ range: { title, startSeq, endSeq }, stats: { estimatedTokens: 0 } })

const at = (tokens: number, events: number | undefined, title = 'Big', startSeq = 100, endSeq = 100) => {
  const r = R(title, startSeq, endSeq)
  r.stats.estimatedTokens = tokens
  if (events !== undefined) r.stats.events = events
  return r
}

test('a multi-event oversize range still refuses — the advice is real when it can be followed', () => {
  const out = oversizeRanges([at(20000, 9, 'Many', 100, 108)], 8000, 2)
  assert.equal(out.errors.length, 1)
  assert.equal(out.indivisible.length, 0)
  assert.match(out.errors[0]!, /split at the next boundary; clipping is forbidden/)
  assert.match(out.errors[0]!, /seqs 100-108/, 'and the range is named, so the operator knows where to cut')
})

test('a single indivisible event is NOT a refusal: it archives whole and warns', () => {
  const out = oversizeRanges([at(77903, 1, 'Repair dry-run quote', 16027, 16027)], 8000, 2)
  assert.equal(out.errors.length, 0, 'this is the case that made the session un-compactable four times')
  assert.equal(out.indivisible.length, 1)
  const w = out.indivisible[0]!
  assert.match(w, /ONE indivisible event \(seq 16027\)/, `the event is named: ${w}`)
  assert.match(w, /77903 est tokens/)
  assert.match(w, /ceiling 16000/, 'with the number it exceeded')
  assert.match(w, /archived whole/, 'and what actually happened')
  assert.match(w, /read offset\/limit/, 'plus how to get it back — a chapter larger than the window is only honest with a reload recipe')
  assert.match(w, /clipping is forbidden/, 'and the invariant it respects')
})

test('a missing event count is treated as splittable, never as a free pass', () => {
  const out = oversizeRanges([{ range: { title: 'No stats', startSeq: 1, endSeq: 5 }, stats: { estimatedTokens: 30000 } }], 8000, 2)
  assert.equal(out.errors.length, 1, 'unknown shape must not become an exemption — that is how a guard stops guarding')
  assert.equal(out.indivisible.length, 0)
})

test('under the ceiling nothing is said at all', () => {
  const out = oversizeRanges([at(16000, 1), at(15999, 12)], 8000, 2)
  assert.deepEqual(out, { errors: [], indivisible: [] }, 'the boundary is inclusive: exactly the ceiling is not over it')
})
