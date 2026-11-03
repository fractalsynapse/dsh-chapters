/**
 * `/chapters-remove` operator surface (#255): the verb taxonomy on a real temp store tree —
 * list shows what a child would be seeded with; dry-run writes nothing; apply deletes bytes,
 * leaves the stub, journals, and pushes through the scheduler when a pool is linked; refusals
 * print and touch nothing; report reads the ledger apply wrote; the status line prints in the
 * unlinked state too (#61). The pure mechanics are pinned in tests/unit/removal.test.ts; the
 * mirror-side ones in tests/integration/sync.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { registerHostCommands } from '../../src/commands.ts'
import { appendChapters, freshSession, type SessionState } from '../../src/registry.ts'
import type { ChapterRecord } from '../../src/archive.ts'

type Cmd = { handler: (inv: { agent: unknown; rawInput?: string }) => Promise<{ kind: string; text?: string }> }

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

function harness(opts: { linked?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdrem-'))
  const defs = new Map<string, Cmd>()
  const ctx = {
    logger: { warn: () => undefined, info: () => undefined },
    get: () => ({ register: (d: Cmd & { name: string }) => { defs.set(d.name, d); return () => undefined } }),
  }
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => {
    let m = tables.get(name)
    if (m === undefined) { m = new Map(); tables.set(name, m) }
    return {
      get: (k: string) => m!.get(k),
      put: async (k: string, v: unknown) => { m!.set(k, v) },
      entries: () => m!.entries(),
      size: 0,
    }
  }
  if (opts.linked === true) {
    table('projects').put('PKC', { projectKey: 'PKC', slug: 'kb', remote: 'x', harnessId: 'hC', linkedAt: 'now', cwd: tmp })
    fs.mkdirSync(path.join(tmp, '.dsh-knowledge'), { recursive: true })
  }
  // a store over the SAME table map: mutate is the #59 section, visible to assertions
  const sessions = table('sessions')
  const store = {
    get: async (id: string) => (sessions.get(id) as SessionState | undefined) ?? freshSession(id),
    mutate: async (id: string, fn: (s: SessionState) => SessionState) => {
      const before = (sessions.get(id) as SessionState | undefined) ?? freshSession(id)
      const next = { ...fn(before), rev: (before.rev ?? 0) + 1 }
      sessions.put(id, next)
      return next
    },
  }
  const schedRuns: string[][] = []
  const scheduler = {
    schedule: () => undefined,
    run: async (cwd: string, why: string) => { schedRuns.push([cwd, why]); return { ok: true, steps: [`fake ${why}`], detail: 'ok', mode: 'local-only' as const } },
    pullFor: async () => ({ ok: true, detail: 'x' }),
    hasPending: () => false,
    drain: async () => undefined,
  }
  registerHostCommands(ctx as never, { table } as never, {
    artifactStoreRoot: '.dsh-chapters', harnessId: 'hC',
    store: store as never,
    ...(opts.linked === true ? { scheduler: scheduler as never } : {}),
  })
  const agent = { session: { header: { cwd: tmp }, id: 'A' } }
  const dispose = () => fs.rmSync(tmp, { recursive: true, force: true })
  return { tmp, defs, agent, store, schedRuns, sessions, dispose, table }
}

const writeChapter = (tmp: string, sessionId: string, r: ChapterRecord, body: string): void => {
  const abs = path.join(tmp, r.path)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

test('list prints the flat active index with removable ids and counts stubs without showing them', async () => {
  const h = harness()
  try {
    fs.mkdirSync(path.join(h.tmp, '.dsh-chapters', 'A'), { recursive: true })
    const mk = (number: number, body: string, over: Partial<ChapterRecord> = {}): ChapterRecord => {
      const r = rec('A', number, over)
      r.sha256 = createHash('sha256').update(body).digest('hex')
      writeChapter(h.tmp, 'A', r, body)
      return r
    }
    const a1 = mk(1, 'one')
    const a2 = rec('A', 2, { status: 'removed' }) // its bytes are gone — that is the state under test
    const a3 = mk(3, 'three')
    h.sessions.put('A', appendChapters(freshSession('A'), [a1, a2, a3]))
    const res = await h.defs.get('chapters-remove')!.handler({ agent: h.agent, rawInput: 'list' })
    const t = res.text ?? ''
    assert.match(t, /2 active chapter\(s\)/)
    assert.match(t, /A:1 · ok/)
    assert.match(t, /A:3 · ok/)
    assert.doesNotMatch(t, /A:2/)
    assert.match(t, /\+1 removed stub/)
  } finally { h.dispose() }
})

test('dry-run names the exact set and writes nothing; apply deletes, stubs, journals, and syncs through the scheduler', async () => {
  const h = harness({ linked: true })
  try {
    const shared = '.dsh-chapters/artifacts/ab/shared.txt'
    const owned = '.dsh-chapters/artifacts/cd/owned.txt'
    for (const p of [shared, owned]) fs.mkdirSync(path.dirname(path.join(h.tmp, p)), { recursive: true })
    fs.writeFileSync(path.join(h.tmp, shared), 'S'); fs.writeFileSync(path.join(h.tmp, owned), 'O')
    const keeper = rec('A', 1, { artifacts: [{ path: shared, sha256: 's'.repeat(64), bytes: 1 }] })
    const doomed = rec('A', 2, { artifacts: [{ path: owned, sha256: 'o'.repeat(64), bytes: 1 }, { path: shared, sha256: 's'.repeat(64), bytes: 1 }] })
    writeChapter(h.tmp, 'A', keeper, 'keeper body citing 002-x.md')
    writeChapter(h.tmp, 'A', doomed, 'doomed')
    fs.mkdirSync(path.join(h.tmp, '.dsh-knowledge', 'chapters', 'PKC', 'A'), { recursive: true })
    fs.writeFileSync(path.join(h.tmp, '.dsh-knowledge', 'chapters', 'PKC', 'A', '002-x.md'), 'doomed mirrored')
    h.sessions.put('A', appendChapters(freshSession('A'), [keeper, doomed]))
    const remove = h.defs.get('chapters-remove')!

    const dry = await remove.handler({ agent: h.agent, rawInput: 'A:2' })
    assert.match(dry.text ?? '', /dry-run — 1 chapter\(s\)/)
    assert.match(dry.text ?? '', /NOTHING WRITTEN/)
    assert.match(dry.text ?? '', /dangling after removal \(1\)/, 'the keeper body cites 002-x.md — the referrer list fired')
    assert.equal(fs.existsSync(path.join(h.tmp, doomed.path)), true, 'dry-run deleted nothing')

    const bad = await remove.handler({ agent: h.agent, rawInput: 'apply A:99' })
    assert.equal(bad.kind, 'error')
    assert.match(bad.text ?? '', /NOTHING WRITTEN/)

    const applied = await remove.handler({ agent: h.agent, rawInput: 'apply A:2' })
    assert.match(applied.text ?? '', /journal: \S+ — reversal/)
    assert.match(applied.text ?? '', /sync: fake removal/)
    assert.equal(fs.existsSync(path.join(h.tmp, doomed.path)), false, 'chapter bytes gone')
    assert.equal(fs.existsSync(path.join(h.tmp, owned)), false, 'orphan blob gone')
    assert.equal(fs.existsSync(path.join(h.tmp, shared)), true, 'SHARED blob survives')
    assert.equal(fs.existsSync(path.join(h.tmp, '.dsh-knowledge', 'chapters', 'PKC', 'A', '002-x.md')), false, 'mirror copy gone for the commit')
    const row = h.sessions.get('A') as SessionState
    assert.equal(row.chapters.find((c) => c.number === 2)!.status, 'removed')
    assert.equal(row.chapters.find((c) => c.number === 2)!.endSeq, 25, 'span survives on the stub')
    assert.equal(h.schedRuns.length, 1, 'scheduler carried the push, not a second sync engine')

    const again = await remove.handler({ agent: h.agent, rawInput: `apply ${doomed.path}` })
    assert.equal(again.kind, 'error')
    assert.match(again.text ?? '', /already removed/)
  } finally { h.dispose() }
})

test('report reads the ledger apply wrote; foreign-tree ids refuse; unknown verbs refuse', async () => {
  const h = harness()
  try {
    const a = rec('A', 1)
    writeChapter(h.tmp, 'A', a, 'body')
    h.sessions.put('A', appendChapters(freshSession('A'), [a]))
    // a row of ANOTHER project: same dialect, tree does not exist under this store
    h.sessions.put('Z', appendChapters(freshSession('Z'), [rec('Z', 1)]))
    const remove = h.defs.get('chapters-remove')!
    const foreign = await remove.handler({ agent: h.agent, rawInput: 'apply Z:1' })
    assert.equal(foreign.kind, 'error')
    assert.match(foreign.text ?? '', /NOTHING WRITTEN/, 'a session whose tree is not in THIS store does not resolve')

    await remove.handler({ agent: h.agent, rawInput: 'apply A:1' })
    const rep = await remove.handler({ agent: h.agent, rawInput: 'report' })
    assert.match(rep.text ?? '', /missing-access/, 'report speaks the ledger')
    assert.match(rep.text ?? '', /removed=|dead-citation|no removal/, 'and answers with lines or an explicit empty state')

    const bogus = await remove.handler({ agent: h.agent, rawInput: 'frobnicate A:1' })
    assert.equal(bogus.kind, 'error')
    assert.match(bogus.text ?? '', /unknown verb/)
  } finally { h.dispose() }
})

test('/chapters-status prints the removals line in the UNLINKED, zero-chapter state (#61)', async () => {
  const h = harness()
  try {
    fs.mkdirSync(path.join(h.tmp, '.dsh-chapters', 'A'), { recursive: true })
    const r = await h.defs.get('chapters-status')!.handler({ agent: h.agent })
    assert.equal(r.kind, 'success')
    assert.match(r.text ?? '', /Removals \(this project\): 0 removed stub\(s\); missing-access ledger: empty/)
  } finally { h.dispose() }
})
