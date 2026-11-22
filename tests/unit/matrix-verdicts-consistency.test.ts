/**
 * #455 — two integrity guards for the sweep's public claims.
 *
 * 1. The README's support table and the COMMITTED verdict files (matrix-verdicts/, updated by
 *    each nightly refresh PR) must agree row by row. Without this, the prose table and the
 *    evidence could drift apart — the exact #451 lesson: a table can only ever mean what its
 *    artifacts say, and this test makes that mechanical.
 * 2. Matrix cells skip the repo-pin-consistency rows BY NAME (DSH_MATRIX_VERSION); the roster
 *    of those rows is frozen here. An un-named skip, or a skip that appears outside a cell,
 *    would silently weaken the very guards the pinned world rests on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

test('#455: every committed sweep verdict has its matching README row — same version, same verdict', () => {
  const dir = path.join(ROOT, 'matrix-verdicts')
  assert.ok(fs.existsSync(dir), 'matrix-verdicts/ must exist — the refresh workflow commits it (#455)')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.lock.json'))
  assert.ok(files.length >= 19, `the committed receipts roster is not empty (found ${String(files.length)}) — a vacuous directory fails`)
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const block = md.split('<!-- versions:begin -->')[1]?.split('<!-- versions:end -->')[0] ?? ''
  for (const f of files) {
    const v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { version: string; verdict: string; legs?: { leg: string; ok: boolean }[] }
    const row = block.split('\n').find((l) => l.startsWith(`| ${v.version} |`))
    assert.ok(row !== undefined, `${v.version} has a committed verdict but NO README row — silence is the #455 defect`)
    if (v.verdict === 'pass') {
      assert.match(row, /✅ supported/, `${v.version}: verdict pass, README row: ${row}`)
      for (const leg of v.legs ?? []) assert.ok(row.includes(`${leg.leg}:${leg.ok ? '✅' : '❌'}`), `${v.version}: README cells must mirror the leg results`)
    } else {
      assert.match(row, /❌|❓/, `${v.version}: verdict ${v.verdict} must not render green`)
    }
  }
})

test('#455: the matrix-cell skip roster is exactly the frozen named set — no silent skips', () => {
  const ROSTER: Record<string, number> = {
    'unit/host-dep-pinning.test.ts': 2, // root-vs-lock pin row + installed-types row (#447)
    'unit/attach-child.test.ts': 1,     // #180 drift row — reads dev/dsh-host-lock types (#466)
    'unit/host-plan-card-shape.test.ts': 4, // all four rows read the pinned host tree (#466)
    'unit/preset-declaration.test.ts': 2,     // the two host-standard identity rows (#467)
  }
  const found = new Map<string, number>()
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p); continue }
      if (!f.name.endsWith('.ts')) continue
      const text = fs.readFileSync(p, 'utf8')
      const hits = [...text.matchAll(/skip:\s*process\.env\.DSH_MATRIX_VERSION/g)].length
      if (hits > 0) found.set(path.relative(path.join(ROOT, 'tests'), p), hits)
    }
  }
  walk(path.join(ROOT, 'tests'))
  assert.deepEqual(Object.fromEntries(found), ROSTER,
    'cell-skip rows are a named, count-frozen roster: every skip must be justified in #447/#466 terms and visible here')
  // and every skip MESSAGE names the cell — a skip that never says why is the silence this guards against
  for (const [file, hits] of found) {
    const text = fs.readFileSync(path.join(ROOT, 'tests', file), 'utf8')
    const named = (text.match(/`matrix cell for \$\{process\.env\.DSH_MATRIX_VERSION\}/g) ?? []).length
    assert.equal(named, hits, `${file}: every cell-skip must announce the cell it skips for`)
  }
})
