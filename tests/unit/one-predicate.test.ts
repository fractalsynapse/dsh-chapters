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
