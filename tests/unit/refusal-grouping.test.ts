/**
 * One predicate for one decision: `chapters-repair` (in-host) and the offline runner must aggregate the
 * repeated, same-class refusals the SAME way (#101, #102). The command shipped without it while the runner
 * got it, so `/chapters-repair dry-run` printed 21 identical `test-litter` lines for all 23 sessions —
 * 483 repeats that buried 372 real findings, which is how a work list turns into noise nobody reads.
 *
 * Grouping must not HIDE anything: the class is a summary, the file names are the content. So a group
 * prints its count, its shared reason, and up to `EXAMPLES` named items with an explicit withheld count.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { capReportLines, groupRefusals, renderRefusalGroups } from '../../src/repair-run.ts'

const R = (cls: string, what: string): string => `${cls}: ${what}`
const LITTER = [1, 2, 3, 4, 5].map((n) => R('test-litter', `the store holds a second root .dsh-chapters/root-${String(n)}; not touched automatically`))
const TWIN = R('unregistered-file', 'chapter 15 is already committed with different content (.dsh-chapters/x/015-a.md)')

test('refusals group by class, preserving every item (#101)', () => {
  const groups = groupRefusals([...LITTER, TWIN])
  assert.equal(groups.length, 2, 'one group per class')
  const litter = groups.find((g) => g.cls === 'test-litter')
  assert.ok(litter, 'the litter class is present')
  assert.equal(litter!.items.length, 5, 'every item is kept — aggregation is presentation, not deletion')
  assert.equal(groups.find((g) => g.cls === 'unregistered-file')!.items.length, 1)
})

test('a group prints its count, its reason, and the withheld remainder by name (#101)', () => {
  const lines = renderRefusalGroups([...LITTER, TWIN], 3)
  assert.equal(lines.length, 2, 'two lines for two classes')
  const litterLine = lines.find((l) => l.includes('test-litter'))!
  assert.match(litterLine, /×5/, `the count must be on the line: ${litterLine}`)
  assert.match(litterLine, /root-1/, 'the first named item survives')
  assert.match(litterLine, /root-3/, 'up to the example cap survives')
  assert.match(litterLine, /2 more/, 'and what was withheld is counted, not silently dropped')
  assert.ok(lines.some((l) => l.includes('already committed')), 'a single-item class prints its own detail')
})

test('a class with one refusal is not wrapped in ceremony (#101)', () => {
  const lines = renderRefusalGroups([TWIN], 3)
  assert.equal(lines.length, 1)
  assert.ok(!lines[0]!.includes('×1'), `a count of one is noise: ${lines[0]}`)
  assert.ok(!lines[0]!.includes('more'), 'and nothing was withheld, so no withheld clause appears')
})

test('order is by volume, so the loudest class is dealt with first (#101)', () => {
  const lines = renderRefusalGroups([...LITTER, TWIN], 3)
  assert.ok(lines[0]!.includes('test-litter'), 'the 5-item class leads')
})

/**
 * The report cap (#117) — same rule, one place, so the command and the offline runner cannot drift.
 *
 * Measured cause: a 23-session dry-run emitted 2,796 findings as ONE `command/done` event — 311 KB, larger
 * than `2 × chapterTokenTarget` — and that single event made the session permanently un-compactable by
 * `chapters_continue`, because clipping is forbidden and no range split can shrink one event. The cap is the
 * honest half of the fix; the count leading is the other half, since a withheld number is the #61 bug in new
 * clothes.
 */
test('capReportLines bounds the detail without losing the headline (#117)', () => {
  const body = Array.from({ length: 200 }, (_, i) => `finding ${String(i)}`)
  const out = capReportLines(body, 60)
  assert.equal(out.shown.length, 60, 'the printed body is bounded')
  assert.equal(out.withheld, 140)
  assert.match(out.capLine, /capped at 60 of 200 lines/, `the numbers are stated: ${out.capLine}`)
  assert.match(out.capLine, /140 withheld/, 'and the remainder is counted')
  assert.match(out.capLine, /nothing dropped/, 'and the reader is told the detail still exists')
  assert.match(out.capLine, /repairReportMaxLines/, 'naming the key that raises it')
  assert.match(out.capLine, /dry-run <session-id>/, 'and a remedy that needs no restart')
})

test('a short report is not wrapped in ceremony, and a zero cap cannot mean silence (#117)', () => {
  const body = ['one line', 'two lines']
  const out = capReportLines(body, 60)
  assert.deepEqual(out.shown, body, 'the lines pass through untouched')
  assert.equal(out.capLine, '', 'no cap sentence when nothing was withheld')
  assert.equal(capReportLines(['a'], 0).shown.length, 1, 'a cap of 0 clamps to one line, never to "print nothing"')
})
