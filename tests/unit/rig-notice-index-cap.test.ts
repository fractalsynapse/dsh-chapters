/**
 * The checkpoint notice's chapter index must reach a FIXED size once past the cap (#56).
 *
 * Why this is the determinism fix and not a blind: `heavy` sits on the compaction boundary, and the surface
 * carries a notice that lists one line per chapter. Every extra chapter added ~120 characters, so the surface
 * crossed the trigger one assistant/tool round earlier or later depending on how many chapters that run had
 * written — and a tape distilled from one such run cannot be matched by another. Blinds over the count made
 * MATCHING tolerant while leaving the SIZE free to move, which is why folding never fixed it. Capping the list
 * with a constant overflow line makes the bytes stop growing, so the boundary is decided by the conversation
 * rather than by an accumulator.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { noticeIndexSection, type NoticeBullet } from '../../src/render.ts'

const bullets = (n: number): NoticeBullet[] =>
  Array.from({ length: n }, (_, i) => ({ title: `Chapter ${String(i)}`, path: `ch${String(i)}.md`, summary: `summary ${String(i)}` }))

test('past the cap, the index is byte-identical regardless of how many chapters exist', () => {
  const cap = 6
  const at7 = noticeIndexSection(bullets(7), cap)
  const at40 = noticeIndexSection(bullets(40), cap)
  assert.equal(at7, at40, `the notice must stop growing past the cap:\n at7=${at7.length} at40=${at40.length}`)
  assert.match(at7, /older chapters are not listed here/, 'and it must say so, not silently drop entries')
  assert.ok(at7.includes('Chapter 5'), 'the first `cap` chapters are still listed')
  assert.ok(!at7.includes('Chapter 6'), 'later ones are not')
})

test('cap 0 keeps the historical full listing', () => {
  const full = noticeIndexSection(bullets(9), 0)
  assert.ok(full.includes('Chapter 8'), 'no cap means every chapter is listed')
  assert.doesNotMatch(full, /older chapters are not listed here/)
})
