/**
 * Issue #47 spike — what a host-plane plugin OBSERVES at `subagent/end`.
 *
 * Zero model tokens: registers a fake one-shot provider whose child is a real
 * session (created via agents.create with parentAgent, seeded log authored with
 * session.append) and whose run.result resolves by hand. The SERVICE still wraps
 * it in observeRun, so start/end are emitted through the real lifecycle emitter.
 *
 * Questions it measures (the load-bearing facts for the auto-save listener):
 *   Q1  Can our host-plane ctx subscribe to subagent/start + subagent/end at all?
 *   Q2  At the `end` emission, does ctx.agents.get(childId) still resolve, and is
 *       a SYNCHRONOUS session.snapshotEvents() a complete read? (the disposal race)
 *   Q3  After disposal, what durable reads survive for an ambient plugin:
 *       sessionQuery.listEvents / readSession / observeSession? (fallback class)
 *   Q4  How does the preset gate read on a child: `agent-preset/selected` events
 *       vs sessionProjections? (the "running the chapters preset" predicate)
 *   Q5  header.parentSession on a subagent child == the spawning parent id?
 *       (the lineage we write into chapter frontmatter)
 *   Q6  Payload truth: stopReason + lastAssistantMessage on success; end fires.
 *
 * Scratch home ONLY (DSH_HOME=<repo>/.dshdev-probe47). Writes results-47.json
 * incrementally and self-exits.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const OUT = process.env.PROBE47_OUT ?? path.join(ROOT, 'spikes', 'subagent-end', 'results-47.json')

const report = { spike: '47-subagent-end', startedAt: new Date().toISOString(), probes: [], notes: [], facts: {} }
const write = () => { try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch { /* monitor */ } }
const record = (name, ok, details = {}) => { report.probes.push({ name, ok, ...details }); write() }
const note = (s) => { report.notes.push(String(s)); write() }
const finish = (code = 0) => { report.finishedAt = new Date().toISOString(); write(); setTimeout(() => process.exit(code), 50).unref() }

function safe(value, depth = 0) {
  try {
    if (value === null || typeof value !== 'object') return { value: String(value) }
    if (depth > 3) return { truncated: true }
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object') out[k] = safe(v, depth + 1)
      else if (typeof v === 'function') out[k] = `[fn ${v.name || 'anonymous'}]`
      else out[k] = v
    }
    return out
  } catch (error) {
    return { unserializable: String(error?.message ?? error) }
  }
}

const errInfo = (error) => ({
  message: String(error?.message ?? error),
  name: error?.name,
  code: error?.code,
  kind: error?.kind,
})

export const name = 'dsh-chapters-probe-subagent-end'
export const inject = ['agents', 'storageDomain', 'sessionProjections', 'sessionQuery']

export function apply(ctx, config) {
  const guard = setTimeout(() => { note('GUARD: 120s elapsed, finishing with partial facts'); finish(1) }, 120_000)
  guard.unref?.()

  const run = async () => {
    // ---- Q1: service + event subscription surface -------------------------------
    let subagents = null
    try { subagents = ctx.get?.('subagents') ?? null } catch (error) { note('ctx.get(subagents) threw: ' + String(error?.message ?? error)) }
    record('subagents-service-present', subagents !== null, {
      methods: subagents === null ? [] : Object.getOwnPropertyNames(Object.getPrototypeOf(subagents) ?? {}),
    })
    if (subagents === null) { record('host-plane-cannot-drive-emitter', false, { note: 'no ambient subagents service' }); finish(); return }

    /** Everything the end/start listeners see, captured SYNCHRONOUSLY in-callback. */
    const seen = { start: [], end: [] }
    const mkListener = (which) => (info) => {
      const entry = { payload: safe(info), atEmit: {} }
      try {
        const child = ctx.get?.('agents')?.get?.(info.id)
        entry.atEmit.handleResolved = child !== undefined && child !== null
        const session = child?.agent?.session ?? child?.session
        if (session !== undefined) {
          const events = session.snapshotEvents?.() ?? []
          entry.atEmit.eventCount = events.length
          entry.atEmit.types = events.map((e) => e.type)
          entry.atEmit.lastSeq = events.length > 0 ? events[events.length - 1].seq : null
          entry.atEmit.header = safe({ id: session.header?.id, parentSession: session.header?.parentSession, cwd: session.header?.cwd, isSeeded: session.header?.isSeeded, origin: session.header?.origin, delegationDepth: session.header?.delegationDepth, agentPreset: session.header?.agentPreset })
        }
      } catch (error) { entry.atEmit.error = errInfo(error) }
      seen[which].push(entry)
      write()
    }
    let subOk = true
    try { ctx.on('subagent/start', mkListener('start')) } catch (error) { subOk = false; note('subagent/start listener refused: ' + errInfo(error).message) }
    try { ctx.on('subagent/end', mkListener('end')) } catch (error) { subOk = false; note('subagent/end listener refused: ' + errInfo(error).message) }
    record('host-plane-can-subscribe-lifecycle', subOk)

    // ---- parent agent (never runs a turn) --------------------------------------
    const pId = `p47-${randomUUID().slice(0, 8)}`
    let parentHandle = null
    try {
      parentHandle = await ctx.agents.create({
        sessionId: pId, seed: [],
        meta: { cwd: ROOT, isSeeded: false },
        agentOptions: {},
      })
      record('parent-agent-created', parentHandle !== null && parentHandle !== undefined)
    } catch (error) { record('parent-agent-created', false, errInfo(error)); finish(); return }
    const parent = parentHandle.agent

    // ---- Q4 probe helper: how does a preset read on a session? ------------------
    const presetViews = (session) => {
      const out = {}
      const events = session.snapshotEvents?.() ?? []
      const selected = events.filter((e) => e.type === 'agent-preset/selected')
      out.selectedEvents = selected.map((e) => safe(e.data))
      for (const key of ['agentPreset', 'preset', 'agent-preset']) {
        try { out['projection:' + key] = safe(ctx.sessionProjections?.stateOf?.(session, key)) }
        catch (error) { out['projection:' + key] = 'threw: ' + String(error?.message ?? error) }
      }
      return out
    }

    // ---- fake one-shot provider -------------------------------------------------
    const PROVIDER = 'probe-oneshot-47'
    let childId = null
    let childHandle = null
    const provider = {
      name: PROVIDER,
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      async start(request) {
        childId = randomUUID()
        // Real child session through the same seam the in-process driver uses.
        childHandle = await request.parent.ctx.agents.create({
          sessionId: childId,
          parentAgent: request.parent,
          meta: { cwd: ROOT, isSeeded: false, agentPreset: 'chapters', parentSession: request.parent.session.id, origin: 'subagent', delegationDepth: 1 }, // shapes from the real childSessionMeta (dsh-subagent/lib/index.js:470)
          agentOptions: {},
          setup: () => {},
        })
        const session = childHandle.agent.session
        // Author a completed-turn log WITHOUT a model: user msg, assistant report,
        // turn/end — shapes verified byte-for-byte against a real v4 durable log
        // (user data = the UserMessage itself; assistant data wraps the message;
        // turn/end reason is {kind:'completed'}).
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'probe task' }] }, { surfaceOp: 'append' })
        session.append('assistant/message', { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'probe', model: 'fake' }, content: [{ type: 'text', text: 'PROBE47-REPORT' }] }, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'block-start', index: 0, blockType: 'text' } }] }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        report.facts.childPresetViews = presetViews(session)
        report.facts.childHeaderAtStart = safe({ id: session.header?.id, parentSession: session.header?.parentSession, cwd: session.header?.cwd })
        write()
        return {
          id: childId,
          localAgent: childHandle.agent,
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'PROBE47-REPORT' }] }),
          async dispose() { await childHandle.dispose?.() },
        }
      },
    }
    let disposer
    try { disposer = subagents.registerProvider(provider); record('provider-registered', true) }
    catch (error) { record('provider-registered', false, errInfo(error)); finish(); return }

    // ---- drive one real run through the service emitter -------------------------
    const ctrl = new AbortController()
    let run1
    try {
      run1 = await subagents.start(PROVIDER, {
        label: 'probe47',
        prompt: [{ type: 'text', text: 'probe task' }],
        parent,
        signal: ctrl.signal,
      })
      record('service-start-fulfilled', run1 !== undefined, { runIdEqualsChildId: run1?.id === childId })
    } catch (error) { record('service-start-fulfilled', false, errInfo(error)); finish(); return }

    // let the microtask chain emit end (observeRun wraps run.result)
    await new Promise((res) => setTimeout(res, 150))
    record('end-emitted-before-dispose', seen.end.length === 1, { starts: seen.start.length })

    // ---- Q2 answer lives in seen.end[0].atEmit — print it into the probe -------
    const endEntry = seen.end[0]
    record('live-handle-at-emit', endEntry?.atEmit?.handleResolved === true, { snapshot: safe(endEntry?.atEmit) })

    // ---- dispose, then Q3 durable reads -----------------------------------------
    try { await run1.dispose(); record('run-disposed', true) } catch (error) { record('run-disposed', false, errInfo(error)) }
    await new Promise((res) => setTimeout(res, 150))
    record('agents-get-after-dispose', (ctx.get?.('agents')?.get?.(childId) ?? null) === null, { note: 'true arm = handle gone (expected)' })

    const sq = ctx.get?.('sessionQuery')
    for (const method of ['listEvents', 'readSession', 'read']) {
      if (sq === undefined || typeof sq[method] !== 'function') { record('fallback-' + method, false, { note: 'surface absent' }); continue }
      try {
        const res = await Promise.race([
          sq[method](childId),
          new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout-10s')), 10_000)),
        ])
        const arr = Array.isArray(res) ? res : Array.isArray(res?.events) ? res.events : null
        record('fallback-' + method, true, {
          shape: arr === null ? safe(res) : { count: arr.length, types: arr.map((e) => e.type ?? '?') },
        })
      } catch (error) { record('fallback-' + method, false, errInfo(error)) }
    }

    // ---- Q6: end payload truth + second settle (continuable shape stays static) --
    record('end-payload-shape', endEntry !== undefined, { payload: safe(endEntry?.payload) })

    // cleanup: parent handle, provider disposer (effect-scoped anyway)
    try { await parentHandle.dispose?.() } catch { /* probe */ }
    try { if (typeof disposer === 'function') await disposer() } catch { /* probe */ }
    finish()
  }

  run().catch((error) => { note('FATAL: ' + errInfo(error).message); finish(1) })
}
