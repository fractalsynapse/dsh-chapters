/**
 * #344 — the deterministic doors refused real sessions and reported it as success.
 *
 * Two defects, both measured against the shipped functions on real logs before and after:
 *
 * | log | turns derived | refused BEFORE | parts after split | refused AFTER |
 * | --- | --- | --- | --- | --- |
 * | eadc | 3 | 2 | 275 | **0** |
 * | platfolio | 153 | 55 | 3,248 | **0** |
 * | arcnexus | 308 | 32 | 3,081 | **0** |
 *
 * (The "before" column reproduces the audit's own 2/3, 55 and 32 exactly — which is what makes the
 * "after" worth anything.)
 */
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { splitOversize } from '../../src/save-core.ts'
import { estimateTokens, oversizeRanges, renderChapter } from '../../src/render.ts'
import type { ChapterRange, SessionEventLike } from '../../src/types.ts'

const CONFIG = { toolResultDeferFloorTokens: 200, chapterTokenTarget: 100 }

const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEventLike =>
  ({ type, seq, time: 0, surfaceOp: 'append', data })
/** An event padded to roughly `tokens` estimated tokens. */
const fat = (seq: number, tokens: number, tag = 'x'): SessionEventLike =>
  ev(seq, 'tool/result', { message: { source: { kind: 'tool', callId: `c${String(seq)}` }, content: [{ type: 'text', text: tag.repeat(tokens * 4) }] } })
const turnEnd = (seq: number): SessionEventLike => ev(seq, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

const range = (startSeq: number, endSeq: number): ChapterRange =>
  ({ title: 'Opening turn', summary: 's', startSeq, endSeq } as ChapterRange)

test('#344: an over-ceiling range is packed into parts that all fit, cutting at event boundaries', () => {
  // 40 events of 30 est tokens each = ~1,200 tokens against a 100-token target and 2x factor (200 ceiling).
  const events = [...Array.from({ length: 40 }, (_, k) => fat(k, 30)), turnEnd(40)]
  const { ranges, notes } = splitOversize([range(0, 40)], events, 100, 2)
  assert.ok(ranges.length > 1, `expected subdivision, got ${String(ranges.length)} range(s)`)
  assert.equal(ranges[0]!.startSeq, 0, 'the first part starts where the original did')
  assert.equal(ranges[ranges.length - 1]!.endSeq, 40, 'the last part ends where it did — nothing dropped')
  // Coverage: contiguous, ascending, non-overlapping, complete. This is the invariant that makes a cut
  // safe; a split that loses seqs would silently shrink the archive while reporting success.
  for (let k = 1; k < ranges.length; k++) {
    assert.equal(ranges[k]!.startSeq, ranges[k - 1]!.endSeq + 1,
      `part ${String(k)} must begin exactly where part ${String(k - 1)} ended`)
    assert.ok(ranges[k]!.startSeq <= ranges[k]!.endSeq, `part ${String(k)} is inverted`)
  }
  assert.ok(notes.length === 1 && /packed into \d+ chapters/.test(notes[0]!), `note reports the split: ${JSON.stringify(notes)}`)
  assert.match(notes[0]!, /nothing truncated/, 'and says so explicitly')
})

test('#344: parts are titled, and only the first keeps the bare title', () => {
  const events = [...Array.from({ length: 20 }, (_, k) => fat(k, 30)), turnEnd(20)]
  const { ranges } = splitOversize([range(0, 20)], events, 100, 2)
  assert.equal(ranges[0]!.title, 'Opening turn')
  assert.match(ranges[1]!.title, /^Opening turn \(part 2\)$/)
  assert.match(ranges[2]!.title, /^Opening turn \(part 3\)$/)
  assert.equal(new Set(ranges.map((r) => r.title)).size, ranges.length, 'titles are distinct')
})

test('#344: the old equal-COUNT split left parts over the ceiling — this one does not', () => {
  // One enormous event among many small ones is exactly the real-world shape (a big tool result inside
  // a long turn). Equal-count chunking puts the giant in one part and refuses it; size-aware packing
  // isolates it as its own part, where the refusal is at least honest and specific.
  const events = [
    ...Array.from({ length: 12 }, (_, k) => fat(k, 10)),
    fat(12, 900),
    ...Array.from({ length: 12 }, (_, k) => fat(13 + k, 10)),
    turnEnd(37),
  ]
  const { ranges } = splitOversize([range(0, 37)], events, 100, 2)
  const perRangeTokens = ranges.map((r) => events
    .filter((e) => e.seq >= r.startSeq && e.seq <= r.endSeq)
    .reduce((m, e) => m + estimateTokens(JSON.stringify(e.data ?? {})), 0))
  const small = perRangeTokens.filter((_, k) => ranges[k]!.startSeq !== 12 && ranges[k]!.endSeq !== 12)
  assert.ok(small.every((t) => t <= 200), `small parts must fit the 200-token ceiling, got ${JSON.stringify(perRangeTokens)}`)
  // The property is isolation, not a part COUNT (an earlier draft asserted `> 12`, which encoded my guess
  // about packing density rather than the behaviour under test -- 10 parts is correct here).
  const giant = ranges.filter((r) => r.startSeq <= 12 && 12 <= r.endSeq)
  assert.equal(giant.length, 1, 'exactly one part contains the giant event')
  assert.deepEqual([giant[0]!.startSeq, giant[0]!.endSeq], [12, 12],
    'and it travels ALONE: a single oversized event is never merged with its neighbours')
  // Under the old equal-count split this same input produced chunks of 12-13 events, so the giant shared
  // a part with a dozen others. Assert the contrast directly rather than trusting the prose.
  assert.ok(perRangeTokens.filter((t) => t > 200).length === 1,
    `only the unsplittable giant may exceed the ceiling, got ${JSON.stringify(perRangeTokens)}`)
})

test('#344: a range already under the ceiling is returned untouched', () => {
  const events = [fat(0, 10), turnEnd(1)]
  const input = [range(0, 1)]
  const { ranges, notes } = splitOversize(input, events, 100, 2)
  assert.deepEqual(ranges, input, 'identical object, identical range — no needless re-titling')
  assert.equal(notes.length, 0, 'and no note: nothing was done, nothing claimed')
})

test('#344: the rendered chapters from a split range pass the real oversize gate', () => {
  // End-to-end through the shipped renderer, which is what production gates on. Measuring only the raw
  // payload proxy would overstate refusals: the renderer defers big tool results to artifacts, and that
  // is precisely why large turns are archivable at all.
  const events = [
    ev(0, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] }),
    ...Array.from({ length: 30 }, (_, k) => fat(k + 1, 40)),
    turnEnd(31),
  ]
  const target = CONFIG.chapterTokenTarget
  const { ranges } = splitOversize([range(0, 31)], events, target, 2)
  const rendered = ranges.map((r) => renderChapter(events as never, r as never, CONFIG as never, [], []))
  const ov = oversizeRanges(rendered as never, target, 2)
  assert.equal(ov.errors.length, 0, `no part may be refused after subdivision; got: ${ov.errors.join(' | ')}`)
})

test('#344: the door refuses with the SIZE and the KNOB, never "Saved: 0 chapter(s)"', async () => {
  // The reporting half of the issue: `skipped='oversize'` fell through to the success line, so a human
  // read "Saved: 0 chapter(s) archived … Enrichment queued." for a refusal. Asserted on the text the
  // door builds, via the same guard the tool now uses.
  const src = readFileSync(new URL('../../src/tools.ts', import.meta.url), 'utf8')
  const guard = src.slice(src.indexOf("if (out.skipped !== null && out.records.length === 0)"))
  assert.ok(guard.length > 200, 'the exhaustive refusal guard must exist')
  assert.match(guard, /NOTHING archived — refused/, 'names the fact, in the error channel')
  assert.match(guard, /kind: 'error'/, 'returns kind=error, not success')
  assert.match(guard, /chapterTokenTarget/, 'names the knob to raise')
  assert.match(guard, /chapterOversizeFactor/, 'and the multiplier')
  assert.match(guard, /Nothing was reserved/, 'says whether a number was spent')
  // A new skip reason must inherit the refusal wording, not the success line — the class, not the case.
  assert.match(guard, /reason: \$\{out\.skipped\}/, 'unknown reasons fall through to a refusal with the reason named')
})
