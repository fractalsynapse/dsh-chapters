/**
 * The #194 push-transport probe plugin. Self-driving: at apply() it registers a projection,
 * creates a session, appends a plugin record through BOTH module-resolution strategies (bare
 * walk-up import vs createRequire from the host binary), reads the projection back, and writes
 * every step — including failures, verbatim — to the file PROBE_RESULTS names. No GUI, no model,
 * no turns: session existence is all appendPluginRecord and stateOf need (round 10 measured that
 * create-without-agentOptions yields a session whose TURNS die; we never turn).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

export const name = 'push-probe'
export const inject = ['sessionProjections', 'agents']

// Top-level marker: distinguishes "module never loaded" from "apply never called".
try { fs.writeFileSync(process.env.PROBE_MARKER ?? '/tmp/push-probe-loaded.marker', new Date().toISOString()) } catch { /* findings over crashes */ }

const RESULTS = process.env.PROBE_RESULTS ?? path.join(process.cwd(), 'probe-results.json')
const out = { at: new Date().toISOString(), node: process.version, argv1: process.argv[1] ?? null, steps: [] }
const step = (name, fn) => {
  try {
    const value = fn()
    if (value && typeof value.then === 'function') {
      return value.then((v) => { out.steps.push({ name, ok: true, value: v }); fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2)) },
        (e) => { out.steps.push({ name, ok: false, error: String(e?.message ?? e).slice(0, 400) }); fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2)) })
    }
    out.steps.push({ name, ok: true, value })
  } catch (e) {
    out.steps.push({ name, ok: false, error: String(e?.message ?? e).slice(0, 400) })
  }
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2))
  return Promise.resolve()
}

export async function apply(ctx) {
  try { fs.writeFileSync((process.env.PROBE_MARKER ?? '/tmp/push-probe-loaded.marker') + '.apply', JSON.stringify({ ctxKeys: Object.keys(ctx ?? {}).slice(0, 30), hasProjections: typeof ctx?.sessionProjections?.register, hasAgents: typeof ctx?.agents?.create })) } catch { /* ditto */ }
  await step('projection.register', () => {
    ctx.sessionProjections.register({
      key: 'pushProbe',
      // Duck-typed schemas: the probe measures what register ACCEPTS. If the host demands zod,
      // this step fails loudly and the findings say so — that is the probe working, not breaking.
      stateSchema: { parse: (v) => v },
      init: () => ({ notes: [], count: 0 }),
      apply: (state, event) => {
        if (event === undefined || event === null || event.type !== 'plugin:push-probe/note') return state
        const d = event.data ?? {}
        return { notes: [...state.notes, String(d.text ?? '')], count: state.count + 1 }
      },
      wire: { viewSchema: { parse: (v) => v }, view: (s) => s },
      stateVersion: 1,
    })
    return 'registered'
  })

  await step('ctx.census', () => {
    const keys = ['agents', 'sessions', 'sessionProjections', 'goals', 'llm', 'commands', 'storageDomain', 'tools', 'agentPresets']
    const census = {}
    for (const k of keys) {
      try { census[k] = ctx[k] === undefined ? (ctx.get?.(k) === undefined ? 'absent' : 'get-able') : 'present' } catch (e) { census[k] = 'threw: ' + String(e?.message ?? e).slice(0, 60) }
    }
    return census
  })

  let session = null
  await step('agents.create', async () => {
    // The web composition creates sessions on client request and the base mounts agent-loop with
    // `agents: []` — the factory registers on its own fiber timeline, not before every apply().
    // Retry past boot completion instead of racing it (measured: apply-time create lost the race).
    let lastError = 'no attempt'
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        const created = await ctx.agents.create({ sessionId: `push-probe-${Date.now()}-${String(attempt)}` })
        const agent = created?.agent ?? created
        session = agent?.session ?? null
        if (session === null) throw new Error(`no session on the created agent (keys: ${Object.keys(agent ?? {}).join(',')})`)
        return `session ${String(session.id ?? '?')} on attempt ${String(attempt)}`
      } catch (e) {
        lastError = String(e?.message ?? e).slice(0, 160)
        await new Promise((r) => setTimeout(r, 10_000))
      }
    }
    throw new Error(`agents.create never succeeded: ${lastError}`)
  })

  await step('strategyA.bareImport', async () => {
    let url = 'unresolved'
    try { url = import.meta.resolve('@deepseek-ai/dsh-session') } catch { /* reported below */ }
    const mod = await import('@deepseek-ai/dsh-session')
    if (typeof mod.appendPluginRecord !== 'function') return { verdict: 'ABSENT', resolved: url }
    const seq = mod.appendPluginRecord(session, 'plugin:push-probe/note', { text: 'via-A', strategy: 'A' })
    return { verdict: 'APPENDED', seq, resolved: url, insideHostTree: url.includes(`${path.sep}host${path.sep}`) }
  })

  await step('strategyB.createRequireImport', async () => {
    const anchor = process.argv[1] ?? process.execPath
    const req = createRequire(anchor)
    const resolved = req.resolve('@deepseek-ai/dsh-session')
    const mod = await import(resolved)
    const fn = mod.appendPluginRecord ?? mod.default?.appendPluginRecord
    if (typeof fn !== 'function') return { verdict: 'ABSENT', resolved }
    const seq = fn(session, 'plugin:push-probe/note', { text: 'via-B', strategy: 'B' })
    return { verdict: 'APPENDED', seq, resolved }
  })

  await step('strategyC.createRequireSync', async () => {
    const anchor = process.argv[1] ?? process.execPath
    const req = createRequire(anchor)
    const mod = req('@deepseek-ai/dsh-session')
    const fn = mod?.appendPluginRecord ?? mod?.default?.appendPluginRecord
    if (typeof fn !== 'function') return { verdict: 'ABSENT', keys: Object.keys(mod ?? {}).slice(0, 12) }
    const seq = fn(session, 'plugin:push-probe/note', { text: 'via-C', strategy: 'C' })
    return { verdict: 'APPENDED', seq }
  })

  await step('strategyD.mainModuleGraph', async () => {
    // The host's own composed tree: walk the loaded ESM registry via the bin's realpath anchor.
    const { realpathSync } = await import('node:fs')
    const anchor = realpathSync(process.argv[1] ?? process.execPath)
    const req = createRequire(anchor)
    const resolved = req.resolve('@deepseek-ai/dsh-session')
    const mod = await import(resolved)
    const fn = mod.appendPluginRecord ?? mod.default?.appendPluginRecord
    if (typeof fn !== 'function') return { verdict: 'ABSENT', resolved }
    const seq = fn(session, 'plugin:push-probe/note', { text: 'via-D', strategy: 'D' })
    return { verdict: 'APPENDED', seq, resolved, anchor }
  })

  await step('record.readback', () => {
    if (session === null) return 'skipped: no session'

    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : null
    if (events === null) return 'no snapshotEvents on the session'
    const found = events.filter((e) => String(e.type).startsWith('plugin:push-probe')).map((e) => ({ seq: e.seq, ignorable: e.ignorable === true, data: e.data }))
    return { total: events.length, ours: found }
  })

  await step('projection.stateOf', () => {
    if (session === null) return 'skipped: no session'

    const st = ctx.sessionProjections.stateOf(session, 'pushProbe')
    return st === undefined ? 'undefined (projection not folded?)' : JSON.parse(JSON.stringify(st))
  })

  await step('surface.check', () => {
    if (session === null) return 'skipped: no session'

    // The model-visible surface must NOT contain the record — the invariant the push transport rests on.
    const surface = session.surface
    const items = surface?.items ?? surface?.events ?? (Array.isArray(surface) ? surface : null)
    if (items === null) return `surface shape unknown (keys: ${Object.keys(surface ?? {}).join(',')})`
    return { surfaceLen: items.length, pluginRecordsInSurface: items.filter((e) => String(e.type ?? '').startsWith('plugin:')).length }
  })

  out.done = true
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2))
}
