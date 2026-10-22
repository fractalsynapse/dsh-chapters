/**
 * One dialect for stored paths (#69).
 *
 * `ChapterRecord.path` had two producers: the doors minted from a RELATIVE `artifactStoreRoot`, the
 * in-place compaction realm from a resolved ABSOLUTE one. Six records — chapter 1 of the two longest
 * sessions on this machine, each with 300+ messages — were therefore absolute. The auditor compared them
 * with `===` against a disk listing that is relative, so one file was simultaneously a cited record AND
 * its own "unregistered twin", and `/chapters-repair` offered to re-register the archive it had just
 * written. The fix is a canonical form at the mint and a canonical comparison at every read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toStoredPath, sameStoredPath, chapterFileName } from '../../src/archive.ts'
import { chapterPathFor } from '../../src/engine-core.ts'
import { audit } from '../../src/repair.ts'
import { freshSession, type ChapterRecord, type SessionState } from '../../src/registry.ts'

const CWD = '/home/adrian/Projects/demo'
const REL = '.dsh-chapters/root-1/chapters/001-first.md'

test('toStoredPath: inside the workspace becomes relative, outside stays honest', () => {
  assert.equal(toStoredPath(CWD, `${CWD}/${REL}`), REL, 'absolute-under-cwd → the relative form')
  assert.equal(toStoredPath(CWD, REL), REL, 'already relative → unchanged')
  assert.equal(toStoredPath(CWD, '/elsewhere/x.md'), '/elsewhere/x.md',
    'outside the workspace is NOT rewritten into a `../..` lie — an absolute store root is legal config (#61)')
  assert.equal(toStoredPath(undefined, `/tmp/a.md`), '/tmp/a.md', 'no cwd known → the caller keeps the dialect')
  assert.equal(toStoredPath('', REL), REL, 'empty cwd is treated as unknown, not as filesystem root')
})

test('sameStoredPath sees one file as one path, in either dialect', () => {
  assert.equal(sameStoredPath(REL, `${CWD}/${REL}`, CWD), true, 'the #69 pair: relative vs absolute')
  assert.equal(sameStoredPath(REL, REL), true, 'identity without a cwd still works')
  assert.equal(sameStoredPath('001-first.md', 'chapters/001-first.md', CWD), false, 'and it does not over-match')
})

test('the realm mint normalizes with a workspace cwd, and stays put without one', () => {
  const cfg = { artifactStoreRoot: `${CWD}/.dsh-chapters`, workspaceCwd: CWD } as never
  const p = chapterPathFor(cfg, 'root-1', 1, 'First chapter')
  assert.ok(!p.startsWith('/'), `absolute root must not leak into the record: ${p}`)
  assert.ok(p.endsWith(`/${chapterFileName(1, 'First chapter')}`), `the file name is unchanged: ${p}`)
  const outside = chapterPathFor({ artifactStoreRoot: '/var/chapters', workspaceCwd: CWD } as never, 'root-1', 2, 'T')
  assert.ok(outside.startsWith('/var/chapters'), 'a store genuinely outside the workspace keeps its path')
})

test('the auditor no longer reports a file as its own unregistered twin (#69)', () => {
  const abs = `${CWD}/${REL}`
  const rec: ChapterRecord = {
    number: 1, path: abs, title: 'First', summary: 's', startSeq: 0, endSeq: 9,
    topics: [], messages: 326, sha256: 'a'.repeat(64), estimatedTokens: 900, artifacts: [],
  }
  const state: SessionState = { ...freshSession('root-1'), rootSession: 'root-1', chapters: [rec], nextChapterNumber: 2 }
  // disk lists the SAME file in the relative dialect — the exact shape the field produced
  const files = {
    exists: (p: string) => sameStoredPath(p, REL, CWD),
    bytes: () => 4000, shaMatches: () => true,
    chapterPaths: [REL], artifactPaths: [], emptyArtifactPaths: [], canScan: true,
  }
  const out = audit({ sessionId: 'root-1', cwd: CWD, state, files, log: { turnEndSeqs: [9], collections: [{ from: 0, to: 9 }] } as never })
  assert.deepEqual(out.findings, [], `one file, one dialect pair should be silence: ${JSON.stringify(out.findings.map((f) => f.class))}`)
  // and it still FINDS a real orphan — proving the fix is not a blindfold
  const realOrphan = { ...files, chapterPaths: [REL, '.dsh-chapters/root-1/chapters/007-lost.md'] }
  const out2 = audit({ sessionId: 'root-1', cwd: CWD, state, files: realOrphan, log: { turnEndSeqs: [9], collections: [] } as never })
  assert.ok(out2.findings.some((f) => f.class === 'unregistered-file' && f.target.path?.includes('007-lost')),
    'a genuinely unregistered file is still reported')
})

test('every door hands writeArchive its cwd (#69 source shape)', async () => {
  const fs = await import('node:fs')
  for (const f of ['save-core.ts', 'continue-core.ts']) {
    const src = await fs.promises.readFile(new URL(`../../src/${f}`, import.meta.url), 'utf8')
    assert.match(src, /storeRoot: config\.artifactStoreRoot,\s*\n\s*cwd/, `${f} must pass the cwd so records normalize at the mint`)
  }
})
