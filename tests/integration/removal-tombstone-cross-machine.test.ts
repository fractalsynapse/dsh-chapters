/**
 * TWO machines, one local-path pool, one deletion (#256) — the resurrection test. #255 made
 * `/chapters-remove apply` correct on the machine that pulled the trigger: store unlink, mirror
 * unlink, registry stub, rehydration guard. The machine that merely SHARES the pool had none of
 * those facts — its store holds the bytes (rehydrated long ago), its registry says active, and
 * `planStoreToRepo` copies what the store has. Without tombstones its next sync pass re-pushes
 * what another operator deleted, and search resurrects it locally.
 *
 * The scenario: A pushes a chapter; B pulls (and its rehydration lands the bytes in B's store —
 * exactly the precondition for the bug); A removes it for real (applyRemoval with the mirror +
 * fact write, then a sync push carrying the deletion AND the regenerated fact); B syncs. B must
 * pull the deletion, NEVER re-publish its stale copy, stop finding the chapter in search, and
 * keep its own registry row untouched — the conservative semantics: a remote fact stops bytes
 * travelling, it does not rewrite local state.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as git from 'isomorphic-git'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSync, DEFAULT_CLONE_DIR, makeCollectionsReader, type ProjectRecord } from '../../src/sync.ts'
import { searchKnowledge } from '../../src/search.ts'
import { applyRemoval, planRemoval, removedGuard, type RemovalRows } from '../../src/removal.ts'

const project = (cwd: string, remote: string): ProjectRecord => ({
  projectKey: 'KEYLOCAL', slug: 'pool', remote, harnessId: 'h', linkedAt: new Date().toISOString(), cwd,
})
const writeFile = (p: string, content: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const chapter = (title: string, body: string): string =>
  `---\ntitle: "${title}"\ntopics: []\n---\n# ${title}\n\n${body}\n`
const chapterText = chapter('Render decisions', 'Tool-result deferral lives in src/render.ts.')
const sync = (cwd: string, remote: string) =>
  runSync({ cwd, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: project(cwd, remote), force: true })

/** Production's scheduler passes BOTH the reader's per-session lines AND the stub guard into
 *  runSync; the test must carry the same shape, or the rebuild path loses this machine's own
 *  claims (#256). */
const syncPublishing = (cwd: string, remote: string, rowsList: [string, any][]) =>
  runSync({
    cwd, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: project(cwd, remote), force: true,
    collections: makeCollectionsReader(() => rowsList[Symbol.iterator](), path.join(cwd, '.dsh-chapters'), () => 'h')(cwd),
    removed: removedGuard(rowsList as unknown as RemovalRows),
  })

test('#256: the removing machine ships the fact with the deletion; the other machine never re-publishes the corpse', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tomb-'))
  const pool = path.join(root, 'pool.git')
  const a = path.join(root, 'machine-a')
  const b = path.join(root, 'machine-b')
  try {
    // A publishes the contaminated chapter to the pool (one turn signature included).
    writeFile(path.join(a, '.dsh-chapters', 'treeA', 'chapters', '007-poison.md'), chapterText)
    const state = {
      rev: 0, parentSession: null, rootSession: 'treeA',
      collections: [{ seqs: [1, 2], paths: [], commands: [], terms: [], size: 5, by: 'deterministic' }],
      nextChapterNumber: 8, nextPlanNumber: 1, reservations: {},
      chapters: [{
        number: 7, title: 'Render decisions', startSeq: 10, endSeq: 12, sha256: 'a'.repeat(64),
        path: '.dsh-chapters/treeA/chapters/007-poison.md', estimatedTokens: 10, artifacts: [], status: 'active',
      }],
    }
    const rowsList: [string, any][] = [['treeA', state]]
    const rows = rowsList as unknown as RemovalRows
    const ra = await syncPublishing(a, pool, rowsList)
    assert.ok(ra.ok, ra.detail)

    // B pulls; its rehydration lands the bytes in B's store (the precondition #256 must survive).
    fs.mkdirSync(b)
    const rb = await sync(b, pool)
    assert.ok(rb.ok, rb.detail)
    assert.ok(rb.steps.some((s) => /rehydrated/i.test(s)), `B rehydrated the chapter into its store: ${rb.steps.join(' → ')}`)

    // A removes for real: stub + mirror unlink + immediate fact append.
    const store = {
      mutate: async (id: string, fn: (s: any) => any): Promise<void> => {
        const i = rowsList.findIndex(([sid]) => sid === id)
        rowsList[i] = [id, fn(rowsList[i]![1])]
      },
    } as never
    const plan = planRemoval({
      cwd: a, rows,
      targets: [{ sessionId: 'treeA', rootSession: 'treeA', record: state.chapters[0]! }],
    } as never)
    const out = await applyRemoval({
      store, cwd: a, rows, storeDir: path.join(a, '.dsh-chapters'),
      cloneDir: path.join(a, DEFAULT_CLONE_DIR), projectKey: 'KEYLOCAL', harnessId: 'h',
      now: () => '2026-11-19T20:00:00.000Z',
    } as never, plan)
    assert.deepEqual(out.problems, [], out.problems.join('; '))
    const factFile = path.join(a, DEFAULT_CLONE_DIR, 'collections', 'KEYLOCAL', 'treeA.jsonl')
    assert.ok(fs.existsSync(factFile), 'apply wrote the removal fact into the mirror collections channel')
    assert.match(fs.readFileSync(factFile, 'utf8'), /"type":"chapter-removed".*treeA\/chapters\/007-poison\.md/)

    // A's push carries the DELETION and the regenerated fact (one line, deduped).
    const rpush = await syncPublishing(a, pool, rowsList)
    assert.ok(rpush.ok, `${rpush.detail} | ${rpush.steps.join(' → ')}`)
    const poolFiles1 = await git.listFiles({ fs: fs as never, dir: pool, gitdir: pool, ref: 'HEAD' })
    if (!poolFiles1.includes('collections/KEYLOCAL/treeA.jsonl')) throw new Error(`no fact file in the pool: ${poolFiles1.join(', ')}`)
    const poolHead = await git.resolveRef({ fs: fs as never, dir: pool, gitdir: pool, ref: 'HEAD' })
    const factBlob = await git.readBlob({ fs: fs as never, dir: pool, gitdir: pool, oid: poolHead, filepath: 'collections/KEYLOCAL/treeA.jsonl' })
    const factLines = Buffer.from(factBlob.blob).toString('utf8').split('\n').filter((l) => l.includes('chapter-removed'))
    assert.equal(factLines.length, 1, `exactly one fact line ships to the pool, got ${String(factLines.length)}`)

    // B syncs: the deletion + fact arrive, and NOTHING travels back.
    const rb2 = await sync(b, pool)
    assert.ok(rb2.ok, rb2.detail)
    const poolFiles = await git.listFiles({ fs: fs as never, dir: pool, gitdir: pool, ref: 'HEAD' })
    assert.equal(poolFiles.filter((f: string) => f.includes('007-poison')).length, 0,
      `the pool stays free of the deleted chapter after B's pass: ${poolFiles.filter((f: string) => f.includes('poison')).join(',')}`)
    assert.equal(fs.existsSync(path.join(b, DEFAULT_CLONE_DIR, 'chapters', 'KEYLOCAL', 'treeA', '007-poison.md')), false,
      "B's mirror copy went away with the pull")
    assert.ok(fs.existsSync(path.join(b, '.dsh-chapters', 'treeA', 'chapters', '007-poison.md')),
      "B's STORE copy stays untouched — the conservative decision: a remote fact stops bytes travelling, it does not rewrite local state")
    const hits = searchKnowledge(path.join(b, DEFAULT_CLONE_DIR), 'render tool deferral', 500, { projectKey: 'KEYLOCAL' })
    assert.equal(hits.total, 0, 'search on B stops returning the removed chapter within the same sync pass')

    // A third B pass proves the steady state: with the fact in its clone, the stale store copy
    // is skipped and STATED, never committed.
    const rb3 = await sync(b, pool)
    assert.ok(rb3.ok, rb3.detail)
    assert.ok(rb3.steps.some((s: string) => /removal facts:/i.test(s) && /SKIPPED/i.test(s)),
      `B's third pass names the tombstone skip: ${rb3.steps.join(' → ')}`)
    const poolFiles2 = await git.listFiles({ fs: fs as never, dir: pool, gitdir: pool, ref: 'HEAD' })
    assert.equal(poolFiles2.filter((f: string) => f.includes('007-poison')).length, 0, 'and the pool stays clean')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('#256: the fact survives the removing machine\'s own collections regeneration', async () => {
  // publishIntoClone REGENERATES a session's collections file from store state — the facts it
  // already holds must be merged back or the tombstone evaporates on the remover's next pass.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tomb-merge-'))
  const pool = path.join(root, 'pool.git')
  const a = path.join(root, 'machine-a')
  try {
    const sig = JSON.stringify({ seqs: [1, 2], paths: [], commands: [], terms: [], size: 5, by: 'deterministic' })
    writeFile(path.join(a, '.dsh-chapters', 'treeA', 'chapters', '007-poison.md'), chapterText)
    assert.ok((await runSync({
      cwd: a, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: project(a, pool), force: true,
      collections: [{ sessionId: 'sessA', lines: [sig] }],
    })).ok)
    fs.rmSync(path.join(a, '.dsh-chapters', 'treeA', 'chapters', '007-poison.md'))
    const factFile = path.join(a, DEFAULT_CLONE_DIR, 'collections', 'KEYLOCAL', 'sessA.jsonl')
    const fact = JSON.stringify({ type: 'chapter-removed', tail: 'treeA/chapters/007-poison.md', span: [10, 12], by: 'h-a', at: 'x' })
    fs.writeFileSync(factFile, sig + '\n' + fact + '\n')
    const r = await runSync({
      cwd: a, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: project(a, pool), force: true,
      collections: [{ sessionId: 'sessA', lines: [sig] }],
    })
    assert.ok(r.ok, r.detail)
    const after = fs.readFileSync(factFile, 'utf8')
    assert.ok(after.includes('chapter-removed'), 'the regeneration merged the fact back — append-only survives the writer')
    assert.ok(after.includes('"seqs":[1,2]'), 'and the signatures still ride beside it')
    const poolFiles = await git.listFiles({ fs: fs as never, dir: pool, gitdir: pool, ref: 'HEAD' })
    assert.ok(poolFiles.includes(path.posix.join('collections', 'KEYLOCAL', 'sessA.jsonl')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
