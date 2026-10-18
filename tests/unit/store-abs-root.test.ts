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
