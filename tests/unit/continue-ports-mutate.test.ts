/**
 * The row-write seam that keeps other doors' commits alive (#101).
 *
 * `store.put` replaces a whole row, so a `getState`→`putState` pair silently deletes anything another door
 * committed in between — files on disk, records gone, which is the signature AGENTS records (an enrichment
 * put rewinding a compaction commit 1.9 s earlier) and the reason `chapters-repair` started appearing to
 * invent twins. The chapter allocator is the worst site: `reserve()` runs after every artifact write, and
 * the commit runs after `agents.create`. This drives the REAL `runContinue` with a fake store whose
 * `getState` hands back a snapshot and whose concurrency hook commits another door's chapter immediately
 * after that snapshot leaves — the exact interleaving the real host produces.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runContinue, type ContinueConfig, type ContinuePorts } from '../../src/continue-core.ts'
import { appendChapters, freshSession, type SessionState } from '../../src/registry.ts'
import type { SessionEventLike } from '../../src/types.ts'
import type { ArchiveFs } from '../../src/archive.ts'

const CONFIG: ContinueConfig = {
  artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
  continuationBudgetRatio: 0.25, fallbackPreset: 'chapters',
}
const ev = (seq: number, type: string): SessionEventLike =>
  type === 'user/message' || type === 'assistant/message'
    ? { type, seq, time: 0, surfaceOp: 'append', data: { id: `m${seq}`, role: type.split('/')[0], source: { kind: 'user' }, content: [{ type: 'text', text: `line ${seq}` }] } } as SessionEventLike
    : { type, seq, data: {} } as SessionEventLike
// the same conversation shape tests/unit/continue.test.ts drives, so the ranges below are proven valid
const conversation = (n: number): SessionEventLike[] => [
  ev(0, 'user/message'), ev(1, 'assistant/message'),
  ev(2, 'user/message'), ev(3, 'assistant/message'),
  { type: 'turn/end', seq: 4, data: { turn: 1 } } as SessionEventLike,
  ...Array.from({ length: n }, (_, i) => ev(5 + i, i % 2 ? 'assistant/message' : 'user/message')),
  { type: 'turn/end', seq: 5 + n, data: { turn: 2 } } as SessionEventLike,
]

class FakeFs implements ArchiveFs {
  files = new Map<string, string>()
  async write(p: string, c: string) { this.files.set(p, c) }
  async read(p: string) { return this.files.get(p) }
  async exists(p: string) { return this.files.has(p) }
}

function world(opts: { onSnapshotTaken?: () => void }) {
  const fs = new FakeFs()
  const live = new Map<string, SessionState>([['A', freshSession('A')]])
  let n = 0
  const clone = (s: SessionState): SessionState => JSON.parse(JSON.stringify(s)) as SessionState
  const ports: ContinuePorts = {
    readCallerEvents: async () => conversation(6),
    getState: async (id) => { const s = clone(live.get(id) ?? freshSession(id)); opts.onSnapshotTaken?.(); return s },
    putState: async (id, s) => { live.set(id, s) },
    mutateState: async (id, fn) => { live.set(id, fn(clone(live.get(id) ?? freshSession(id)))) },
    fs: () => fs,
    budgetProbe: async () => ({ windowTokens: 131072, headerBoundTokens: 13000 }),
    newId: () => `id-${++n}`,
    createChild: async () => {},
    now: () => 1700000000000,
  }
  return { ports, live, fs }
}

const args = { callerSessionId: 'A', callerPreset: 'chapters', title: 'Widget work', handoffNote: 'Note.',
  chapters: [{ title: 'Setup', summary: 'project scaffold', startSeq: 0, endSeq: 4 },
             { title: 'Model changes', summary: 'widget model edits', startSeq: 5, endSeq: 10 }],
  toolResultOverrides: [] }

test('a door that commits between our read and our write keeps its chapter (#101)', async () => {
  // EVERY read is raced: each snapshot `runContinue` takes goes stale the instant it is handed over, which
  // is the honest model of five doors plus the turn/end listener writing one row. The injection numbers are
  // offset far above the caller's counter so a repair-grade collision cannot mask the loss.
  let injected = 0
  const { ports, live } = world({
    onSnapshotTaken: () => {
      injected++
      // numbers far above the caller's counter, and the counter is NOT bumped: `appendChapters` correctly
      // refuses to let two records share one number, and an earlier version of this fixture proved that by
      // colliding with the allocator's own allocation. A concurrent door does not spend our numbers.
      const cur = live.get('A')!
      const num = 9000 + injected
      live.set('A', appendChapters(cur, [{ number: num, path: `x/other-${String(num)}.md`, title: `Other door ${String(num)}`, summary: 'committed while we held a snapshot', startSeq: 0, endSeq: 1, sha256: `aaaaaaaa${String(num)}`, status: 'active' as const }]))
    },
  })
  const out = await runContinue(ports as never, args as never, CONFIG as never)
  assert.equal(out.ok, true, `continue must succeed: ${(out as { reason?: string }).reason ?? '?'}`)
  const row = live.get('A')!
  const survived = row.chapters.filter((c) => c.title.startsWith('Other door')).length
  assert.ok(injected > 0, 'the race must actually have been taken')
  assert.equal(survived, injected,
    `every concurrently committed chapter must survive our writes (${String(survived)} of ${String(injected)} survived; row holds [${row.chapters.map((c) => c.title).join(', ').slice(0, 200)}])`)
  assert.ok(row.chapters.some((c) => c.title === 'One' || String(c.number) !== ''), 'and our own chapters committed')
})
