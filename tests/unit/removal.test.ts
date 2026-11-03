/**
 * L0 tests for the chapter-removal core (#255). Real fs against a temp store tree, an in-memory
 * registry with the #59 mutate semantics — the failures these pin are the destructive ones:
 * a shared blob deleted out from under a living chapter, an apply that unlinks before the journal
 * exists, a stub that erases the span and re-opens the watermark (#59 poison), an id that resolves
 * to two chapters, a removal that reaches another project's tree.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { appendChapters, freshSession, type SessionState } from '../../src/registry.ts'
import type { ChapterRecord } from '../../src/archive.ts'
import { applyRemoval, planRemoval, readMissingAccess, removedGuard, resolveRemovalId, type RemovalTarget } from '../../src/removal.ts'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

const rec = (sessionId: string, number: number, over: Partial<ChapterRecord> = {}): ChapterRecord => ({
  number,
  path: `.dsh-chapters/${sessionId}/chapters/${String(number).padStart(3, '0')}-x.md`,
  title: `Chapter ${number}`,
  summary: `s${number}`,
  startSeq: number * 10,
  endSeq: number * 10 + 5,
  topics: [],
  sha256: 'a'.repeat(64),
  estimatedTokens: 10,
  artifacts: [],
  ...over,
})

/** Fixture store: real files under tmp, registry rows in-memory with one-section mutate (like the store). */
function fixture(): { cwd: string; storeDir: string; rows: Map<string, SessionState>; write: (rel: string, text: string) => string; mutateStore: (id: string, fn: (s: SessionState) => SessionState) => Promise<SessionState> } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'removal-'))
  const storeDir = path.join(cwd, '.dsh-chapters')
  fs.mkdirSync(storeDir, { recursive: true })
  const rows = new Map<string, SessionState>()
  const write = (rel: string, text: string): string => {
    const abs = path.join(cwd, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
    return abs
  }
  const mutateStore = async (id: string, fn: (s: SessionState) => SessionState): Promise<SessionState> => {
    const next = { ...fn(rows.get(id) ?? freshSession(id)), rev: (rows.get(id)?.rev ?? 0) + 1 }
    rows.set(id, next)
    return next
  }
  return { cwd, storeDir, rows, write, mutateStore }
}

const target = (sessionId: string, record: ChapterRecord): RemovalTarget =>
  ({ sessionId, rootSession: sessionId, record })

/** A RegistryStore over the SAME rows array the test holds — mutate replaces the element in place,
 *  which is the point: the test must observe exactly what applyRemoval committed (#59 semantics). */
const makeStore = (rows: [string, SessionState][]) => ({
  get: async (id: string) => rows.find(([k]) => k === id)?.[1] ?? freshSession(id),
  mutate: async (id: string, fn: (s: SessionState) => SessionState) => {
    const idx = rows.findIndex(([k]) => k === id)
    const before = idx >= 0 ? rows[idx]![1] : freshSession(id)
    const next = { ...fn(before), rev: (before.rev ?? 0) + 1 }
    if (idx >= 0) rows[idx] = [id, next]
    else rows.push([id, next])
    return next
  },
}) as never

// ---------------------------------------------------------------- resolve

test('resolve: registry path, pool path, sessionId:number, and the display ordinal all land on ONE record', () => {
  const f = fixture()
  const a = appendChapters(freshSession('A'), [rec('A', 1), rec('A', 2)])
  const rows: [string, SessionState][] = [['A', a]]
  const byRegistry = resolveRemovalId('.dsh-chapters/A/chapters/002-x.md', rows, f.cwd)
  assert.equal('target' in byRegistry ? byRegistry.target.record.number : -1, 2)
  const byPool = resolveRemovalId('chapters/key-a/A/002-x.md', rows, f.cwd)
  assert.equal('target' in byPool ? byPool.target.record.number : -1, 2)
  const bySessionNumber = resolveRemovalId('A:2', rows, f.cwd)
  assert.equal('target' in bySessionNumber ? bySessionNumber.target.record.number : -1, 2)
  // bare ordinal: position in the flat active index of the caller's ancestor path (caller = A itself)
  const byOrdinal = resolveRemovalId('2', rows, f.cwd, 'A')
  assert.equal('target' in byOrdinal ? byOrdinal.target.sessionId : '?', 'A')
})

test('resolve: unknown id refuses and names near candidates; a tombstone id refuses AS already gone', () => {
  const f = fixture()
  const a = appendChapters(freshSession('A'), [rec('A', 1), rec('A', 2, { status: 'removed' })])
  const rows: [string, SessionState][] = [['A', a]]
  const miss = resolveRemovalId('.dsh-chapters/A/chapters/009-nope.md', rows, f.cwd)
  assert.ok('refusal' in miss && /002-x\.md|near/.test(miss.refusal), 'near candidates printed')
  const gone = resolveRemovalId('A:2', rows, f.cwd)
  assert.ok('refusal' in gone && /already (been )?removed/.test(gone.refusal))
})

test('resolve: the same basename under two sessions is AMBIGUOUS — refuse, never guess', () => {
  const f = fixture()
  const rows: [string, SessionState][] = [
    ['A', appendChapters(freshSession('A'), [rec('A', 1)])],
    ['B', appendChapters(freshSession('B'), [rec('B', 1)])],
  ]
  const amb = resolveRemovalId('001-x.md', rows, f.cwd)
  assert.ok('refusal' in amb && /ambiguous/i.test(amb.refusal), 'two candidates refused')
  // but the pool-shaped path disambiguates:
  const ok = resolveRemovalId('chapters/k/B/001-x.md', rows, f.cwd)
  assert.equal('target' in ok ? ok.target.sessionId : '?', 'B')
})

// ---------------------------------------------------------------- plan: orphan math

test('plan: an artifact blob shared with an ACTIVE record survives; an orphan blob and plan docs die with the chapter', () => {
  const f = fixture()
  const shared = '.dsh-chapters/artifacts/ab/' + sha('shared') + '.txt'
  const owned = '.dsh-chapters/artifacts/cd/' + sha('owned') + '.txt'
  const planDoc = '.dsh-chapters/A/chapters/plan-001-p.md'
  f.write(shared, 'shared bytes'); f.write(owned, 'owned bytes'); f.write(planDoc, 'plan bytes')
  const keeper = rec('A', 1, { artifacts: [{ path: shared, sha256: sha('shared'), bytes: 6 }] })
  const doomed = rec('A', 2, {
    artifacts: [{ path: owned, sha256: sha('owned'), bytes: 5 }, { path: shared, sha256: sha('shared'), bytes: 6 }],
    planDocs: [{ seq: 30, path: planDoc, sha256: sha('plan bytes') }],
    plans: [{ seq: 30, status: 'approved' as const, title: 'p', sha256: sha('plan bytes'), artifactPath: owned, bytes: 5, estTokens: 1, resultSeq: null }],
  })
  f.write(keeper.path, 'keeper body')
  f.write(doomed.path, 'see also 001-x.md from the old session')
  const rows: [string, SessionState][] = [['A', appendChapters(freshSession('A'), [keeper, doomed])]]
  const plan = planRemoval({ targets: [target('A', doomed)], rows, cwd: f.cwd })
  assert.deepEqual(plan.blobFiles.map((b) => b.stored).sort(), [owned, planDoc].sort(), 'owned blob + plan doc die; shared survives')
})

test('plan: dangling citations of the removed chapter are reported, referrer first', () => {
  const f = fixture()
  const a = rec('A', 1)
  const b = rec('A', 2)
  f.write(a.path, `chapter one\\nreferences ${b.path} and 002-x.md`)
  f.write(b.path, 'doomed body')
  const rows: [string, SessionState][] = [['A', appendChapters(freshSession('A'), [a, b])]]
  const plan = planRemoval({ targets: [target('A', b)], rows, cwd: f.cwd })
  assert.equal(plan.dangling.length, 1)
  assert.equal(plan.dangling[0]!.referrer, a.path)
})

// ---------------------------------------------------------------- apply: journal-first

test('apply: a journal that cannot be written means NOTHING was deleted and NO record was stubbed', () => {
  const f = fixture()
  const a = rec('A', 1, { sha256: '' })
  const abs = f.write(a.path, 'body')
  a.sha256 = sha(fs.readFileSync(abs, 'utf8'))
  const rows: [string, SessionState][] = [['A', appendChapters(freshSession('A'), [a])]]
  const plan = planRemoval({ targets: [target('A', a)], rows, cwd: f.cwd })
  // sabotage: make the tree's removals dir UNWRITABLE by planting a FILE where the dir goes
  fs.mkdirSync(path.dirname(path.join(f.storeDir, 'A', 'removals')), { recursive: true })
  fs.writeFileSync(path.join(f.storeDir, 'A', 'removals'), 'not a dir')
  const store = makeStore(rows)
  return applyRemoval({ store, cwd: f.cwd, rows, storeDir: f.storeDir, now: () => '2026-11-02T19:00:00.000Z' }, plan)
    .then((out) => {
      assert.equal(out.removed.length, 0)
      assert.equal(fs.existsSync(path.join(f.cwd, a.path)), true, 'chapter file untouched')
      assert.equal(rows[0]![1].chapters[0]!.status, undefined, 'record untouched')
      assert.match(out.problems.join(' '), /journal/, 'the refusal names the journal')
    })
})

test('apply: chapter + orphan blobs unlinked, stub keeps number/span/sha and holds the watermark, log written', async () => {
  const f = fixture()
  const owned = '.dsh-chapters/artifacts/cd/blob.txt'
  f.write(owned, 'bytes')
  const a = rec('A', 1)
  const b = rec('A', 2, { artifacts: [{ path: owned, sha256: sha('bytes'), bytes: 5 }] })
  f.write(a.path, 'first body'); const bAbs = f.write(b.path, 'doomed')
  b.sha256 = sha(fs.readFileSync(bAbs, 'utf8'))
  const rows: [string, SessionState][] = [['A', appendChapters(freshSession('A'), [a, b])]]
  const plan = planRemoval({ targets: [target('A', b)], rows, cwd: f.cwd })
  const store = makeStore(rows)
  const out = await applyRemoval({ store, cwd: f.cwd, rows, storeDir: f.storeDir, now: () => '2026-11-02T19:00:00.000Z' }, plan)
  assert.equal(out.removed.length, 2, 'chapter file + orphan blob')
  assert.equal(fs.existsSync(path.join(f.cwd, b.path)), false)
  assert.equal(fs.existsSync(path.join(f.cwd, owned)), false)
  const stub = rows[0]![1].chapters.find((c) => c.number === 2)!
  assert.equal(stub.status, 'removed')
  assert.equal(stub.removedAt, '2026-11-02T19:00:00.000Z')
  assert.equal(stub.endSeq, 25, 'the span survives on the stub')
  assert.equal(stub.sha256, b.sha256, 'the recorded hash survives for restore verification')
  // journal exists and precedes the deletions it describes
  const jdir = path.join(f.storeDir, 'A', 'removals')
  const jfile = path.join(jdir, `${out.journalId}.json`)
  assert.equal(fs.existsSync(jfile), true)
  const j = JSON.parse(fs.readFileSync(jfile, 'utf8'))
  assert.equal(j.entries[0]!.sha256, b.sha256)
  // missing-access log: apply appended the stub line; the dangling scan names the referrer for the report
  f.write(a.path, 'first body cites 002-x.md')
  const log = readMissingAccess(f.storeDir, 10)
  assert.ok(log.total >= 1, `apply wrote the log (${String(log.total)} lines)`)
  assert.ok(log.lines.some((l) => l.includes('removed=.dsh-chapters/A/chapters/002-x.md')), 'the removal is logged')
  const plan2 = planRemoval({ targets: [target('A', stub)], rows, cwd: f.cwd })
  assert.equal(plan2.dangling.length, 1, 'the referrer shows on the operator report')
  assert.equal(plan2.dangling[0]!.referrer, a.path)
})

// ---------------------------------------------------------------- guard + clone

test('removedGuard: stub rows mint the mirror-side skip lists (session#file + blob basenames)', () => {
  const f = fixture()
  const a = appendChapters(freshSession('A'), [
    rec('A', 1),
    rec('A', 2, {
      status: 'removed',
      artifacts: [{ path: '.dsh-chapters/artifacts/cd/blob.txt', sha256: sha('x'), bytes: 1 }],
      planDocs: [{ seq: 5, path: '.dsh-chapters/A/chapters/plan-001-p.md', sha256: sha('p') }],
    }),
  ])
  const g = removedGuard([['A', a]])
  assert.ok(g.chapterKeys.has('A#002-x.md'))
  assert.ok(g.chapterKeys.has('A#plan-001-p.md'))
  assert.ok(g.blobKeys.has('blob.txt'))
  assert.equal(g.chapterKeys.has('A#001-x.md'), false, 'active chapters never enter the guard')
})

test('apply with a wired clone unlinks the mirror copy too — the pool commit carries the deletion', async () => {
  const f = fixture()
  const b = rec('A', 2)
  const bAbs = f.write(b.path, 'doomed')
  b.sha256 = sha(fs.readFileSync(bAbs, 'utf8'))
  const rows: [string, SessionState][] = [['A', appendChapters(freshSession('A'), [b])]]
  const plan = planRemoval({ targets: [target('A', b)], rows, cwd: f.cwd })
  const clone = path.join(f.cwd, '.dsh-knowledge')
  f.write('.dsh-knowledge/chapters/K/A/002-x.md', 'doomed mirrored')
  const store = makeStore(rows)
  const out = await applyRemoval({ store, cwd: f.cwd, rows, storeDir: f.storeDir, cloneDir: clone, projectKey: 'K', now: () => '2026-11-02T19:00:00.000Z' }, plan)
  assert.equal(out.problems.length, 0, out.problems.join('; '))
  assert.equal(fs.existsSync(path.join(f.cwd, b.path)), false, 'store bytes gone')
  assert.equal(fs.existsSync(path.join(clone, 'chapters', 'K', 'A', '002-x.md')), false, 'mirror bytes gone before the commit')
})

test('apply: a failing second unlink is journalled as partial and named — the chapter that went, went', () => {
  const f = fixture()
  const blob = '.dsh-chapters/artifacts/cd/blob.txt'
  fs.mkdirSync(path.join(f.cwd, blob), { recursive: true }) // a DIRECTORY where the blob should be: unlinkSync will throw
  const a = rec('A', 1)
  const b = rec('A', 2, { artifacts: [{ path: blob, sha256: sha('x'), bytes: 1 }] })
  f.write(a.path, 'first'); f.write(b.path, 'doomed')
  const rows: [string, SessionState][] = [['A', appendChapters(freshSession('A'), [a, b])]]
  const plan = planRemoval({ targets: [target('A', b)], rows, cwd: f.cwd })
  const store = makeStore(rows)
  return applyRemoval({ store, cwd: f.cwd, rows, storeDir: f.storeDir, now: () => '2026-11-02T19:30:00.000Z' }, plan)
    .then((out) => {
      assert.equal(fs.existsSync(path.join(f.cwd, b.path)), false, 'the chapter file is gone')
      assert.equal(out.stubbed.length, 1, 'the stub flipped — its own file went')
      assert.ok(out.problems.some((p) => p.includes('blob') && /unlink/.test(p)), `blob failure named: ${out.problems.join('; ')}`)
      const j = JSON.parse(fs.readFileSync(path.join(f.storeDir, 'A', 'removals', `${out.journalId}.json`), 'utf8'))
      assert.equal(j.status, 'partial')
      assert.ok(j.problems.length > 0, 'the journal carries the problems too')
    })
})
