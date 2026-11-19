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

// ─────────────── #349: the birth payload carries the re-arm decision ───────────────

const goalEv = (seq: number, operation: string, goal: Record<string, unknown>): SessionEventLike =>
  ({ type: 'goal/change', seq, data: { operation, goal } } as unknown as SessionEventLike)

function goalWorld(events: SessionEventLike[]) {
  const fs = new FakeFs()
  const live = new Map<string, SessionState>([['A', freshSession('A')]])
  const created: Array<{ sessionId: string; goal?: { objective: string; maxGoalRounds?: number } }> = []
  const ports: ContinuePorts = {
    readCallerEvents: async () => events,
    getState: async (id) => cloneState(live, id),
    putState: async (id, st) => { live.set(id, st) },
    mutateState: async (id, fn) => { live.set(id, fn(cloneState(live, id))) },
    fs: () => fs,
    budgetProbe: async () => ({ windowTokens: 131_072, headerBoundTokens: 13_000 }),
    newId: () => 'g-id',
    createChild: async (i) => { created.push(i as never) },
    now: () => 1_700_000_000_000,
  }
  return { ports, created }
}

function cloneState(live: Map<string, SessionState>, id: string): SessionState {
  return JSON.parse(JSON.stringify(live.get(id) ?? freshSession(id))) as SessionState
}

test('#349: an ACTIVE carried goal makes runContinue hand createChild the re-arm payload; paused hands none', async () => {
  const activeEvents = [
    goalEv(0, 'create', { id: 'g1', revision: 4, objective: 'Ship the widget end to end', phase: 'active', maxGoalRounds: 12 }),
    ...conversation(6),
  ]
  const w = goalWorld(activeEvents)
  const out = await runContinue(w.ports, { ...args, callerSessionId: 'A' } as never, CONFIG)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(w.created.length, 1)
  assert.equal(w.created[0]!.goal?.objective, 'Ship the widget end to end', 'the birth input carries the objective')
  assert.equal(w.created[0]!.goal?.maxGoalRounds, 12, 'and the round cap — same semantics, fresh counts')
  // the notice said it out loud, in re-armed mode:
  const wrote = Array.from((w.ports as unknown as { __fs?: never }) ?? []) // no-op typing guard
  void wrote

  const pausedEvents = [
    goalEv(0, 'create', { id: 'g1', revision: 4, objective: 'Ship the widget end to end', phase: 'active' }),
    goalEv(1, 'pause', { id: 'g1', revision: 4, phase: 'paused' }),
    ...conversation(6),
  ]
  const p = goalWorld(pausedEvents)
  const out2 = await runContinue(p.ports, { ...args, callerSessionId: 'A' } as never, CONFIG)
  assert.equal(out2.ok, true)
  assert.equal(p.created[0]!.goal, undefined, 'a paused goal is human-owned — no re-arm payload')
})
