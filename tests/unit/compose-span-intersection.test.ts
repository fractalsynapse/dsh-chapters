/**
 * #421 — a shadowed span INTERSECTS a signature; it never has to contain it.
 *
 * The rows are written from the FIRST LIVE composed-discussion record (2026-11-19, hosted
 * `qwen3.8-flash`, port 41745, session 8a5c3c6e…): pass 4 shadowed `[60,25,33,34,36,38,49,51,65,66]`
 * (span 25..66) while topic-1's signature ran `0..28` — clipped by earlier passes — and topic-2's ran
 * `29..54`, whole. `inSpan`'s WHOLE containment excluded the clipped one wholesale, one chapter
 * resulted, and the six-pass run looked exactly like every deterministic row had never seen: green
 * tests, un-composed reality. The fixture is that payload; the first row is red until the intersect
 * fix lands.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { composeChapters, type CollectionSignature } from '../../src/compose.ts'

const FIX = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'compose-live-clip-421.json'), 'utf8')) as {
  span: { lo: number, hi: number }
  shadowed: number[]
  collectionsAtDecisionTime: Array<{ seqs: number[], paths: string[], commands: string[], terms: string[], size: number, by: string, codegraphSymbols: string[] }>
  events: Array<{ seq: number, type: string }>
}
const CFG = { mergeThreshold: 0.3, chapterLimit: 8000 }

const sig = (o: (typeof FIX.collectionsAtDecisionTime)[number]): CollectionSignature =>
  o as unknown as CollectionSignature

const live = (): { events: { seq: number, type: string }[], sigs: CollectionSignature[] } => ({
  events: FIX.events as never[],
  sigs: FIX.collectionsAtDecisionTime.map(sig),
})

test('#421 red-from-live bytes: a signature CLIPPED by earlier passes participates with its intersection', () => {
  const { events, sigs } = live()
  assert.equal(sigs.length, 2, 'fixture control: the store held exactly two signatures at pass-4 decision time')
  const whole = sigs.filter((c) => c.seqs[0] >= FIX.span.lo && c.seqs[c.seqs.length - 1] <= FIX.span.hi)
  assert.equal(whole.length, 1, 'and under the retired containment rule ONE was whole — that is what made six legacy chapters')
  const res = composeChapters(events, FIX.span.lo, FIX.span.hi, sigs, CFG)
  assert.ok(res.chapters.length >= 2,
    `the clipped topic-1 tail (25..28) must get its own range beside topic-2 — got ${String(res.chapters.length)}: ${JSON.stringify(res.chapters.map((c) => [c.startSeq, c.endSeq]))}`)
  // the seam: topic-1's tail closes exactly where topic-2's whole signature opens.
  const sorted = [...res.chapters].sort((a, b) => a.startSeq - b.startSeq)
  assert.ok(sorted.some((c, i) => sorted[i + 1] !== undefined && c.endSeq === 28 && sorted[i + 1]!.startSeq === 29),
    `a 28/29 seam (turn-1 close / turn-2 open) must appear: ${JSON.stringify(sorted.map((c) => [c.startSeq, c.endSeq]))}`)
  // contiguity invariants survive the clip: first range opens at the SPAN, ranges are adjacent.
  assert.equal(sorted[0]!.startSeq, FIX.span.lo, 'the first range still starts at spanStart (contiguity #59)')
  assert.equal(sorted[sorted.length - 1]!.endSeq, FIX.span.hi, 'the last range still closes at spanEnd (absorption #59)')
  for (let i = 1; i < sorted.length; i++) {
    assert.equal(sorted[i]!.startSeq, sorted[i - 1]!.endSeq + 1, 'ascending non-overlapping coverage is never widened')
  }
})

test('#421: whole containment is a SUBSET of intersection — the #399 two-complete-signature shape is unchanged', () => {
  const mk = (lo: number, hi: number, p: string): CollectionSignature => ({
    seqs: Array.from({ length: hi - lo + 1 }, (_, i) => lo + i), paths: [p], commands: [], terms: [p.split('/')[1] ?? p], size: 900, by: 'deterministic', codegraphSymbols: [],
  } as CollectionSignature)
  const events = Array.from({ length: 40 }, (_, i) => ({ seq: 25 + i, type: i === 15 ? 'turn/end' : 'assistant/message' })) as never[]
  const res = composeChapters(events, 25, 64, [mk(25, 39, 'src/alpha.ts'), mk(41, 64, 'src/beta.ts')], CFG)
  assert.ok(res.chapters.length >= 2, 'two whole, distinct-topic signatures still split: ' + JSON.stringify(res.chapters.map((c) => [c.startSeq, c.endSeq])))
})

test('#421 over-participation guard: a signature with NO seq in the span contributes nothing', () => {
  const { events, sigs } = live()
  const before = JSON.stringify(composeChapters(events, FIX.span.lo, FIX.span.hi, sigs, CFG).chapters.map((c) => [c.startSeq, c.endSeq]))
  const far: CollectionSignature = {
    seqs: Array.from({ length: 20 }, (_, i) => 200 + i), paths: ['elsewhere/thing.ts'], commands: [], terms: ['elsewhere'], size: 800, by: 'deterministic', codegraphSymbols: [],
  } as CollectionSignature
  const after = JSON.stringify(composeChapters(events, FIX.span.lo, FIX.span.hi, [...sigs, far], CFG).chapters.map((c) => [c.startSeq, c.endSeq]))
  assert.equal(after, before, 'intersection means INTERSECTING — a disjoint signature stays exactly as excluded as before')
})
