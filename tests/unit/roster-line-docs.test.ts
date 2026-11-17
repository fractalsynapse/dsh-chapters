/**
 * #355 (docs audit) — quoted output in the site must be the output the code emits.
 *
 * `operations/install.md` does something unusual and laudable: it shows the two lines a healthy boot
 * prints and tells the reader that **anything other than the above is a named problem**. That makes the
 * sample load-bearing. It had drifted: the real roster line carries a trailing clause the sample omitted,
 * so a correct install failed the page's own test.
 *
 * The fix is not the corrected string — it is that the sample is now DERIVED from the function that
 * builds it, so the next edit to either has to pass here. This is the same shape as #351's
 * recompute-the-documented-table row: stop trusting that a quoted artifact matches its source.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rosterHealthyLine } from '../../src/index.ts'
import { CHAPTERS_PRESET_ID } from '../../src/preset.ts'

const site = (rel: string): string => readFileSync(join(process.cwd(), 'site/src/content/docs', rel), 'utf8')

test('#355: the install page healthy-boot sample is exactly what the code composes', () => {
  const doc = site('operations/install.md')
  // Pull the fenced block that contains the roster line, as a reader would see it.
  const block = /```([^`]*is in the host roster[^`]*)```/.exec(doc)
  assert.ok(block !== null, 'the install page must still show a fenced boot sample')
  const quoted = block![1]!.split('\n').map((l) => l.trim()).filter((l) => l.includes('is in the host roster'))
  assert.equal(quoted.length, 1, `exactly one roster sample expected, found ${String(quoted.length)}`)

  // Compose what the plugin prints for the sample's own scenario: 30 rows, all active.
  const real = rosterHealthyLine('chapters', ' — 30 mounted rows all active')
  assert.equal(quoted[0], real,
    'the quoted sample and the emitted line must be byte-identical: the page tells users that any '
    + 'difference is a named problem, so a truncated sample makes a healthy install look broken')
})

test('#355: the sample does not silently drop a clause again (the specific regression)', () => {
  const real = rosterHealthyLine('chapters', ' — 30 mounted rows all active')
  assert.match(real, /chapter-form compaction and continuations will compose$/,
    'the trailing clause is the promise the whole page is about; if it is gone from the CODE, the docs '
    + 'must be updated in the same change and this row tells you so')
  assert.ok(real.includes('is in the host roster — 30 mounted rows all active — '),
    'both separators present: the mounted phrase is inserted between them, not appended after')
})

test('#355: the preset id used in the sample is the id the plugin actually registers', () => {
  // The sample says `"chapters"`. A preset rename would make every quoted sample stale at once — and
  // #353 removed a second literal copy of exactly this id for the same reason.
  assert.equal(CHAPTERS_PRESET_ID, 'chapters')
  const doc = site('operations/install.md')
  assert.match(doc, new RegExp(`preset "${CHAPTERS_PRESET_ID}" registered as a declaration row`),
    'the registration sample must name the real preset id')
})

test('#355: the roster line is built in ONE place, so the docs have one thing to track', () => {
  const src = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')
  const sites = src.split('\n').filter((l) => l.includes('is in the host roster'))
  assert.equal(sites.length, 1,
    `the healthy-roster string must exist once (in rosterHealthyLine); found ${String(sites.length)}: ${JSON.stringify(sites.map((s) => s.trim().slice(0, 60)))}`)
  assert.match(src, /line\(rosterHealthyLine\(presetId, mounted\), false\)/, 'and the call site must use it')
})
