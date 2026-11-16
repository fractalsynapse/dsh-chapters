/**
 * Source-shape gate for #255 / #59: the "may this chapter be shown as knowledge?" decision
 * lives in exactly ONE predicate (`isActiveChapter`, src/registry.ts). A second hand-rolled
 * status comparison anywhere in src/ is how a widened meaning silently fails to reach one
 * derived layer — measured in #59 (two title predicates) and pre-#255 (enrich-wire.ts:195
 * filtering `!== 'superseded'` inline while the ONE predicate was supposed to own it).
 *
 * This test scans SOURCE TEXT, not behavior: it fires at the moment a second comparison is
 * written, naming file and line, instead of after a TOC cites what it should not.
 * Writing an assignment (`status: 'superseded'`) is NOT a filter and must not match.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src')

// a COMPARISON against a tombstone status value, shaped like a chapter-status read:
//  - `!== 'superseded'` / `!== 'removed'` — the knowledge-gate shape, which must live once;
//  - any comparison against `'removed'` — a chapter-only word, no plan status collides with it.
// `=== 'superseded'` is NOT matched: PlanFact.status shares the literal for a different domain
// (plans.ts / render.ts read PLAN status, not chapter status), and a broad match there would be
// an exemption list — the #59 failure mode itself. Assignments (`status:`) never match.
const FILTER = /status\??\.?\s*!==\s*'(superseded|removed)'|status\??\.?\s*[!=]==\s*'removed'/

test('the tombstone-status filter comparison exists ONLY inside the one predicate in registry.ts', () => {
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.ts')) continue
      const lines = fs.readFileSync(p, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (FILTER.test(line)) hits.push(`${path.relative(SRC, p)}:${String(i + 1)}`)
      })
    }
  }
  walk(SRC)
  assert.ok(hits.length >= 1, 'the gate itself is dead if the predicate body stops matching FILTER — update both together')
  const offenders = hits.filter((h) => !h.startsWith('registry.ts'))
  assert.deepEqual(offenders, [], `second status predicates found (${offenders.join(', ')}) — route the read through isActiveChapter (src/registry.ts), one predicate per decision (#59, #255)`)
})

/**
 * #396: the watermark — "first seq not yet archived" — is ONE predicate
 * (`nextUnarchivedSeq`, src/render.ts). Every hand-rolled `reduce(... endSeq ...)` is a second decision
 * waiting to disagree: #336 fixed exactly this in save-core, and the deterministic doors and the forced
 * child archive still carried the retired forms (a chapter covering seq 0 made the door refuse its own
 * ranges). The two-clause `lastArchived > 0 ?` shape is the same defect spelled differently. Sanctioned
 * sites are named; a new one must earn its place here, not in a door.
 */
const WATERMARK_REDUCE = /reduce\(.*endSeq/
const TWO_CLAUSE = /lastArchived\s*>\s*0\s*\?/
// render.ts owns the predicate; continue-core's display row is the one audited exception.
const WATERMARK_ALLOWED = ['render.ts']

test('the endSeq watermark exists ONLY as nextUnarchivedSeq in render.ts (#396)', () => {
  const reduceHits: string[] = []
  const clauseHits: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.ts')) continue
      const lines = fs.readFileSync(p, 'utf8').split('\n')
      lines.forEach((line, i) => {
        // Comments DOCUMENT the retired forms (render.ts names the old save-core shape verbatim);
        // the scan guards executable derivations, so comment-only lines are out of scope. A code line
        // carrying one of these expressions before a trailing comment still matches.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        const rel = `${path.relative(SRC, p)}:${String(i + 1)}`
        if (WATERMARK_REDUCE.test(line)) reduceHits.push(rel)
        if (TWO_CLAUSE.test(line)) clauseHits.push(rel)
      })
    }
  }
  walk(SRC)
  assert.ok(reduceHits.some((h) => h.startsWith('render.ts')), 'the predicate body must keep matching — update the scan and the predicate together')
  const offenders = reduceHits.filter((h) => !WATERMARK_ALLOWED.some((a) => h.startsWith(a)))
  assert.deepEqual(offenders, [], `second watermark derivations found (${offenders.join(', ')}) — route the read through nextUnarchivedSeq (src/render.ts), one predicate per decision (#396)`)
  assert.deepEqual(clauseHits, [], `retired two-clause watermark form found (${clauseHits.join(', ')}) — #336 replaced it (#396)`)
})
