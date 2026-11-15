/**
 * The checkpoint notice's chapter index must stop TRACKING HISTORY once past the cap (#56).
 *
 * Why this is the determinism fix and not a blind: `heavy` sits on the compaction boundary, and the surface
 * carries a notice that lists one line per chapter. Every extra chapter added ~120 characters, so the surface
 * crossed the trigger one assistant/tool round earlier or later depending on how many chapters that run had
 * written — and a tape distilled from one such run cannot be matched by another. Blinds over the count made
 * MATCHING tolerant while leaving the SIZE free to move, which is why folding never fixed it. Capping the list
 * with a constant overflow line makes the size stop tracking history, so the boundary is decided by the
 * conversation rather than by an accumulator.
 *
 * #342 kept that property and changed WHICH END is capped, to the newest `cap`. Keeping the oldest was never
 * part of the determinism requirement — it merely made the block byte-identical, which this file used to
 * assert as if that were the goal. A reader index that never lists the chapter it just wrote is not an index.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { noticeIndexSection, type NoticeBullet } from '../../src/render.ts'

const bullets = (n: number): NoticeBullet[] =>
  Array.from({ length: n }, (_, i) => ({ title: `Chapter ${String(i)}`, path: `ch${String(i)}.md`, summary: `summary ${String(i)}` }))

test('past the cap, the index is BOUNDED IN SIZE regardless of how many chapters exist', () => {
  const cap = 6
  const at7 = noticeIndexSection(bullets(7), cap)
  // #342: what #56 actually needs is a block whose size stops growing, so the compaction boundary is
  // decided by the conversation rather than by a chapter accumulator. It never needed the OLDEST
  // chapters to be the ones kept — and keeping them meant that from chapter 7 on, no checkpoint ever
  // cited the chapter it had just written, while the overflow line claimed the dropped ones were the
  // older ones. The row used to assert `at7 === at40`; that byte-identity was the means, not the end.
  const at400 = noticeIndexSection(bullets(400), cap)
  // Measured: the capped block grows 287 → 335 bytes from 7 to 400 chapters — chapter-number digits
  // only — against 244 → 16,761 uncapped. Bounded, which is the property #56 needed.
  const lines = (s: string): number => s.split('\n').length
  assert.equal(lines(at7), lines(at400), `the line count is constant past the cap: ${lines(at7)} vs ${lines(at400)}`)
  assert.ok(Math.abs(at400.length - at7.length) < 50, `size must not track chapter count (7 = ${at7.length} B, 400 = ${at400.length} B)`)
  assert.ok(at400.length < noticeIndexSection(bullets(400), 0).length / 10, 'and far below what an uncapped index costs')
  assert.match(at7, /older chapters are not listed here/, 'and it must say so, not silently drop entries')
})

test('#342: the chapter just archived IS in the index', () => {
  const cap = 6
  // The live shape: engine-core appends new bullets LAST (`[...bullets, ...chapters]`, :451/:478), so
  // the newest work sits at the tail — the end a reader index has to keep.
  const at40 = noticeIndexSection(bullets(40), cap)
  assert.ok(at40.includes('Chapter 39'), 'the just-archived chapter is listed')
  assert.ok(at40.includes('Chapter 34'), 'with the previous cap-1 of them')
  assert.ok(!at40.includes('Chapter 33'), 'the older ones are the omitted set, as the line says')
  assert.ok(!at40.includes('Chapter 0 '), 'the first chapter is no longer what every child is shown forever')
})

test('#342: a capped tail keeps each line numbered by true position', () => {
  // renderIndex numbered lines from 1 at both call sites; slicing the tail without an offset would
  // label the 35th chapter as "1." and make every number in the block lie.
  const at40 = noticeIndexSection(bullets(40), 6)
  assert.match(at40.split('\n')[0]!, /^35\. \[Chapter 34\]/, 'the first listed line carries its real position')
  assert.match(at40, /^40\. \[Chapter 39\]/m, 'and the last line is the newest position')
})

test('cap 0 keeps the historical full listing', () => {
  const full = noticeIndexSection(bullets(9), 0)
  assert.ok(full.includes('Chapter 8'), 'no cap means every chapter is listed')
  assert.doesNotMatch(full, /older chapters are not listed here/)
  assert.match(full, /^1\. \[Chapter 0\]/m, 'an uncapped index still numbers from 1')
})
