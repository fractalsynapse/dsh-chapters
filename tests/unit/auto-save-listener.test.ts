/**
 * Unit rows for the subagent-end auto-save LISTENER (issue #47,
 * docs/architecture.md § The archive moments, door 5).
 *
 * The factory is pure logic against injected reads — the real save pipeline is
 * covered by tests/integration/subagent-auto-save.test.ts. What pins here is
 * the CONTRACT of the seam: gates, containment, serialization, fallback arms.
 * Every measured fact these rows encode comes from spikes/subagent-end/FINDINGS.md.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeSubagentEndListener, type AutoSaveChildView } from '../../src/auto-save.ts'

const childHeader = { id: 'child-1', cwd: '/tmp/ws', parentSession: 'parent-1', origin: 'subagent', agentPreset: 'chapters' }
const turnEvents = (): AutoSaveChildView['events'] => [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 1, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] } },
  { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
  { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
] as never
const view = (over: Partial<AutoSaveChildView> = {}): AutoSaveChildView =>
  ({ events: turnEvents(), header: { ...childHeader }, ...over })

function world(opts: {
  live?: (id: string) => AutoSaveChildView | undefined
  durable?: (id: string) => Promise<AutoSaveChildView | undefined>
  save?: (child: AutoSaveChildView) => Promise<{ archived: number; skipped: string | null }>
} = {}) {
  const saved: AutoSaveChildView[] = []
  const warnings: string[] = []
  const settled: Array<[string, string]> = []
  let inFlight = 0
  let overlapped = false
  const save = opts.save ?? (async (child) => {
    inFlight += 1
    if (inFlight > 1) overlapped = true
    await new Promise((r) => setTimeout(r, 5))
    inFlight -= 1
    saved.push(child)
    return { archived: 1, skipped: null }
  })
  const listener = makeSubagentEndListener({
    presetId: 'chapters',
    liveChild: opts.live ?? (() => view()),
    ...(opts.durable !== undefined ? { durableChild: opts.durable } : {}),
    save,
    warn: (m) => { warnings.push(m) },
    onSettled: (id, outcome) => { settled.push([id, outcome]) },
  })
  return { listener, saved, warnings, settled, done: () => overlapped, view }
}

/** Drain the per-session chains (fire-and-forget by contract). */
const drain = () => new Promise((r) => setTimeout(r, 40))

test('happy path: chapters-preset subagent end → save once', async () => {
  const w = world()
  w.listener({ id: 'child-1', runId: 'r1', provider: 'spawn', stopReason: 'completed' })
  await drain()
  assert.equal(w.saved.length, 1)
  assert.equal(w.saved[0]!.header.parentSession, 'parent-1')
  assert.deepEqual(w.settled, [['child-1', 'saved']])
})

test('preset gate: a child on another preset is left alone', async () => {
  const w = world({ live: () => view({ header: { ...childHeader, agentPreset: 'standard' } }) })
  w.listener({ id: 'child-1' })
  await drain()
  assert.equal(w.saved.length, 0)
  assert.ok(w.settled[0]?.[1].startsWith('skipped:preset'), `settled: ${JSON.stringify(w.settled)}`)
  assert.equal(w.warnings.length, 0, 'a preset skip is quiet, not a warning')
})

test('lineage gate: no durable parentSession means not a subagent child — skip quiet', async () => {
  const w = world({ live: () => view({ header: { ...childHeader, origin: undefined } }) })
  w.listener({ id: 'child-1' })
  await drain()
  assert.equal(w.saved.length, 0)
  assert.ok(w.settled[0]?.[1].startsWith('skipped:origin'))
})

test('no completed turn → skipped, never half-archived', async () => {
  const w = world({ live: () => view({ events: [{ type: 'user/message', seq: 1, data: { id: 'u', role: 'user', content: [] } }] as never }) })
  w.listener({ id: 'child-1' })
  await drain()
  assert.equal(w.saved.length, 0)
  assert.ok(w.settled[0]?.[1].startsWith('skipped:no-completed-turn'))
})

test('fallback arm: live handle gone → durable read decides', async () => {
  const w = world({
    live: () => undefined,
    durable: async () => view(),
  })
  w.listener({ id: 'child-1' })
  await drain()
  assert.equal(w.saved.length, 1, 'the durable view saved the archive')
  assert.ok(w.settled[0]![1].includes('durable'))
})

test('unreadable: no handle and no durable view → loud skip, no save', async () => {
  const w = world({ live: () => undefined, durable: async () => undefined })
  w.listener({ id: 'child-1' })
  await drain()
  assert.equal(w.saved.length, 0)
  assert.equal(w.warnings.length, 1)
  assert.match(w.warnings[0]!, /child-1/)
  assert.ok(w.settled[0]![1].includes('unreadable'))
})

test('no durable arm configured: handle gone alone is enough to warn-skip', async () => {
  const w = world({ live: () => undefined })
  w.listener({ id: 'child-1' })
  await drain()
  assert.equal(w.saved.length, 0)
  assert.equal(w.warnings.length, 1)
})

test('containment: a throwing save must never escape the listener (the emitter contract)', async () => {
  const w = world({ save: async () => { throw new Error('disk on fire') } })
  assert.doesNotThrow(() => { w.listener({ id: 'child-1' }) })
  await drain()
  assert.equal(w.warnings.length, 1, 'failure is reported once, loudly')
  assert.ok(w.settled[0]![1].includes('failed'))
})

test('a malformed info (no id) is contained, not thrown', () => {
  const w = world()
  assert.doesNotThrow(() => { w.listener({} as never) })
})

test('same child settles twice in one tick → saves serialize (watermark-safe ordering)', async () => {
  const w = world()
  w.listener({ id: 'child-1' })
  w.listener({ id: 'child-1' })
  await drain()
  assert.equal(w.done(), false, 'two saves for the same child never overlapped')
  assert.equal(w.saved.length, 2)
})

test('distinct children run independently (no cross-child queue)', async () => {
  const w = world()
  w.listener({ id: 'child-1' })
  w.listener({ id: 'child-2' })
  await drain()
  assert.equal(w.saved.length, 2)
})
