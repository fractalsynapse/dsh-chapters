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
import { groupRefusals, renderRefusalGroups } from '../../src/repair-run.ts'

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
