/**
 * Applying a repair, end to end (#60).
 *
 * This is the acceptance test for the whole issue: a store damaged the way the field data was damaged —
 * one hollow chapter (0 messages, watermark poisoned), one completed turn no chapter covers — run through
 * `runRepair`, which must re-derive both from the log through the normal save core, supersede the husk,
 * journal every move, and report ZERO actionable findings on a second run (idempotence: a repair that
 * re-finds its own work is a repair that never converges).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { runRepair, restoreRepair } from '../../src/repair-run.ts'
import { appendChapters, freshSession, type ChapterRecord, type SessionState } from '../../src/registry.ts'
import type { SaveSessionConfig } from '../../src/save-core.ts'
import type { SessionEventLike } from '../../src/types.ts'

const CONFIG: SaveSessionConfig = {
  artifactStoreRoot: '.dsh-chapters',
  chapterTokenTarget: 8000,
  chapterOversizeFactor: 2,
  toolResultDeferFloorTokens: 200,
  mergeThreshold: 0.3,
  chapterLimit: 8000,
}

/** A registry double with the REAL section semantics (#59) — the repair depends on them. */
function makeStore(states: Map<string, SessionState>) {
  const gates = new Map<string, Promise<unknown>>()
  const section = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = gates.get(id) ?? Promise.resolve()
    const job = prev.then(fn, fn)
    gates.set(id, job.then(() => undefined, () => undefined))
    return job
  }
  return {
    async get(id: string) { return states.get(id) ?? freshSession(id) },
    async put(id: string, state: SessionState) { await section(id, async () => { states.set(id, state); return state }) },
    async mutate(id: string, fn: (state: SessionState) => SessionState) {
      return section(id, async () => {
        const before = states.get(id) ?? freshSession(id)
        const next = { ...fn(structuredClone(before)), rev: (before.rev ?? 0) + 1 }
        states.set(id, next)
        return next
      })
    },
    sessions: () => states.entries(),
  }
}

const turn = (t: number, base: number, subject: string): SessionEventLike[] => [
  { type: 'turn/start', seq: base, data: { turn: t } },
  { type: 'user/message', seq: base + 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `please ${subject}` }] } },
  { type: 'assistant/message', seq: base + 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: `I will now ${subject}, touching ${subject}.ts and writing the result carefully.` }] } } },
  { type: 'turn/end', seq: base + 3, data: { turn: t, reason: { kind: 'completed' } } },
]

function world() {
  const cwd = fs.mkdtempSync(path.join('/tmp', 'repair-apply-'))
  const events = [...turn(1, 0, 'alpha'), ...turn(2, 4, 'beta'), ...turn(3, 8, 'gamma')]
  const rec = (n: number, from: number, to: number, over: Partial<ChapterRecord> = {}): ChapterRecord => ({
    number: n, path: `.dsh-chapters/root-1/chapters/${String(n).padStart(3, '0')}-ch-${n}.md`,
    title: `Ch ${n}`, summary: 's', startSeq: from, endSeq: to, topics: ['x'],
    messages: 2, sha256: '0'.repeat(64), estimatedTokens: 100, artifacts: [], ...over,
  })
  // chapter 1 real; chapter 2 HOLLOW (messages 0) covering turn 2; turn 3 never archived at all.
  const hollow = rec(2, 4, 7, { messages: 0, artifacts: [{ path: '.dsh-chapters/root-1/artifacts/e3/e3b0.txt', sha256: 'e3b0'.padEnd(64, '0'), bytes: 0 }] })
  const real = rec(1, 0, 3)
  const state = { ...freshSession('root-1'), rootSession: 'root-1', nextChapterNumber: 3, chapters: [real, hollow] }
  const states = new Map<string, SessionState>([['root-1', state]])
  // the files, as the original doors would have left them
  const tree = path.join(cwd, '.dsh-chapters', 'root-1', 'chapters')
  fs.mkdirSync(tree, { recursive: true })
  fs.writeFileSync(path.join(tree, '001-ch-1.md'), `---\nnumber: 1\n---\n\n# Ch 1\n\n${turn(1, 0, 'alpha').map(() => 'body line').join('\n')}\n`)
  fs.writeFileSync(path.join(tree, '002-ch-2.md'), '---\nnumber: 2\n---\n\n**Assistant:** \n  ↳ tool: unknown `arguments: {}`\n')
  return { cwd, events, states, hollow, real }
}

test('runRepair re-derives a hollow chapter and a missed span, then converges (#60)', async () => {
  const w = world()
  const store = makeStore(w.states)
  const lines: string[] = []
  const ports = {
    store: store as never,
    readLog: async () => w.events,
    cwd: w.cwd,
    config: CONFIG,
    log: (m: string) => { lines.push(m) },
    warn: (m: string) => { lines.push(`WARN ${m}`) },
  }

  const out = await runRepair(ports, { sessionId: 'root-1', classes: 'all' })
  const classes = out.findingsBefore.map((f) => f.class)
  assert.ok(classes.includes('hollow-payload'), `found the husk: ${classes.join(',')}`)
  assert.ok(classes.includes('never-archived-span'), `found the missed turn: ${classes.join(',')}`)

  const after = await store.get('root-1')
  const husk = after.chapters.find((c) => c.number === 2)!
  assert.equal(husk.status, 'superseded', 'the husk is marked, not deleted')
  assert.ok(after.chapters.some((c) => c.number > 2 && (c.messages ?? 0) > 0), 'a real replacement chapter exists')
  const replacement = after.chapters.filter((c) => c.number > 2)
  assert.ok(replacement.every((c) => (c.messages ?? 0) > 0), 'and every new chapter rendered messages')
  // the bytes on disk are real, not a shell
  for (const c of replacement) {
    const body = fs.readFileSync(path.join(w.cwd, c.path), 'utf8')
    assert.match(body, /please (beta|gamma)|touching/, `chapter ${c.number} carries conversation text`)
    assert.doesNotMatch(body, /tool: unknown/, 'and no payload-less shell')
  }
  // the husk's file was COPIED to quarantine, never removed from the record set
  const q = path.join(w.cwd, '.dsh-chapters', 'root-1', '.repair-quarantine')
  assert.ok(fs.existsSync(path.join(q, '002-ch-2.md')), 'quarantine holds a copy')

  // the journal exists and is complete
  const jf = fs.readdirSync(path.join(w.cwd, '.dsh-chapters', 'root-1', 'repairs'))
  assert.equal(jf.length, 1, 'one journal for one run')
  const journal = JSON.parse(fs.readFileSync(path.join(w.cwd, '.dsh-chapters', 'root-1', 'repairs', jf[0]!), 'utf8'))
  assert.ok(journal.entries.length > 0, 'and it records the moves')
  assert.equal(journal.completedAt !== null, true, 'and it closed')

  // IDEMPOTENCE: a second run must find nothing actionable — the acceptance criterion.
  const second = await runRepair(ports, { sessionId: 'root-1', classes: 'all' })
  assert.equal(second.findingsAfter.filter((f) => ['hollow-payload', 'never-archived-span'].includes(f.class)).length, 0,
    `a repair that re-finds its own work never converges: ${JSON.stringify(second.findingsAfter.map((f) => f.class))}`)
})

test('dry-run changes nothing on disk (#60)', async () => {
  const w = world()
  const store = makeStore(w.states)
  const before = JSON.stringify(w.states.get('root-1'))
  const filesBefore = fs.readdirSync(path.join(w.cwd, '.dsh-chapters', 'root-1', 'chapters')).sort()
  const ports = { store: store as never, readLog: async () => w.events, cwd: w.cwd, config: CONFIG, log: () => {}, warn: () => {} }
  const out = await runRepair(ports, { sessionId: 'root-1', classes: 'all', dryRun: true })
  assert.ok(out.findingsBefore.length > 0, 'it still reports what WOULD be done')
  assert.equal(JSON.stringify(w.states.get('root-1')), before, 'and the registry did not move')
  assert.deepEqual(fs.readdirSync(path.join(w.cwd, '.dsh-chapters', 'root-1', 'chapters')).sort(), filesBefore, 'nor did the files')
  assert.ok(!fs.existsSync(path.join(w.cwd, '.dsh-chapters', 'root-1', 'repairs')), 'a dry run writes no journal')
})

test('no log, no repair: the run refuses and says the knowledge is unrecoverable (#60)', async () => {
  const w = world()
  const store = makeStore(w.states)
  const ports = { store: store as never, readLog: async () => null, cwd: w.cwd, config: CONFIG, log: () => {}, warn: () => {} }
  const out = await runRepair(ports, { sessionId: 'root-1', classes: 'all' })
  assert.equal(out.applied.length, 0, 'nothing applied')
  assert.match(out.refused.join(' '), /cannot be re-derived|unrecoverable/, out.refused.join(' '))
})

test('restore walks the journal backwards and brings the quarantined bytes back (#60)', async () => {
  const w = world()
  const store = makeStore(w.states)
  const ports = { store: store as never, readLog: async () => w.events, cwd: w.cwd, config: CONFIG, log: () => {}, warn: () => {} }
  const out = await runRepair(ports, { sessionId: 'root-1', classes: 'all' })
  const tree = path.join(w.cwd, '.dsh-chapters', 'root-1', 'chapters')
  const created = out.applied.filter((e) => e.kind === 'write' && e.beforeSha === null).map((e) => e.path)
  assert.ok(created.length > 0, 'the run created files')
  const res = await restoreRepair(ports, out.journalId, 'root-1')
  assert.ok(res.undone > 0, `restored ${res.undone}`)
  for (const p of created) assert.ok(!fs.existsSync(p), `${p} was removed by the restore`)
  assert.ok(fs.existsSync(path.join(tree, '002-ch-2.md')), 'the husk file itself is still there (it was copied, not moved)')
})
