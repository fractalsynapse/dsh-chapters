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
import { saveSession } from '../../src/save-core.ts'

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

function harness(opts: { linked?: boolean; cap?: number; durableEvents?: unknown[] | null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdrem-'))
  const defs = new Map<string, Cmd>()
  const ctx = {
    logger: { warn: () => undefined, info: () => undefined },
    get: (name: string) => name === 'sessionQuery'
      ? { readSession: async (id: string) => ({ session: { id, cwd: tmp }, events: opts.durableEvents ?? null }) }
      : { register: (d: Cmd & { name: string }) => { defs.set(d.name, d); return () => undefined } },
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
    ...(opts.cap !== undefined ? { reportMaxLines: opts.cap } : {}),
    ...(opts.linked === true ? { scheduler: scheduler as never, save: SAVE_CONFIG } : {}),
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

test('every refusal arm speaks a remedy: usage, no-args find, bare apply, foreign list, missing ids', async () => {
  const h = harness({ linked: true })
  try {
    fs.mkdirSync(path.join(h.tmp, '.dsh-chapters', 'A'), { recursive: true })
    const remove = h.defs.get('chapters-remove')!
    assert.match((await remove.handler({ agent: h.agent, rawInput: 'apply' })).text ?? '', /usage: \/chapters-remove/)
    assert.match((await remove.handler({ agent: h.agent, rawInput: 'find' })).text ?? '', /needs a query/)
    assert.match((await remove.handler({ agent: h.agent, rawInput: 'report' })).text ?? '', /ledger is empty/, 'empty state is ANSWERED')
    assert.match((await remove.handler({ agent: h.agent, rawInput: 'list ZZZ' })).text ?? '', /no row under this project/, 'foreign session list refuses with the store path')
    assert.match((await remove.handler({ agent: h.agent, rawInput: 'restore' })).text ?? '', /needs a journal id/)
    const a1 = rec('A', 1)
    writeChapter(h.tmp, 'A', a1, 'body')
    h.sessions.put('A', appendChapters(freshSession('A'), [a1]))
    assert.match((await remove.handler({ agent: h.agent, rawInput: 'list' })).text ?? '', /1 active chapter/, 'list works on the linked harness once a row exists')
  } finally { h.dispose() }
})

test('find answers from the local store when unlinked and maps a chapter hit to a removable id', async () => {
  const h = harness()
  try {
    const chDir = path.join(h.tmp, '.dsh-chapters', 'A', 'chapters')
    fs.mkdirSync(chDir, { recursive: true })
    fs.writeFileSync(path.join(chDir, '001-jwt-work.md'), '---\ntitle: "jwt refresh work"\ntopics: ["jwt-auth"]\n---\n# jwt refresh work\n\nbody about jwt\n')
    h.sessions.put('A', appendChapters(freshSession('A'), [{
      number: 1, path: '.dsh-chapters/A/chapters/001-jwt-work.md', title: 'jwt refresh work', summary: 's',
      startSeq: 0, endSeq: 5, topics: ['jwt-auth'], sha256: 'a'.repeat(64), estimatedTokens: 10, artifacts: [],
    }]))
    const r = await h.defs.get('chapters-remove')!.handler({ agent: h.agent, rawInput: 'find jwt' })
    const t = r.text ?? ''
    assert.match(t, /LOCAL store/, 'unlinked project searches the local store')
    assert.match(t, /removable id A:1/, 'a chapter hit maps to a removable id')
  } finally { h.dispose() }
})

test('report caps its tail and names the withheld lines; the cap is config, not a constant', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdrem-cap-'))
  try {
    const removals = path.join(tmp, '.dsh-chapters', 'removals')
    fs.mkdirSync(removals, { recursive: true })
    fs.writeFileSync(path.join(removals, 'missing-access.log'), [1, 2, 3, 4].map((n) => `line ${n}`).join('\n') + '\n')
    const defs = new Map<string, Cmd>()
    const ctx = { logger: { warn: () => undefined, info: () => undefined }, get: () => ({ register: (d: Cmd & { name: string }) => { defs.set(d.name, d); return () => undefined } }) }
    const tables = new Map<string, Map<string, unknown>>()
    const table = (name: string) => { let m = tables.get(name); if (m === undefined) { m = new Map(); tables.set(name, m) } return { get: (k: string) => m!.get(k), put: async (k: string, v: unknown) => { m!.set(k, v) }, entries: () => m!.entries(), size: 0 } }
    registerHostCommands(ctx as never, { table } as never, { artifactStoreRoot: '.dsh-chapters', harnessId: 'h', reportMaxLines: 2 })
    const r = await defs.get('chapters-remove')!.handler({ agent: { session: { header: { cwd: tmp }, id: 'A' } }, rawInput: 'report' })
    assert.match(r.text ?? '', /last 2/, 'tail respects the cap row')
    assert.match(r.text ?? '', /2 earlier line\(s\) withheld/, 'withheld is NAMED (#117)')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('a scheduler that throws during apply-sync is REPORTED and the local removal stands complete', async () => {
  const h = harness({ linked: true })
  try {
    const a = rec('A', 1)
    writeChapter(h.tmp, 'A', a, 'body')
    h.sessions.put('A', appendChapters(freshSession('A'), [a]))
    // make the fake scheduler throw: replace run
    const broken = { schedule: () => undefined, run: async () => { throw new Error('scheduler offline') }, pullFor: async () => ({ ok: true, detail: '' }), hasPending: () => false, drain: async () => undefined }
    // rebuild registrations with the broken scheduler
    const defs = new Map<string, Cmd>()
    const ctx = { logger: { warn: () => undefined, info: () => undefined }, get: () => ({ register: (d: Cmd & { name: string }) => { defs.set(d.name, d); return () => undefined } }) }
    const tables = new Map<string, Map<string, unknown>>()
    const sessions = new Map<string, unknown>()
    const table = (name: string) => {
      let m = tables.get(name)
      if (m === undefined) { m = name === 'sessions' ? new Map(sessions) : new Map(); tables.set(name, m) }
      return { get: (k: string) => m!.get(k), put: async (k: string, v: unknown) => { m!.set(k, v) }, entries: () => m!.entries(), size: 0 }
    }
    table('projects').put('PKC', { projectKey: 'PKC', slug: 'kb', remote: 'x', harnessId: 'hC', linkedAt: 'now', cwd: h.tmp })
    for (const [k, v] of h.sessions.entries() as Iterable<[string, unknown]>) sessions.set(k, v)
    const store = {
      get: async (id: string) => (sessions.get(id) as SessionState | undefined) ?? freshSession(id),
      mutate: async (id: string, fn: (s: SessionState) => SessionState) => {
        const before = (sessions.get(id) as SessionState | undefined) ?? freshSession(id)
        const next = { ...fn(before), rev: (before.rev ?? 0) + 1 }
        sessions.set(id, next)
        return next
      },
    }
    registerHostCommands(ctx as never, { table } as never, { artifactStoreRoot: '.dsh-chapters', harnessId: 'hC', store: store as never, scheduler: broken as never })
    const r = await defs.get('chapters-remove')!.handler({ agent: { session: { header: { cwd: h.tmp }, id: 'A' } }, rawInput: 'apply A:1' })
    assert.match(r.text ?? '', /sync: pass threw \(scheduler offline\)/, 'the throw is narrated, not fatal')
    assert.equal(fs.existsSync(path.join(h.tmp, a.path)), false, 'local removal stands')
  } finally { h.dispose() }
})

test('planes without a store handle or a cwd refuse cleanly, nothing guessed', async () => {
  const defs = new Map<string, Cmd>()
  const ctx = { logger: { warn: () => undefined, info: () => undefined }, get: () => ({ register: (d: Cmd & { name: string }) => { defs.set(d.name, d); return () => undefined } }) }
  const table = () => ({ get: () => undefined, put: async () => undefined, entries: () => new Map<string, unknown>().entries(), size: 0 })
  registerHostCommands(ctx as never, { table } as never, { artifactStoreRoot: '.dsh-chapters', harnessId: 'h' })
  // READS need no store handle: an empty registry answers honestly rather than refusing on plumbing.
  const probe = { session: { header: { cwd: '/tmp/whatever-removal-probe' }, id: 'A' } }
  const r = await defs.get('chapters-remove')!.handler({ agent: probe, rawInput: 'list' })
  assert.match(r.text ?? '', /no row under this project/, 'list: the empty registry is STATED, not gate-refused')
  const rep = await defs.get('chapters-remove')!.handler({ agent: probe, rawInput: 'report' })
  assert.equal(rep.kind, 'success', 'report works without a store handle')
  const app = await defs.get('chapters-remove')!.handler({ agent: probe, rawInput: 'restore 2026-11-02T00-00-00-000Z' })
  assert.match(app.text ?? '', /no registry handle/, 'the MUTATING arms are the ones that refuse')
})

// ---------------------------------------------------------------- restore through the command

const turn = (t: number, base: number, subject: string) => [
  { type: 'turn/start', seq: base, data: { turn: t } },
  { type: 'user/message', seq: base + 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `please ${subject}` }] } },
  { type: 'assistant/message', seq: base + 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: `I will now ${subject}, and this reply is long enough to render real chapter bytes for the archive.` }] } } },
  { type: 'turn/end', seq: base + 3, data: { turn: t, reason: { kind: 'completed' } } },
]
const EV = [...turn(1, 0, 'alpha'), ...turn(2, 4, 'beta'), ...turn(3, 8, 'gamma')]
const SAVE_CONFIG = {
  artifactStoreRoot: '.dsh-chapters',
  chapterTokenTarget: 8000,
  chapterOversizeFactor: 2,
  toolResultDeferFloorTokens: 200,
  mergeThreshold: 0.3,
  chapterLimit: 8000,
} as const

test('restore through the command: apply ⇒ journal id ⇒ restore re-derives, prints new numbers, and pushes via the scheduler', async () => {
  const h = harness({ linked: true, durableEvents: EV })
  try {
    const saved = await saveSession({ events: EV as never, sessionId: 'A', cwd: h.tmp, store: h.store, config: SAVE_CONFIG, span: { fromSeq: 4, toSeq: 7 }, attemptSalt: 'seed' })
    assert.equal(saved.records.length, 1)
    const num = saved.records[0]!.number
    const applied = await h.defs.get('chapters-remove')!.handler({ agent: h.agent, rawInput: `apply A:${num}` })
    assert.equal(applied.kind, 'success', applied.text)
    const m = /journal: (\S+) —/.exec(applied.text ?? '')
    assert.ok(m !== null, `journal id printed by apply: ${applied.text}`)
    const restored = await h.defs.get('chapters-remove')!.handler({ agent: h.agent, rawInput: `restore ${m![1]}` })
    assert.match(restored.text ?? '', /re-derived under new numbers/)
    assert.match(restored.text ?? '', /sync: fake removal-restore/, 'the restored bytes push through the scheduler')
    assert.ok(h.schedRuns.some(([, why]) => why === 'removal-restore'))
    const st = h.sessions.get('A') as SessionState
    assert.equal(st.chapters.filter((c) => c.status === undefined).length, 1, 'one live chapter again')
    assert.equal(st.chapters.find((c) => c.number === num)!.status, 'superseded', 'the spent number stays marked')
  } finally { h.dispose() }
})

test('restore refuses cleanly when the durable log cannot be read — the ledger says UNRECOVERABLE', async () => {
  const h = harness({ linked: true, durableEvents: null })
  try {
    const saved = await saveSession({ events: EV as never, sessionId: 'A', cwd: h.tmp, store: h.store, config: SAVE_CONFIG, span: { fromSeq: 4, toSeq: 7 }, attemptSalt: 'seed' })
    const num = saved.records[0]!.number
    const applied = await h.defs.get('chapters-remove')!.handler({ agent: h.agent, rawInput: `apply A:${num}` })
    const m = /journal: (\S+) —/.exec(applied.text ?? '')
    const restored = await h.defs.get('chapters-remove')!.handler({ agent: h.agent, rawInput: `restore ${m![1]}` })
    assert.equal(restored.kind, 'error', 'a restore that derived nothing is an error, not a success theater')
    assert.match(restored.text ?? '', /UNRECOVERABLE/)
  } finally { h.dispose() }
})

test('find with a tight cap names the withheld hits; a failing pool push is narrated as local-complete', async () => {
  const h = harness({ cap: 1 })
  try {
    for (const n of [1, 2]) {
      const r = rec('A', n, { path: `.dsh-chapters/A/chapters/00${n}-jwt-${n}.md` })
      writeChapter(h.tmp, 'A', r, 'jwt jwt')
      h.sessions.put('A', appendChapters((h.sessions.get('A') as SessionState | undefined) ?? freshSession('A'), [r]))
    }
    const found = await h.defs.get('chapters-remove')!.handler({ agent: h.agent, rawInput: 'find jwt' })
    assert.match(found.text ?? '', /withheld by the report cap \(1\)/, 'withheld count is NAMED (#117)')
  } finally { h.dispose() }
})

test('linked find searches the POOL mirror, maps hits to ids, and an empty ancestor path is ANSWERED not blank', async () => {
  const h = harness({ linked: true })
  try {
    fs.mkdirSync(path.join(h.tmp, '.dsh-knowledge', 'chapters', 'PKC', 'A'), { recursive: true })
    fs.writeFileSync(path.join(h.tmp, '.dsh-knowledge', 'chapters', 'PKC', 'A', '001-x.md'), '---\ntitle: "jwt work"\ntopics: ["jwt"]\n---\nbody\n')
    const r = rec('A', 1, { path: '.dsh-chapters/A/chapters/001-x.md' })
    writeChapter(h.tmp, 'A', r, 'body')
    h.sessions.put('A', appendChapters(freshSession('A'), [r]))
    const found = await h.defs.get('chapters-remove')!.handler({ agent: h.agent, rawInput: 'find jwt' })
    assert.match(found.text ?? '', /pool mirror/, 'the linked corpus is the one searched')
    assert.match(found.text ?? '', /removable id A:1/, 'mirror path resolves through the pool dialect')
    // empty ancestor path on a row that EXISTS but has no chapters:
    h.sessions.put('E', freshSession('E'))
    fs.mkdirSync(path.join(h.tmp, '.dsh-chapters', 'E'), { recursive: true })
    const empty = await h.defs.get('chapters-remove')!.handler({ agent: { session: { header: { cwd: h.tmp }, id: 'E' } }, rawInput: 'list' })
    assert.match(empty.text ?? '', /no ACTIVE chapters/, 'an empty TOC is an answer, not an error')
  } finally { h.dispose() }
})

test('apply whose journal cannot be written prints NOT WRITTEN and stubbed NONE — and restore without a render config refuses by name', async () => {
  const h = harness()
  try {
    const a = rec('A', 1)
    writeChapter(h.tmp, 'A', a, 'body')
    h.sessions.put('A', appendChapters(freshSession('A'), [a]))
    fs.mkdirSync(path.join(h.tmp, '.dsh-chapters', 'A'), { recursive: true })
    fs.writeFileSync(path.join(h.tmp, '.dsh-chapters', 'A', 'removals'), 'blocker') // journal dir blocked
    const applied = await h.defs.get('chapters-remove')!.handler({ agent: h.agent, rawInput: 'apply A:1' })
    assert.match(applied.text ?? '', /journal: NOT WRITTEN/)
    assert.match(applied.text ?? '', /stubbed NONE/, 'nothing flipped when the journal refused')
    assert.equal(fs.existsSync(path.join(h.tmp, a.path)), true, 'zero deletions — the guard held')
    const rest = await h.defs.get('chapters-remove')!.handler({ agent: h.agent, rawInput: 'restore some-journal' })
    assert.match(rest.text ?? '', /no render config/, 'restore names the missing seam, not a guess')
  } finally { h.dispose() }
})
