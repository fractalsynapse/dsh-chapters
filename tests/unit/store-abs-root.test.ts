import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveStoreRoot, makeArchiveFs } from '../../src/store.ts'

test('resolveStoreRoot: absolute wins, relative roots at cwd (#33)', () => {
  assert.equal(resolveStoreRoot('/workspace/sub', '/store/.dsh'), '/store/.dsh')
  assert.equal(resolveStoreRoot('/workspace/sub', '.dsh-chapters'), '/workspace/sub/.dsh-chapters')
})

test('makeArchiveFs passes absolute paths through, roots relative ones at baseDir (#33)', async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-fs-'))
  try {
    const a = makeArchiveFs(base)
    await a.write('rel/inner.md', 'r')
    const absFile = path.join(base, 'elsewhere', 'outer.md')
    await a.write(absFile, 'o')
    assert.ok(fs.existsSync(path.join(base, 'rel/inner.md')))
    assert.ok(fs.existsSync(absFile), 'absolute write lands AT the absolute path, not under baseDir')
    assert.equal(await a.read(absFile), 'o')
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})

/**
 * The two sites that hand-rolled `join(cwd, artifactStoreRoot)` (#113 rig divergence).
 *
 * `resolveStoreRoot` exists precisely because a pinned profile may use an ABSOLUTE root — its own doc says so,
 * and #69 already fixed this class for diagnostics and stored paths. Two call sites kept joining anyway, so an
 * absolute root silently became `<cwd>/<absolute path>`. This is a guard row, not a proof: it pins the call
 * sites to the resolver. The behavioral half of the claim already lives in the tests above for
 * `resolveStoreRoot` itself — an absolute root wins verbatim, a relative one stays per-workspace.
 */
test('mined-rule capture and repair resolve their store root through the one resolver', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const root = path.resolve(import.meta.dirname, '..', '..')
  const idx = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8')
  const rep = fs.readFileSync(path.join(root, 'src', 'repair-run.ts'), 'utf8')
  assert.ok(!/storeDir: join\(cwd, config\.artifactStoreRoot\)/.test(idx),
    'onMinedRules must not join an absolute store root onto the cwd')
  assert.ok(!/path\.join\(cwd, storeRoot\)/.test(rep),
    'repair must enumerate subdirectories of the resolved root, not a joined guess')
  assert.match(idx, /storeDir: resolveStoreRoot\(cwd, config\.artifactStoreRoot\)/, 'it uses the resolver')
})
