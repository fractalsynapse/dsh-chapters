import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEnrichQueue, type EnrichQueueDeps } from '../../src/enrich-queue.ts'

/** #456 ratchet: deterministic yielding WITHOUT timers — the fake-timer harness path resolves on
 * microtasks alone, so N awaits of a resolved promise is a complete, sleep-free observation. */
async function flush(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve()
}

function harness(over: Partial<EnrichQueueDeps> = {}) {
  const calls: string[] = []
  let pending = ['c1', 'c2', 'c3']
  let pendingFor = (m: string, cap: number) => { void m; return Promise.resolve(pending.slice(0, cap).map((k) => ({ key: k, label: k }))) }
  const deps: EnrichQueueDeps = {
    listPending: over.listPending ?? ((m, cap) => { void cap; return pendingFor(m, cap) }),
    enrichOne: over.enrichOne ?? (async (k) => { calls.push(k); return { ok: true } }),
    resolveModel: over.resolveModel ?? (async () => 'test-model'),
    enabled: over.enabled ?? true,
    trigger: over.trigger ?? 'both',
    idleMs: over.idleMs ?? 1000,
    batchCap: over.batchCap ?? 2,
    log: over.log ?? (() => undefined),
    setTimer: over.setTimer,
  }
  return { q: createEnrichQueue(deps), calls, setPending: (p: string[]) => { pending = p } }
}

test('afterPush trigger: drain on sync completion only', async () => {
  const { q, calls } = harness({ trigger: 'afterPush' })
  q.noteActivity() // idle provider NOT active: must not drain
  assert.deepEqual(calls, [])
  q.onSyncDone('test')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(calls, ['c1', 'c2'], 'batch cap honored')
  q.dispose()
})

test('idle trigger: resets on activity, drains once on silence', async () => {
  let fire: (() => void) | null = null
  let resets = 0
  const { q, calls } = harness({
    trigger: 'idle',
    setTimer: (fn) => { fire = fn; resets++; return { cancel: () => { fire = null } } },
  })
  q.noteActivity(); q.noteActivity(); q.noteActivity()
  assert.equal(resets, 3, 'each activity re-arms the debounce')
  assert.equal(typeof fire, 'function')
  fire!()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls.length, 2)
  q.dispose()
})

test('manual trigger: auto paths are silent; drainNow works', async () => {
  const { q, calls } = harness({ trigger: 'manual' })
  q.onSyncDone('x'); q.noteActivity()
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(calls, [])
  const n = await q.drainNow()
  assert.equal(n, 2); assert.equal(calls.length, 2)
  q.dispose()
})

test('kill switch: EVERY entry point is a pure no-op', async () => {
  const { q, calls } = harness({ enabled: false })
  q.onSyncDone('x'); q.noteActivity(); assert.equal(await q.drainNow(), 0)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(calls, [])
  assert.equal(q.state().enabled, false)
  q.dispose()
})

test('concurrent triggers collapse into ONE drain; state reports for /chapters-status', async () => {
  const { q } = harness()
  q.onSyncDone('a'); q.onSyncDone('b'); q.onSyncDone('c')
  const st = q.state()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(st.trigger, 'both')
  assert.equal(q.state().lastBatch, 2)
  assert.equal(q.state().model, 'test-model')
  q.dispose()
})

test('a throwing enrichOne... queue survives (enrichOne must not throw, but defend anyway)', async () => {
  const { q, calls } = harness({ enrichOne: async (k) => { calls.push(k); throw new Error('boom') } })
  await q.drainNow()
  assert.equal(q.state().lastBatch, 0, 'failure reported zero processed, no crash')
  q.dispose()
})

// #529: backlog chase — a full batch schedules its follow-up until the queue is empty; failure
// stops the chase; dispose stops the chase. Busy sessions never idle; the backlog must not wait
// for silence it will never see (measured: a model change left pending chapters for HOURS).
test('#529: afterPush drains the WHOLE backlog in capped passes, chasing itself between them', async () => {
  let chase: (() => void) | null = null
  let backlog = ['c1', 'c2', 'c3', 'c4']
  const { q } = harness({
    batchCap: 1,
    listPending: async (m: string, cap: number) => {
      void m
      const take = backlog.slice(0, cap)
      backlog = backlog.slice(cap)
      return take.map((k) => ({ key: k, label: k }))
    },
    setTimer: (fn: () => void) => { chase = fn; return { cancel: () => { chase = null } } },
  })
  q.onSyncDone('test') // void-drain by design — the seam does NOT return the pass
  // #456 ratchet honored: NO bare sleeps. The harness path is pure promises (resolveModel,
  // listPending, enrichOne — no timers), so deterministic microtask flushes observe each pass.
  await flush(12)
  assert.equal(backlog.length, 3, 'first capped pass took one')
  assert.equal(typeof chase, 'function', '#529: a full batch left work — the chase is scheduled, not optional')
  // The timer callback fires its drain WITHOUT awaiting (fire-and-forget by design — a realm
  // timer must not hold a promise), so the pump settles-and-polls like the runtime does.
  let guard = 0
  while (guard < 40 && backlog.length > 0) {
    guard += 1
    if (chase !== null) { const run = chase; chase = null; run() }
    await flush(12)
  }
  assert.equal(backlog.length, 0, 'chased to empty without any idle event')
  assert.ok(guard < 40, 'the chase terminated by itself')
})

test('#529: a failing drain stops the chase — the loop never hammers a broken model', async () => {
  let chase: (() => void) | null = null
  const { q } = harness({
    batchCap: 1,
    listPending: async () => { throw new Error('model down') },
    setTimer: (fn: () => void) => { chase = fn; return { cancel: () => { chase = null } } },
  })
  await q.onSyncDone('test')
  assert.equal(chase, null, 'failure ⇒ no follow-up scheduled')
})

// #565: the manual surface DRAINS (maintainer decision over the one-batch design). The pump chains
// capped passes on promise completion alone — these rows run on microtasks, no timers anywhere.
test('#565: drainAll pumps a full backlog to empty across capped passes and says so', async () => {
  let backlog = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']
  const logs: string[] = []
  const { q, calls } = harness({
    trigger: 'manual',
    batchCap: 2,
    listPending: async (_m: string, cap: number) => { const t = backlog.slice(0, cap); return t.map((k) => ({ key: k, label: k })) },
    enrichOne: async (k: string) => { calls.push(k); backlog = backlog.filter((x) => x !== k); return { ok: true } },
    log: (m: string) => { logs.push(m) },
  })
  const r = q.drainAll()
  assert.equal(r.started, true)
  assert.equal(q.isDraining(), true, 'the state is observable while running')
  for (let i = 0; i < 80 && q.isDraining(); i += 1) await flush(8)
  assert.equal(calls.length, 7, 'every chapter processed, cap 2 per pass')
  assert.match(logs.join('\n'), /full drain ended: 7 chapter\(s\) across 4 pass\(es\)/, logs.join('\n'))
  assert.equal(q.isDraining(), false)
  q.dispose()
})

test('#565: drainAll(3) honors the user-specified limit and leaves the rest pending', async () => {
  let backlog = ['c1', 'c2', 'c3', 'c4', 'c5']
  const { q, calls } = harness({
    trigger: 'manual',
    batchCap: 2,
    listPending: async (_m: string, cap: number) => backlog.slice(0, cap).map((k) => ({ key: k, label: k })),
    enrichOne: async (k: string) => { calls.push(k); backlog = backlog.filter((x) => x !== k); return { ok: true } },
  })
  q.drainAll(3)
  for (let i = 0; i < 60 && q.isDraining(); i += 1) await flush(8)
  assert.equal(calls.length, 3, 'exactly the limit, rounded through whole passes (2+1)')
  assert.deepEqual(backlog, ['c4', 'c5'], 'the remainder is untouched, still pending')
  q.dispose()
})

test('#565: a failing pass ENDS the drain — the pump never hammers a broken model', async () => {
  let boom = false
  let backlog = ['c1', 'c2', 'c3', 'c4']
  const logs: string[] = []
  const { q, calls } = harness({
    trigger: 'manual',
    batchCap: 2,
    listPending: async (_m: string, cap: number) => { if (boom) throw new Error('model down'); return backlog.slice(0, cap).map((k) => ({ key: k, label: k })) },
    enrichOne: async (k: string) => { calls.push(k); backlog = backlog.filter((x) => x !== k); if (calls.length === 2) boom = true; return { ok: true } },
    log: (m: string) => { logs.push(m) },
  })
  q.drainAll()
  for (let i = 0; i < 80 && q.isDraining(); i += 1) await flush(8)
  assert.equal(calls.length, 2, 'pass one ran, then the failing pass stopped the pump')
  assert.match(logs.join('\n'), /drain failed/, logs.join('\n'))
  assert.match(logs.join('\n'), /full drain ended: 2 chapter\(s\) across 1 pass\(es\)/, logs.join('\n'))
  q.dispose()
})

test('#565: single-flight — a second run while draining starts NOTHING', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((res) => { release = res })
  let backlog = ['c1', 'c2']
  const { q, calls } = harness({
    trigger: 'manual',
    batchCap: 2,
    listPending: async (_m: string, cap: number) => { await gate; return backlog.slice(0, cap).map((k) => ({ key: k, label: k })) },
    enrichOne: async (k: string) => { calls.push(k); backlog = backlog.filter((x) => x !== k); return { ok: true } },
  })
  const first = q.drainAll()
  assert.equal(first.started, true)
  for (let i = 0; i < 10; i += 1) await flush(4) // let the first pass reach the (blocked) listPending
  const second = q.drainAll()
  assert.equal(second.started, false, 'no double pump')
  assert.equal(second.alreadyRunning, true)
  release!()
  for (let i = 0; i < 60 && q.isDraining(); i += 1) await flush(8)
  assert.equal(calls.length, 2, 'the ONE drain the gate held finished; the second call added nothing')
  q.dispose()
})

test('#565: circuit-breaker — a queue that never shrinks stops the pump LOUDLY (spin guard)', async () => {
  const logs: string[] = []
  const { q, calls } = harness({
    trigger: 'manual',
    batchCap: 2,
    listPending: async () => [{ key: 'c-stuck', label: 'stuck' }], // never depletes even on success
    enrichOne: async (k: string) => { calls.push(k); return { ok: true } },
    log: (m: string) => { logs.push(m) },
  })
  q.drainAll()
  for (let i = 0; i < 40 && q.isDraining(); i += 1) await flush(8)
  assert.equal(q.isDraining(), false, 'the pump stopped on its own — it may not spin a non-shrinking queue')
  assert.ok(calls.length <= 2, `bounded work: ${calls.length} calls`)
  assert.match(logs.join('\n'), /STOPPED: head c-stuck unchanged/, logs.join('\n'))
  q.dispose()
})
