/**
 * Cross-machine removal tombstones (#256) — the fact channel, its parse tolerance, and the two
 * consumer seams. #255 made removal correct on ONE machine: store + mirror unlink + registry
 * stub + rehydration guard. A second machine that still holds the bytes re-publishes them on its
 * next pass, because `planStoreToRepo` copies what the store has and no fact has ever told it
 * otherwise. The fix rides the pool's already-synced, append-only collections JSONL with one
 * fact line per deleted chapter — so the contract these rows pin is: facts arrive with the pull,
 * publishing skips claimed tails, rehydration skips claimed tails, and NOTHING a malformed line
 * can print ever blocks a sync pass or rewrites a pool byte.
 *
 * The registry decision is the documented conservative one: a remote fact stops bytes
 * travelling; it never rewrites a local row's status. The last row pins that silence is not
 * allowed either — the skip is STATED in the steps.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  removalFactsFromLines, appendRemovalFacts, planStoreToRepo, rehydrateStoreFromMirror,
  type RemovalFact,
} from '../../src/sync.ts'

const chapterLine = JSON.stringify({
  seqs: [1, 2], paths: [], commands: [], terms: ['t'], size: 10, by: 'deterministic',
})

test('#256: a well-formed fact yields the guard-dialect key <session>#<file>', () => {
  const fact: RemovalFact = { type: 'chapter-removed', tail: 'treeA/chapters/007-poison.md', span: [41, 44], by: 'h-a', at: '2026-11-19T00:00:00.000Z' }
  const { keys, problems } = removalFactsFromLines([chapterLine, JSON.stringify(fact)])
  assert.deepEqual(problems, [], 'a signature line is NOT a problem — facts and signatures share the file')
  assert.equal(keys.has('treeA#007-poison.md'), true, 'the key dialect matches removedGuard/RemovedGuard.chapterKeys')
  assert.equal(keys.size, 1)
})

test('#256: parse tolerance — a malformed line is skipped, never fatal; wrong shapes name a problem', () => {
  const { keys, problems } = removalFactsFromLines([
    '{not json at all',                                                    // garbage: skipped, pass continues
    '{"type":"chapter-removed"}',                                          // no tail: a problem, skipped
    '{"type":"chapter-removed","tail":"treeA/007.md"}',                    // wrong dialect (no chapters segment): a problem
    '{"type":"chapter-removed","tail":42}',                                // non-string tail: a problem
    JSON.stringify({ type: 'chapter-removed', tail: 'treeB/chapters/001-ok.md', span: [1, 2], by: 'h', at: 'x' }),
  ])
  assert.equal(keys.size, 1, 'only the well-formed fact counts')
  assert.equal(keys.has('treeB#001-ok.md'), true)
  assert.equal(problems.length, 3, `three malformed facts named, got: ${JSON.stringify(problems)}`)
  assert.ok(problems.every((p) => /line \d+/.test(p)), 'each problem carries its line number — a silent skip is how drift hides')
})

test('#256: append is APPEND — existing bytes of the file are never rewritten or reordered', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-facts-'))
  try {
    const file = path.join(root, 'collections', 'KEY', 'sess-1.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, chapterLine + '\n')
    appendRemovalFacts(root, 'KEY', 'sess-1', [
      { type: 'chapter-removed', tail: 'treeA/chapters/007-poison.md', span: [41, 44], by: 'h-a', at: '2026-11-19T00:00:00.000Z' },
    ])
    appendRemovalFacts(root, 'KEY', 'sess-1', [
      { type: 'chapter-removed', tail: 'treeA/chapters/008-also.md', span: [45, 46], by: 'h-a', at: '2026-11-19T00:00:01.000Z' },
    ])
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '')
    assert.equal(lines[0], chapterLine, 'the signature line bytes are untouched at the head — append-only, as the channel promises')
    assert.equal(lines.length, 3, 'each append added exactly its fact')
    assert.ok(lines[2].includes('008-also.md'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('#256: planStoreToRepo skips a store chapter whose tail a fact claims and keeps every sibling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skip-'))
  try {
    const write = (rel: string): void => {
      const abs = path.join(root, '.dsh-chapters', rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, '---\ntitle: "x"\n---\n# x\n')
    }
    write('treeA/chapters/007-poison.md')
    write('treeA/chapters/008-keep.md')
    write('treeA/artifacts/ab/abcdef.txt')
    const plain = planStoreToRepo(path.join(root, '.dsh-chapters'), 'KEY')
    assert.equal(plain.length, 3, 'without facts, everything the store holds is planned — the status quo')
    const guarded = planStoreToRepo(path.join(root, '.dsh-chapters'), 'KEY', new Set(['treeA#007-poison.md']))
    const rels = guarded.map((f) => f.rel.replace(/\\/g, '/'))
    assert.equal(rels.filter((r) => r.includes('007-poison')).length, 0, 'the claimed tail never reaches the mirror')
    assert.ok(rels.some((r) => r.includes('008-keep.md')) && rels.some((r) => r.includes('abcdef.txt')),
      'and nothing ELSE is skipped — artifacts stay publishable (shared blobs are #255\'s orphan rule, not this fact\'s)')
    assert.equal(guarded.length, 2)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('#256: rehydration honors PULLED facts even where the local registry has no stub — the guard union already speaks one dialect', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rehyd-'))
  try {
    const clone = path.join(root, 'clone')
    const store = path.join(root, 'store')
    // the pool (after someone else\'s deletion) still carries a straggler copy: guard must keep it OUT of the store
    fs.mkdirSync(path.join(clone, 'chapters', 'KEY', 'treeA'), { recursive: true })
    fs.writeFileSync(path.join(clone, 'chapters', 'KEY', 'treeA', '007-poison.md'), 'x')
    fs.writeFileSync(path.join(clone, 'chapters', 'KEY', 'treeA', '009-live.md'), 'x')
    const out = rehydrateStoreFromMirror(clone, store, 'KEY', { chapterKeys: new Set(['treeA#007-poison.md']), blobKeys: new Set() })
    assert.equal(out.restored, 1, 'the live chapter rehydrates normally')
    assert.equal(out.skippedRemoved, 1, 'the fact-claimed tail is a DECISION, not a gap')
    assert.equal(fs.existsSync(path.join(store, 'treeA', 'chapters', '007-poison.md')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
