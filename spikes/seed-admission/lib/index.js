/**
 * #54 — the seed-admission matrix, outside a browser.
 *
 * The question this exists to answer, in one sentence: when host 0.2.x refuses our fork door
 * with `format v4 message requires a producer-owned source kind`, is the refusing row OURS?
 *
 * Every hypothesis about that message so far has come from a browser run, where the error text
 * is sliced for a composer note, the plugin's own logger is invisible, and a dozen host rows
 * (persona, presets, workspace attach, session-title machinery) share the create call. This
 * probe isolates them: same `agents.create`, one variable at a time, full error text recorded
 * the moment it happens, and the durable directory inspected afterwards — because the browser
 * symptom (`ch-…` exists, holds only `session.lock`) is half the story and nobody had checked
 * which of the variants reproduces it.
 *
 *   DSH_HOME=$PWD/.dshdev timeout 120 dsh web --port 0 --no-open
 *   # writes spikes/seed-admission/results.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildTocNotice } from '../../../lib/notice.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'results.json')
const report = { startedAt: new Date().toISOString(), variants: [] }
const record = (v) => {
  report.variants.push(v)
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) } catch { /* best effort */ }
}

// `time` is the VALUE the row carries (continue-core passes `ports.now()`, already called).
// Passing a function here is a probe bug the host correctly rejects as non-serializable —
// which is exactly how this row was first written, and why the first matrix proved nothing.
const noticeEvent = () => buildTocNotice('# Continuation: probe\n\n## Chapters\n(one row)', {
  newId: () => randomUUID(), time: Date.now(),
})
const plainUser = () => ({
  type: 'user/message', seq: 0, time: Date.now(), surfaceOp: 'append',
  data: {
    id: randomUUID(), role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'plain user seed row' }],
  },
})
// the retired wrapper, verbatim from a pre-v4 log line: proves the predicate is live at all
const v3Wrapped = () => {
  const e = noticeEvent()
  e.data.source = { kind: 'plugin', plugin: 'dsh-chapters', form: 'snapshot', sections: e.data.source.sections }
  return e
}
const planModeEvent = (seq) => ({
  type: 'plan/mode', seq, time: Date.now(), data: { active: true },
})

const describeError = (error) => error === undefined ? '(none)' : String(
  (error instanceof Error) ? `${error.name}: ${error.message}` : error,
)

export const name = 'dsh-seed-admission'
export const inject = ['agents', 'agentPresets', 'sessionQuery', 'webServer']

export function apply(ctx) {
  void (async () => {
    const presetId = 'chapters'
    let n = 0
    const baseMeta = { cwd: process.cwd(), isSeeded: false }

    const attempts = [
      { label: 'bare-user-seed', seed: () => [plainUser()], meta: baseMeta, mount: false },
      { label: 'our-notice-v4', seed: () => [noticeEvent()], meta: baseMeta, mount: false },
      { label: 'our-notice-plus-planmode', seed: () => [noticeEvent(), planModeEvent(1)], meta: baseMeta, mount: false },
      { label: 'v3-wrapped-notice(expected-refusal)', seed: () => [v3Wrapped()], meta: baseMeta, mount: false },
      { label: 'our-notice-with-preset-mount', seed: () => [noticeEvent()], meta: { ...baseMeta, agentPreset: presetId }, mount: true },
      { label: 'empty-seed', seed: () => [], meta: baseMeta, mount: false },
      // the door's ACTUAL call: caller options ride along, because a continuation must
      // compose a model or it dies at prompt assembly (`{{model}} has no value`) — so the
      // host composes the child's header during create, and THAT is where an extra row can
      // appear. The variants above never passed agentOptions, which is why they all agreed.
      { label: 'notice+agentOptions', seed: () => [noticeEvent()], meta: baseMeta, mount: false, options: true },
      { label: 'notice+agentOptions+mount', seed: () => [noticeEvent()], meta: { ...baseMeta, agentPreset: presetId }, mount: true, options: true },
      { label: 'notice+agentOptions+mount+planmode', seed: () => [noticeEvent(), planModeEvent(1)], meta: { ...baseMeta, agentPreset: presetId }, mount: true, options: true },
    ]

    for (const a of attempts) {
      const sessionId = `ch-probe-${String(++n)}-${randomUUID().slice(0, 8)}`
      const out = { label: a.label, sessionId, ok: false }
      const t0 = Date.now()
      try {
        const handle = await ctx.agents.create({
          sessionId,
          seed: a.seed(),
          inheritedEventCount: 0,
          meta: a.meta,
          ...(a.options === true
            ? { agentOptions: { provider: process.env.PROBE_PROVIDER ?? 'local', model: process.env.PROBE_MODEL ?? 'qwen3.8-flash-next' } }
            : {}),
          ...(a.mount
            ? {
                setup: async (agentCtx) => { await ctx.get('agentPresets').mount(agentCtx, presetId) },
              }
            : {}),
        })
        out.ok = true
        out.handleKeys = Object.keys(handle ?? {}).slice(0, 8)
        try {
          const events = await ctx.sessionQuery?.listEvents?.(sessionId)
          out.durableEvents = Array.isArray(events) ? events.length : 'n/a'
          out.durableTypes = (events ?? []).slice(0, 6).map((e) => e.type ?? e?.data?.type ?? '?')
        } catch (error) { out.durableError = describeError(error) }
        // dispose is NOT best-effort here: the door disposes inside createChild, so a
        // SessionFormatError raised while the host FLUSHES pending rows escapes as
        // "child creation refused" and reads like a seed problem. Record it distinctly.
        try { await handle?.dispose?.() } catch (error) { out.disposeError = describeError(error) }
        try {
          const after = await ctx.sessionQuery?.listEvents?.(sessionId)
          out.durableAfterDispose = Array.isArray(after) ? after.length : 'n/a'
          out.typesAfterDispose = (after ?? []).slice(0, 8).map((e) => e.type ?? '?')
        } catch (error) { out.afterError = describeError(error) }
      } catch (error) {
        out.error = describeError(error)
        out.stack = String(error?.stack ?? '').split('\n').slice(1, 5).join(' | ')
        // the browser symptom: dir created, nothing in it but the lock
        try {
          const sessRoot = path.join(process.env.DSH_HOME ?? '', 'sessions')
          const hit = []
          for (const ws of fs.existsSync(sessRoot) ? fs.readdirSync(sessRoot) : []) {
            const p = path.join(sessRoot, ws, sessionId)
            if (fs.existsSync(p)) hit.push(fs.readdirSync(p).join(','))
          }
          out.sessionDir = hit.length > 0 ? hit.join(' ; ') : 'absent'
        } catch (error) { out.dirError = describeError(error) }
      }
      out.ms = Date.now() - t0
      record(out)
    }

    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(0)
  })().catch((error) => {
    report.fatal = describeError(error)
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    process.exit(1)
  })
}
