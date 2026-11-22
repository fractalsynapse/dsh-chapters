/**
 * #445 — the host-aware drop-guard must see RETIRED SUBPATHS, not just absent packages.
 *
 * Fixtures are the REAL exports maps captured from the hermetic host trees
 * (var/host-matrix/0.2.1-rc.5 and 0.2.2-rc.5 — 0.2.2 removed './list-agents' and
 * './list-agents/locale/*.json' while keeping the package). A fake tree on disk with those
 * exact bytes is the host's own filesystem fact; the resolver reads it and never imports it.
 * The mutation pair at the bottom is the point: the SAME specifier gets OPPOSITE verdicts
 * driven purely by the host tree's bytes — the drop is the host's decision, not ours.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { makeHostAwareResolver, registerPrunedPreset } from '../../src/preset.ts'

// REAL captured maps (verified against the trees 2026-11-21)
const EXPORTS_022 = {
  '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
  './src/*': './src/*',
  './package.json': './package.json',
  './locale/*.json': './locale/*.json',
}
const EXPORTS_021 = {
  '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
  './list-agents': { types: './lib/types/list-agents.d.ts', default: './lib/types/list-agents.js' },
  './src/*': './src/*',
  './package.json': './package.json',
  './locale/*.json': './locale/*.json',
  './list-agents/locale/*.json': './locale/list-agents/*.json',
}

const PKG = '@deepseek-ai/dsh-tool-subagent-control'
const ROW = { id: 'tool-subagent-list-agents', name: `${PKG}/list-agents` }

function fakeHostTree(exports: unknown | 'broken' | 'none'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosttree-'))
  const nm = path.join(root, 'node_modules')
  const pkg = path.join(nm, PKG)
  fs.mkdirSync(pkg, { recursive: true })
  fs.mkdirSync(path.join(nm, '@deepseek-ai/dsh'), { recursive: true }) // trust-gate sample needs ONE present name
  fs.writeFileSync(path.join(nm, '@deepseek-ai/dsh/package.json'), '{}')
  if (exports === 'broken') fs.writeFileSync(path.join(pkg, 'package.json'), '{ not json !!')
  else if (exports === 'none') fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: PKG, main: './index.js' }))
  else fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: PKG, exports }))
  return nm
}

const resolverFor = (nm: string) => makeHostAwareResolver([ROW], {
  entryPath: path.join(nm, '.bin/dsh'),
  pluginResolvable: () => true, // the lineage says YES to everything — only the host tree may decide
})

test('#445: the 0.2.2 world drops the retired ./list-agents row from the host’s own bytes', () => {
  const r = resolverFor(fakeHostTree(EXPORTS_022))
  assert.equal(r(ROW.name), false, 'exports present without the subpath = ERR_PACKAGE_PATH_NOT_EXPORTED at activation — keep it and the WHOLE preset goes BROKEN')
  assert.equal(r(PKG), true, 'the bare package is still present — containment keeps it')
  assert.equal(r(`${PKG}/locale/en.json`), true, 'pattern keys (./locale/*.json) match')
  assert.equal(r(`${PKG}/src/x.ts`), true, './src/* covers deep source subpaths')
})

test('#445: the 0.2.1 world keeps the row — same code, same specifier, opposite verdict', () => {
  const r = resolverFor(fakeHostTree(EXPORTS_021))
  assert.equal(r(ROW.name), true, 'the exact ./list-agents key exports it')
  assert.equal(r(`${PKG}/list-agents/locale/en.json`), true, 'and the patterned list-agents locale')
})

test('#445: a wrong drop is worse than a loud BROKEN — keep whenever the host bytes cannot decide', () => {
  assert.equal(resolverFor(fakeHostTree('broken'))(ROW.name), true, 'unreadable package.json: keep')
  assert.equal(resolverFor(fakeHostTree('none'))(ROW.name), true, 'no exports field: legacy resolution, containment is our best fact')
  assert.equal(resolverFor(fakeHostTree({}))(ROW.name), false, 'exports: {} is a real verdict — Node refuses every subpath')
})

test('#445: the drop is NAMED end to end — registerPrunedPreset reports it, never silently', async () => {
  const nm = fakeHostTree(EXPORTS_022)
  const resolver = resolverFor(nm)
  const definition = { id: 'chapters', order: 1, plugins: [ROW, { id: 'keepme', name: `${PKG}/src/deep.ts` }] }
  const { outcome } = await registerPrunedPreset(
    { register: async () => async () => undefined },
    definition,
    resolver,
  )
  assert.equal(outcome.state, 'pruned', JSON.stringify(outcome))
  if (outcome.state === 'pruned') assert.deepEqual(outcome.dropped, [`${ROW.id} (${ROW.name})`], "exactly the retired row, named id+specifier — the same shape the host BROKEN line carries; the pattern-kept row rides")
})

test('#445 mutation pair: identical calls, opposite answers — the host tree drives, not memorized names', () => {
  const on022 = resolverFor(fakeHostTree(EXPORTS_022))(ROW.name)
  const on021 = resolverFor(fakeHostTree(EXPORTS_021))(ROW.name)
  assert.notEqual(on022, on021, 'a fix keyed to the package NAME would answer the same in both worlds — that is the bug this row refuses')
})

test('#437 regression floor: containment decisions survive the subpath upgrade', () => {
  const nm = fakeHostTree(EXPORTS_022)
  const r = resolverFor(nm)
  assert.equal(r('@deepseek-ai/a-package-the-host-tree-lacks'), false, 'absent package: the #437 containment drop still fires')
  const untrusted = makeHostAwareResolver([{ id: 'x', name: '@deepseek-ai/nowhere' }], {
    entryPath: path.join(nm, '.bin/dsh'),
    pluginResolvable: () => true,
  })
  assert.equal(untrusted('@deepseek-ai/nowhere'), true, 'when NO mounted name is in the tree, the resolver is untrusted and the lineage fallback answers — #437 load-bearing behavior')
})
