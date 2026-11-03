/**
 * `/chapters-remove restore` (#255): reversal is RE-DERIVATION. A removed chapter's span is
 * re-rendered from the session's durable log through the SAME save core every door calls, under a
 * NEW number, byte-identical to the bytes the journal recorded leaving. Never a resurrection of
 * files, never a reused number, never a committed husk, and an unreadable log is UNRECOVERABLE —
 * said plainly, not guessed at.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendChapters, freshSession, type SessionState } from '../../src/registry.ts'
import type { SaveSessionConfig } from '../../src/save-core.ts'
import { saveSession } from '../../src/save-core.ts'
import { applyRemoval, planRemoval, restoreRemoval, type RemovalTarget } from '../../src/removal.ts'
import type { SessionEventLike } from '../../src/types.ts'

const CONFIG: SaveSessionConfig = {
  artifactStoreRoot: '.dsh-chapters',
  chapterTokenTarget: 8000,
  chapterOversizeFactor: 2,
  toolResultDeferFloorTokens: 200,
  mergeThreshold: 0.3,
  chapterLimit: 8000,
}

const turn = (t: number, base: number, subject: string): SessionEventLike[] => [
  { type: 'turn/start', seq: base, data: { turn: t } },
  { type: 'user/message', seq: base + 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `please ${subject}` }] } },
  { type: 'assistant/message', seq: base + 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: `I will now ${subject}, touching ${subject}.ts and writing the result carefully.` }] } } },
  { type: 'turn/end', seq: base + 3, data: { turn: t, reason: { kind: 'completed' } } },
]

const EVENTS: SessionEventLike[] = [...turn(1, 0, 'alpha'), ...turn(2, 4, 'beta'), ...turn(3, 8, 'gamma')]

function world() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'remrest-'))
  const states = new Map<string, SessionState>()
  const gates = new Map<string, Promise<unknown>>()
  const section = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = gates.get(id) ?? Promise.resolve()
    const job = prev.then(fn, fn)
    gates.set(id, job.then(() => undefined, () => undefined))
    return job
  }
  const store = {
    get: async (id: string) => states.get(id) ?? freshSession(id),
    put: async (id: string, state: SessionState) => { await section(id, async () => { states.set(id, state); return state }) },
    mutate: async (id: string, fn: (s: SessionState) => SessionState) => section(id, async () => {
      const before = states.get(id) ?? freshSession(id)
      const next = { ...fn(structuredClone(before)), rev: (before.rev ?? 0) + 1 }
      states.set(id, next)
      return next
    }),
    sessions: () => states.entries(),
  }
  return { cwd, states, store: store as never, dispose: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

test('remove then restore: the re-derived chapter is byte-identical to the journal, under a NEW number; the stub stays spent', async () => {
  const w = world()
  try {
    // 1) an ordinary archive of turn 2 (seqs 4..7)
    const saved = await saveSession({
      events: EVENTS, sessionId: 'root-1', cwd: w.cwd, store: w.store, config: CONFIG,
      span: { fromSeq: 4, toSeq: 7 }, attemptSalt: 't2',
    })
    assert.equal(saved.records.length, 1, 'one chapter archived')
    const rec = saved.records[0]!
    // 2) the operator removes it
    const rows: [string, SessionState][] = [['root-1', await w.store.get('root-1')]]
    const target: RemovalTarget = { sessionId: 'root-1', rootSession: 'root-1', record: rec }
    const plan = planRemoval({ targets: [target], rows, cwd: w.cwd })
    const applied = await applyRemoval({
      store: w.store, cwd: w.cwd, rows, storeDir: path.join(w.cwd, '.dsh-chapters'),
      now: () => '2026-11-02T20:00:00.000Z',
    }, plan)
    assert.equal(applied.problems.length, 0, applied.problems.join('; '))
    assert.equal(fs.existsSync(path.join(w.cwd, rec.path)), false, 'bytes gone')
    // 3) the operator changed their mind: restore RE-DERIVES
    const out = await restoreRemoval({
      store: w.store, cwd: w.cwd, storeDir: path.join(w.cwd, '.dsh-chapters'),
      readLog: async () => EVENTS, config: CONFIG, now: () => '2026-11-02T20:05:00.000Z',
    }, applied.journalId)
    assert.deepEqual(out.problems, [], out.problems.join('; '))
    assert.equal(out.restored.length, 1, out.restored.join('; '))
    const st = await w.store.get('root-1')
    const stub = st.chapters.find((c) => c.number === rec.number)!
    assert.equal(stub.status, 'superseded', 'the removed stub is marked superseded by the re-derivation')
    assert.equal(stub.supersededBy !== undefined, true, 'the spent number points at what replaced it')
    const freshRec = st.chapters.find((c) => c.number !== rec.number && c.status === undefined)
    assert.ok(freshRec !== undefined, 'a NEW record exists')
    assert.ok((freshRec!.repairs ?? []).some((r) => r.class === 'operator-restore' && r.over === rec.number), 'the restore move is classed on the new record, not faked as repair')
    assert.ok(freshRec!.number > rec.number, `new number ${freshRec!.number} > spent ${rec.number}`)
    assert.equal(freshRec!.sha256, rec.sha256, 're-rendered bytes hash-identical to the removed chapter')
    assert.doesNotMatch(freshRec!.path, /removed/, 'the restored file lives at a normal chapter path')
  } finally { w.dispose() }
})

test('restore of an UNREADABLE log is unrecoverable and named — never a guess', async () => {
  const w = world()
  try {
    const saved = await saveSession({ events: EVENTS, sessionId: 'root-1', cwd: w.cwd, store: w.store, config: CONFIG, span: { fromSeq: 4, toSeq: 7 }, attemptSalt: 't2' })
    const rec = saved.records[0]!
    const rows: [string, SessionState][] = [['root-1', await w.store.get('root-1')]]
    const applied = await applyRemoval({
      store: w.store, cwd: w.cwd, rows, storeDir: path.join(w.cwd, '.dsh-chapters'), now: () => '2026-11-02T20:00:00.000Z',
    }, planRemoval({ targets: [{ sessionId: 'root-1', rootSession: 'root-1', record: rec }], rows, cwd: w.cwd }))
    const out = await restoreRemoval({
      store: w.store, cwd: w.cwd, storeDir: path.join(w.cwd, '.dsh-chapters'),
      readLog: async () => null, config: CONFIG, now: () => '2026-11-02T20:05:00.000Z',
    }, applied.journalId)
    assert.equal(out.restored.length, 0)
    assert.match(out.problems.join(' '), /UNRECOVERABLE/)
    const st = await w.store.get('root-1')
    assert.equal(st.chapters.find((c) => c.number === rec.number)!.status, 'removed', 'the stub stands untouched')
  } finally { w.dispose() }
})

test('restore is idempotent: a second run finds the stub superseded and re-renders nothing', async () => {
  const w = world()
  try {
    const saved = await saveSession({ events: EVENTS, sessionId: 'root-1', cwd: w.cwd, store: w.store, config: CONFIG, span: { fromSeq: 4, toSeq: 7 }, attemptSalt: 't2' })
    const rec = saved.records[0]!
    const rows: [string, SessionState][] = [['root-1', await w.store.get('root-1')]]
    const applied = await applyRemoval({
      store: w.store, cwd: w.cwd, rows, storeDir: path.join(w.cwd, '.dsh-chapters'), now: () => '2026-11-02T20:00:00.000Z',
    }, planRemoval({ targets: [{ sessionId: 'root-1', rootSession: 'root-1', record: rec }], rows, cwd: w.cwd }))
    const ports = {
      store: w.store, cwd: w.cwd, storeDir: path.join(w.cwd, '.dsh-chapters'),
      readLog: async () => EVENTS, config: CONFIG, now: () => '2026-11-02T20:05:00.000Z',
    }
    const first = await restoreRemoval(ports, applied.journalId)
    assert.equal(first.restored.length, 1)
    const second = await restoreRemoval(ports, applied.journalId)
    assert.equal(second.restored.length, 0)
    assert.match(second.skipped.join(' ') + second.problems.join(' '), /superseded|already|spent/)
    const st = await w.store.get('root-1')
    assert.equal(st.chapters.length, 2, 'still exactly two records: the spent stub and the restored chapter')
  } finally { w.dispose() }
})

test('restore of a span that renders nothing refuses: never commit an empty archive', async () => {
  const w = world()
  try {
    const saved = await saveSession({ events: EVENTS, sessionId: 'root-1', cwd: w.cwd, store: w.store, config: CONFIG, span: { fromSeq: 4, toSeq: 7 }, attemptSalt: 't2' })
    const rec = saved.records[0]!
    const rows: [string, SessionState][] = [['root-1', await w.store.get('root-1')]]
    const applied = await applyRemoval({
      store: w.store, cwd: w.cwd, rows, storeDir: path.join(w.cwd, '.dsh-chapters'), now: () => '2026-11-02T20:00:00.000Z',
    }, planRemoval({ targets: [{ sessionId: 'root-1', rootSession: 'root-1', record: rec }], rows, cwd: w.cwd }))
    // a log that lost the span's messages: payload-bearing events, but the range has no completed turn
    const out = await restoreRemoval({
      store: w.store, cwd: w.cwd, storeDir: path.join(w.cwd, '.dsh-chapters'),
      readLog: async () => turn(2, 4, 'beta').slice(0, 2), config: CONFIG, now: () => '2026-11-02T20:05:00.000Z',
    }, applied.journalId)
    assert.equal(out.restored.length, 0)
    assert.match(out.problems.join(' '), /already archived|rendered nothing|no-completed-turn/, 'refusal names why')
    const st = await w.store.get('root-1')
    assert.equal(st.chapters.find((c) => c.number === rec.number)!.status, 'removed', 'the stub stays; the ledger stays honest')
  } finally { w.dispose() }
})

test('unknown journal id refuses with the searched path; restore lands in the missing-access ledger', async () => {
  const w = world()
  try {
    const storeDir = path.join(w.cwd, '.dsh-chapters')
    const out = await restoreRemoval({
      store: w.store, cwd: w.cwd, storeDir, readLog: async () => EVENTS, config: CONFIG, now: () => '2026-11-02T20:05:00.000Z',
    }, '2026-11-02T00-00-00-000Z')
    assert.match(out.problems.join(' '), /no journal/)
    const saved = await saveSession({ events: EVENTS, sessionId: 'root-1', cwd: w.cwd, store: w.store, config: CONFIG, span: { fromSeq: 4, toSeq: 7 }, attemptSalt: 't2' })
    const rec = saved.records[0]!
    const rows: [string, SessionState][] = [['root-1', await w.store.get('root-1')]]
    const applied = await applyRemoval({ store: w.store, cwd: w.cwd, rows, storeDir, now: () => '2026-11-02T20:00:00.000Z' },
      planRemoval({ targets: [{ sessionId: 'root-1', rootSession: 'root-1', record: rec }], rows, cwd: w.cwd }))
    await restoreRemoval({ store: w.store, cwd: w.cwd, storeDir, readLog: async () => EVENTS, config: CONFIG, now: () => '2026-11-02T20:05:00.000Z' }, applied.journalId)
    const log = fs.readFileSync(path.join(storeDir, 'removals', 'missing-access.log'), 'utf8')
    assert.match(log, /restored \| root-1:1/)
  } finally { w.dispose() }
})
