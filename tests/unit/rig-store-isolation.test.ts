/**
 * The acceptance rig must not write into the project's real store (#61 item 8).
 *
 * Measured before this existed: 29 of 47 rows in the developer's LIVE registry were e2e-shaped and 42
 * test trees sat in this repo's production `.dsh-chapters/`, where #60's auditor then reported them as
 * damage (441 `test-litter` findings). Whether the HOST honours the row can only be seen by booting a
 * browser — the corpus is un-anchored (#56) — so what is pinned here is the rig's own contract: which
 * text it writes, per port, and that a rerun replaces rather than stacks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRigPluginPatch, rigStoreRoot } from '../e2e/boot.ts'

const PROVIDER_ROW = `- id: llm-pi-ai
  config:
    providers:
      local:
        baseURL: http://localhost:8080/v1
`

test('each port gets its OWN absolute store root, and nothing else moves', () => {
  const a = applyRigPluginPatch(PROVIDER_ROW, { storeRoot: rigStoreRoot(41733) })
  const b = applyRigPluginPatch(PROVIDER_ROW, { storeRoot: rigStoreRoot(41737) })
  assert.match(a, /artifactStoreRoot: .*e2e-home-41733\/chapters/, 'the row carries this port\'s home')
  assert.match(b, /artifactStoreRoot: .*e2e-home-41737\/chapters/, 'a different port, a different root')
  // assert on the VALUE, not the file text: the row's own comment mentions the tree it protects,
  // and a guard that fails on prose is a guard that gets deleted rather than fixed.
  const value = /artifactStoreRoot: (\S+)/.exec(a)?.[1] ?? ''
  assert.ok(value.startsWith('/'), `absolute path required, got ${value}`)
  assert.ok(!value.endsWith('.dsh-chapters') && !value.includes('/.dsh-chapters'),
    `the config value must never be the project's own store, got ${value}`)
  assert.match(a, /id: llm-pi-ai/, 'the provider row survives untouched')
  assert.match(rigStoreRoot(41733), /^\//, 'absolute: a relative value would resolve against whatever cwd the host has')
})

test('rerunning the patch replaces our row instead of stacking a second one', () => {
  const once = applyRigPluginPatch(PROVIDER_ROW, { storeRoot: '/x/one' })
  const twice = applyRigPluginPatch(once, { storeRoot: '/x/two' })
  const rows = twice.match(/^- id: '@treeseed\/dsh-chapters'$/gm) ?? []
  assert.equal(rows.length, 1, `two rows for one id leaves precedence to the host's merge order:\n${twice}`)
  assert.match(twice, /artifactStoreRoot: \/x\/two/, 'and the new value is the one present')
  assert.ok(!twice.includes('/x/one'), 'the stale value is gone, not shadowed')
})

test('the CI guard exists and compares a directory listing (#61 item 8)', async () => {
  const fs = await import('node:fs')
  const src = await fs.promises.readFile(new URL('../../scripts/assert-store-untouched.mjs', import.meta.url), 'utf8')
  assert.match(src, /snapshot|verify/, 'two modes: snapshot before the suite, verify after')
  assert.match(src, /\.dsh-chapters/, 'and what it guards is the production store root')
})
