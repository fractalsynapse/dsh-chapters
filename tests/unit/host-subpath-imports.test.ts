/**
 * #470 — the test plane learns to SEE import-level host drift.
 *
 * 0.2.3 retired the `@deepseek-ai/dsh-commands/brand` SUBPATH while keeping the root
 * re-export; the break surfaced first as a matrix-cell compile failure. The same predicate
 * the runtime drop-guard uses (#445's hostSubpathExported — one predicate per decision,
 * exported now so guard and product cannot diverge) answers statically: every subpath our
 * own source imports from a host package must be exported by THAT NAME in the resolution
 * tree currently installed. Outside a matrix cell this pins the repo against the pinned
 * world; INSIDE a cell (matrix CI) it is a per-version compatibility statement — drift
 * names itself at guard time instead of dying anonymous at tsc.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { hostSubpathExported } from '../../src/preset.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** every `from '@deepseek-ai/<pkg>/<subpath>'` in shipped source (src/**\/*.ts) */
function hostSubpathImports(dir: string, acc: { file: string; spec: string }[] = []): { file: string; spec: string }[] {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    if (f.isDirectory()) { if (f.name !== 'node_modules' && f.name !== 'client') hostSubpathImports(p, acc); continue }
    if (!f.name.endsWith('.ts')) continue
    const src = fs.readFileSync(p, 'utf8')
    for (const m of src.matchAll(/from '(@deepseek-ai\/[^']+)'/g)) {
      const spec = m[1]!
      const segs = spec.split('/')
      const pkg = segs[0] === '@deepseek-ai' ? segs.slice(0, 2).join('/') : segs[0]!
      if (spec.length > pkg.length + 1) acc.push({ file: path.relative(ROOT, p), spec })
    }
  }
  return acc
}

test('#470: every host SUBPATH our source imports is exported by the installed host tree', () => {
  const nm = path.join(ROOT, 'node_modules')
  assert.ok(fs.existsSync(nm), 'the tree under test must be installed (unit runs after npm ci; matrix cells after their swap)')
  const imports = hostSubpathImports(path.join(ROOT, 'src'))
  const breaks: string[] = []
  for (const { file, spec } of imports) {
    const segs = spec.split('/')
    const pkg = segs.slice(0, 2).join('/')
    const sub = '.' + spec.slice(pkg.length)
    const pkgDir = path.join(nm, pkg)
    if (!fs.existsSync(pkgDir)) { breaks.push(`${file}: ${spec} — package absent from this host tree`); continue }
    if (!hostSubpathExported(pkgDir, sub, (x) => fs.existsSync(x), (x) => fs.readFileSync(x, 'utf8')))
      breaks.push(`${file}: ${spec} — package present, subpath NOT exported by this version`)
  }
  const cell = process.env.DSH_MATRIX_VERSION ? ` (matrix cell ${process.env.DSH_MATRIX_VERSION})` : ' (pinned world)'
  assert.deepEqual(breaks, [], `host-side subpath drift against OUR imports${cell}:\n${breaks.join('\n')}`)
})

test('#470: the scanner is not vacuous — it finds subpath imports and ignores root ones (fixture proof)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscan-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.ts'),
      "import type { X } from '@deepseek-ai/dsh-commands/brand'\nimport { y } from '@deepseek-ai/dsh-tools'\nimport type { Z } from '@deepseek-ai/dsh-attachment/types'\n")
    fs.mkdirSync(path.join(dir, 'client'))
    fs.writeFileSync(path.join(dir, 'client', 'skip.ts'), "import { c } from '@deepseek-ai/dsh-ignored/sub'\n")
    const found = hostSubpathImports(dir).map((i) => i.spec)
    assert.deepEqual(found.sort(), ['@deepseek-ai/dsh-attachment/types', '@deepseek-ai/dsh-commands/brand'],
      'exactly the SUBPATH imports, root imports and client/ excluded')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
