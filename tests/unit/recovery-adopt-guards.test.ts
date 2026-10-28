/**
 * The recovery tool's adoption rules, as rows (#113 follow-up).
 *
 * `scripts/recovery/adopt-twins.cjs` is mine, written during the registry clobber recovery, and it admitted
 * a record that should never have entered a registry: `413-goal-round.md` — title `<goal_round>` (the
 * injected-title class #59 was filed for), span 12633–15794 **overlapping 246 active chapters**, 273K
 * tokens where the store target is 8K. The same run left four records in one row with absolute paths while
 * the rest were relative, because the tool called `path.relative(ROOT, abs)` with a `ROOT` that wasn't the
 * store's cwd and stored whatever came back — the #69 dialect violation that makes a chapter look like its
 * own unregistered twin.
 *
 * Adoption stays operator-authority work. These two rules are not authority: they are damage.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const nodeRequire = createRequire(import.meta.url)
const { planAdoption } = nodeRequire('../../scripts/recovery/adopt-twins.cjs') as {
  planAdoption: (row: unknown, dir: string, root: string, sessionId: string) => { adopt: Array<Record<string, unknown>>; refused: string[] }
}

function world() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'))
  const tree = path.join(cwd, '.dsh-chapters', 'S', 'chapters')
  fs.mkdirSync(tree, { recursive: true })
  const write = (name: string, seqRange: string): string => {
    fs.writeFileSync(path.join(tree, name), `---\ntitle: "A chapter"\nseqRange: ${seqRange}\nsummary: s\n---\n# body\n`)
  }
  return { cwd, tree, write }
}
const rel = (n: number, from: number, to: number): Record<string, unknown> =>
  ({ number: n, path: `.dsh-chapters/S/chapters/00${String(n)}-a.md`, status: 'active', startSeq: from, endSeq: to })

test('an orphan overlapping active records is refused, and the duplication is counted', () => {
  const w = world()
  w.write('005-big.md', '[12633, 15794]')
  const row = { chapters: [rel(1, 12000, 13000), rel(2, 13001, 15790)], nextChapterNumber: 3 }
  const out = planAdoption(row, w.tree, w.cwd, 'S')
  assert.equal(out.adopt.length, 0, 'the 413 case must not be admissible at all')
  assert.equal(out.refused.length, 1)
  assert.match(out.refused[0]!, /overlaps 2 active chapter\(s\) \(first: ch\.1\)/, `named and counted: ${out.refused[0]}`)
  fs.rmSync(w.tree, { recursive: true, force: true })
})

test("a clean orphan is adopted with a path in the row's own dialect", () => {
  const w = world()
  w.write('006-clean.md', '[20000, 20100]')
  const out = planAdoption({ chapters: [rel(1, 1, 100)], nextChapterNumber: 2 }, w.tree, w.cwd, 'S')
  assert.equal(out.adopt.length, 1, `should adopt: ${JSON.stringify(out.refused)}`)
  const rec = out.adopt[0]!
  assert.equal(rec.path, '.dsh-chapters/S/chapters/006-clean.md', 'minted through the store helper, not a hand-rolled relative()')
  assert.equal(rec.number, 2, 'next free number above the ACTIVE maximum')
  assert.equal(rec.adoptedFrom, '006-clean.md', 'and the record admits where it came from')
  assert.equal(rec.repairs, 1, 'an adopted twin is a repair, per #60')
  fs.rmSync(w.tree, { recursive: true, force: true })
})

test('absolute is legal; MIXING dialects inside one row is what is refused (#69)', () => {
  const w = world()
  w.write('007-abs.md', '[300, 400]')
  // A root that is not the file's ancestor makes the helper return an absolute path — legitimate on its own
  // (the rig pins an absolute artifactStoreRoot per port), but not into a row whose records are relative.
  const out = planAdoption({ chapters: [rel(1, 1, 100)], nextChapterNumber: 2 }, w.tree, path.join(os.tmpdir(), 'somewhere-else'), 'S')
  assert.equal(out.adopt.length, 0)
  assert.match(out.refused[0]!, /dialect is 'relative'/, `the refusal is about the mix, not the shape: ${out.refused[0]}`)
  fs.rmSync(w.tree, { recursive: true, force: true })
})

test('a file with no parseable seqRange is refused rather than guessed at', () => {
  const w = world()
  w.write('008-headless.md', 'not-a-range')
  const out = planAdoption({ chapters: [rel(1, 1, 100)], nextChapterNumber: 2 }, w.tree, w.cwd, 'S')
  assert.equal(out.adopt.length, 0)
  assert.match(out.refused[0]!, /unparseable seqRange/, `and it says which field failed: ${out.refused[0]}`)
  fs.rmSync(w.tree, { recursive: true, force: true })
})

test('the CLI body does not execute at import (a required tool must not read argv)', () => {
  // Requiring the module with no argv used to throw `path must be of type string`, which is how a script
  // that cannot be tested tends to stay untested.
  assert.equal(typeof planAdoption, 'function')
  void path
})
