/**
 * #411 — the leg-classification predicate for distill's replay-after-record gate.
 *
 * Pure table, no I/O: the BASH loop owns the boots and counts, this owns what a
 * (record, replay, misses) triple MEANS. The distinction that earns its existence is the
 * last row: a failing replay with NO new MISS lines is a product/spec failure, not a corpus
 * gap — healing that would paper a real defect onto the tape. Measured origin: #340's
 * re-anchor, where record went green and strict replay found one unrecorded call (the
 * post-Run regeneration lost to a record-time race) — a class that only replay-after can
 * see, and one heal is enough because the stub/live upstream is deterministic per leg.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyLeg } from '../../scripts/distill-replay-guard.mjs'

test('#411: a failed record stays a plain record failure — replay never ran', () => {
  const v = classifyLeg({ recordRc: 1, entries: 9, replayRc: null, newMisses: null })
  assert.equal(v.action, 'fail')
  assert.match(v.verdict, /record/)
})

test('#411: green record + green replay PASSES with the record+replay verdict', () => {
  const v = classifyLeg({ recordRc: 0, entries: 14, replayRc: 0, newMisses: 0 })
  assert.equal(v.action, 'pass')
  assert.match(v.verdict, /record\+replay/)
})

test('#411: green record + FAILING replay WITH new misses → exactly one bounded heal', () => {
  const v = classifyLeg({ recordRc: 0, entries: 14, replayRc: 1, newMisses: 1 })
  assert.equal(v.action, 'heal')
  assert.match(v.verdict, /bounded heal/)
  // and the post-heal classifier: replay must still pass
  const ok = classifyLeg({ recordRc: 0, entries: 15, replayRc: 0, newMisses: 0, healed: true })
  assert.equal(ok.action, 'pass')
  assert.match(ok.verdict, /healed=1/)
  const bad = classifyLeg({ recordRc: 0, entries: 15, replayRc: 1, newMisses: 1, healed: true })
  assert.equal(bad.action, 'fail', 'a second heal is NEVER attempted — one pass or the leg fails')
})

test('#411: failing replay with ZERO new misses is a leg failure, not a corpus gap — NO heal', () => {
  const v = classifyLeg({ recordRc: 0, entries: 14, replayRc: 1, newMisses: 0 })
  assert.equal(v.action, 'fail')
  assert.match(v.verdict, /NO new tape MISS/)
})

test('#411: a green replay after a heal pass counts — heal+replay0 is a pass', () => {
  // the loop's shape: replay1 fails with misses → heal → replay2 → classify with replayRc=replay2
  const v = classifyLeg({ recordRc: 0, entries: 15, replayRc: 0, newMisses: 0, healed: true })
  assert.equal(v.action, 'pass')
})
