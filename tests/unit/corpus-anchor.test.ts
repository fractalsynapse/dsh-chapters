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

/**
 * The row that watched the gate being CLOSED, now watching it lift.
 *
 * Flipping `host = 0.1.5-rc.1` to `0.2.0-rc.2` in `CORPUS_HOST` was designed to be the ONLY
 * action that reopens the acceptance chain — "the lift is a data edit, not a code change" — so
 * this row changes its expectation with the re-anchor, and keeps its teeth in a way the old
 * version could not: it asserts WHY it is open (pinned equals distilled) and mutates the record
 * to prove a future pin move closes the gate again without anyone touching a test.
 */
/**
 * The gate's whole life in one day, recorded where a reader will hit it: opened on the re-anchor
 * (`bcb16d3`), closed an hour later when the corpus turned out to be distilled against a LINKED DEV
 * BUILD of the host rather than the pin (#89), and opened again once the nine legs had been re-run
 * under the pinned hermetic install — booted by absolute path and self-recorded as
 * `hostPinned: true` in `var/e2e-boot-<port>.json`.
 *
 * Why the row tracks the state instead of pinning "closed" forever: the gate exists to refuse a
 * corpus that cannot replay, and that is a fact about the record, not a preference. The mutation
 * block below proves BOTH directions by data alone, so neither state can be asserted by wish.
 */
test('the corpus is anchored to the pinned host it was recorded on, and the gate moves by data only', () => {
  const root = path.resolve(process.cwd())
  const a = corpusAnchor(root)
  assert.equal(a.pinned, '0.2.0-rc.2', 'the lock is the source of the pin (no second literal)')
  assert.equal(a.anchored, true, 'open: the corpus and the pin are the same host, booted by absolute path')
  // `corpusAnchor` computes the reason when the record MATCHES (only a mismatch gets the two-version
  // statement), so "what makes this open" lives in the record's own `reason` key — assert it there,
  // where a human reading the file will find it, rather than inventing a field the resolver does not have.
  assert.equal(a.distilled, a.pinned, 'open means the record equals the pin')
  const recordText = fs.readFileSync(path.join(path.resolve(process.cwd()), 'tests', 'fixtures', 'model-tape', 'CORPUS_HOST'), 'utf8')
  assert.match(recordText, /PINNED hermetic host|hostPinned/i,
    'the record itself says why this corpus may replay where the last one could not (#89)')

  // mutation: the drift that matters is the RECORD falling behind the PIN. `pinned` in the file
  // is documentary — `corpusAnchor` resolves the truth from the lock — so the honest mutation is
  // to the `host =` line, and that is also exactly what happens next time somebody moves
  // `dev/dsh-host-lock` and forgets to re-distill.
  const file = path.join(root, 'tests', 'fixtures', 'model-tape', 'CORPUS_HOST')
  const before = fs.readFileSync(file, 'utf8')
  const baseline = corpusAnchor(root).anchored
  try {
    // (1) write the PIN into the record: the gate must OPEN with no code change — this is the
    // mechanism the whole re-anchor ends on, and asserting it here means it is proven whether or not
    // the committed record currently claims it.
    fs.writeFileSync(file, before.replace(/^host = .*$/m, `host = ${a.pinned}`))
    assert.equal(corpusAnchor(root).anchored, true, 'a record that names the pin opens the chain by data alone')
    // (2) write a stale version: it must close again, naming both versions.
    fs.writeFileSync(file, before.replace(/^host = .*$/m, 'host = 0.1.5-rc.1'))
    const stale = corpusAnchor(root)
    assert.equal(stale.anchored, false, 'a corpus left behind by the pin must re-close the chain with no code edit')
    assert.match(stale.reason, /0\.1\.5-rc\.1/, 'and say which version it was distilled against')
  } finally {
    fs.writeFileSync(file, before)
    assert.equal(corpusAnchor(root).anchored, baseline,
      'restored to the committed state exactly — the mutation leaves nothing behind either way')
  }
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
