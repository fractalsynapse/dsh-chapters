/**
 * The provenance gate (#56): one parser, honest both ways.
 *
 * A gate that only ever refuses is as useless as one that only ever passes, so these rows
 * assert the lift too: matching host ⇒ anchored, no code edit. And a missing record is
 * UNANCHORED, never "assume fine" — unknown provenance means the chain is not claimed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { corpusAnchor, parseSimple } = require_('../../scripts/corpus-anchor.mjs') as
  { corpusAnchor: (root: string) => { anchored: boolean, pinned: string, distilled: string | null, reason: string, tracking: string | null }, parseSimple: (t: string) => Record<string, string> }

const tree = (opts: { corpus?: string, pinned?: string }): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-anchor-'))
  fs.mkdirSync(path.join(root, 'dev', 'dsh-host-lock'), { recursive: true })
  fs.mkdirSync(path.join(root, 'tests', 'fixtures', 'model-tape'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dev', 'dsh-host-lock', 'package.json'),
    JSON.stringify({ dependencies: { '@deepseek-ai/dsh': opts.pinned ?? '0.2.0-rc.2' } }))
  if (opts.corpus !== undefined) {
    fs.writeFileSync(path.join(root, 'tests', 'fixtures', 'model-tape', 'CORPUS_HOST'), opts.corpus)
  }
  return root
}

test('the committed repo state is honestly reported: pinned 0.2.x, corpus distilled on 0.1.5', () => {
  const a = corpusAnchor(path.resolve(process.cwd()))
  assert.equal(a.pinned, '0.2.0-rc.2', 'the lock is the source of the pin (no second literal)')
  assert.equal(a.anchored, false, 'the corpus still predates the move — the gate must be CLOSED, not decorative')
  assert.match(a.tracking ?? '', /\/issues\/56$/, 'and it names the issue that lifts it')
})

test('a matching host record lifts the gate with no code change', () => {
  const root = tree({ pinned: '0.2.0-rc.2', corpus: 'host = 0.2.0-rc.2\ntracking = x\n' })
  try {
    const a = corpusAnchor(root)
    assert.equal(a.anchored, true, `expected anchored, got: ${a.reason}`)
    assert.match(a.reason, /distilled against 0\.2\.0-rc\.2/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a mismatched record refuses, naming both versions', () => {
  const root = tree({ pinned: '0.2.0-rc.2', corpus: 'host = 0.1.5-rc.1\n' })
  try {
    const a = corpusAnchor(root)
    assert.equal(a.anchored, false)
    assert.match(a.reason, /0\.1\.5-rc\.1/)
    assert.match(a.reason, /0\.2\.0-rc\.2/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('unknown provenance is UNANCHORED — never an assumed pass', () => {
  for (const [label, root] of [
    ['missing file', tree({})],
    ['file without a host line', tree({ corpus: '# just a comment\nreason = x\n' })],
    ['unparseable lock', (() => { const r = tree({ corpus: 'host = 1.2.3\n' }); fs.writeFileSync(path.join(r, 'dev', 'dsh-host-lock', 'package.json'), 'not json'); return r })()],
  ] as const) {
    try {
      const a = corpusAnchor(root)
      assert.equal(a.anchored, false, `${label} must not be treated as anchored`)
      assert.ok(typeof a.reason === 'string' && a.reason !== '', `${label} must say why`)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
})

test('the record format ignores comments and blank lines, and keeps free-text reason', () => {
  const rec = parseSimple('# c\n\nhost = 1.2.3\nreason = two words here\n# trailing\n')
  assert.deepEqual(rec, { host: '1.2.3', reason: 'two words here' })
})
