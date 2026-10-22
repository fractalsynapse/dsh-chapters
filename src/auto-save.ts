/**
 * Door 5 — subagent settlement auto-save (issue #47).
 *
 * The host publishes a `subagent/end` lifecycle event for every settled child
 * run (one-shot AND each residency epoch of a continuable child). This module
 * turns each such settlement of a chapters-preset child into an archive through
 * the SHARED save core (src/save-core.ts) — the same pipeline `/chapters-save`
 * runs, never a second implementation.
 *
 * The seam facts this leans on are MEASURED, not assumed
 * (spikes/subagent-end/FINDINGS.md, host-subagent-seam drift rows):
 *   - `end` fires synchronously from a microtask attached at spawn, strictly
 *     BEFORE the run holder's dispose continuation → a SYNCHRONOUS snapshot
 *     inside the listener sees the live child's complete log and header.
 *   - the child header is durable kernel state (`childSessionMeta`):
 *     `origin: 'subagent'`, `parentSession`, `agentPreset`, `delegationDepth`.
 *     The gate reads the HEADER, never an event scan (a synthetic child can
 *     complete turns without ever carrying `agent-preset/selected` — measured).
 *   - fallback arm: `sessionQuery.listEvents` + `listSessions` headers are
 *     ambient-readable after disposal (not capability-gated) — used only when
 *     the live handle is gone at emit.
 *
 * Containment is the signature-listener discipline: the emitter catches listener
 * throws by contract, but we ALSO never let one lose knowledge silently — every
 * non-archive is either a quiet, expected skip (wrong preset, no completed turn)
 * or a LOUD warn (unreadable, save failed).
 */
import { diagnosticWarn } from './diag.ts'
import { saveSession, type SaveSessionConfig } from './save-core.ts'
import { lineageOf, type SessionEventLike } from './types.ts'
import type { RegistryStore } from './store.ts'

/** What `subagent/end` carries — the published `SubagentRunEndInfo` subset we read. */
export interface SubagentEndInfoLike {
  /** The child agent's id — a durable session id for local (in-process) runs. */
  id?: string
  runId?: string
  provider?: string
  stopReason?: string
}

export interface AutoSaveChildHeader {
  id?: string
  cwd?: string
  parentSession?: string
  origin?: string
  agentPreset?: string
}

export interface AutoSaveChildView {
  events: SessionEventLike[]
  header: AutoSaveChildHeader
}

export interface AutoSaveDeps {
  /** The preset id a child must carry to be archived (CHAPTERS_PRESET_ID in production). */
  presetId: string
  /** Synchronous live read at emit time (host `agents.get(id)`); undefined when gone. */
  liveChild: (sessionId: string) => AutoSaveChildView | undefined
  /** Durable fallback when the live handle is gone; undefined when unreadable. */
  durableChild?: ((sessionId: string) => Promise<AutoSaveChildView | undefined>) | undefined
  /** The archive itself — saveSession in production, injected for containment tests. */
  save: (child: AutoSaveChildView) => Promise<{ archived: number; skipped: string | null }>
  warn: (message: string) => void
  /** Observability seam: what each settlement decided. Outcome vocabulary pinned by tests. */
  onSettled?: ((sessionId: string, outcome: string) => void) | undefined
}

const hasCompletedTurn = (events: readonly SessionEventLike[]): boolean =>
  events.some((e) => e.type === 'turn/end')

/**
 * The listener factory. Pure against injected reads — the real pipeline is wired
 * by `wireSubagentAutoSave` below, and both are covered by
 * tests/{unit,integration} rows. The callback itself is SYNCHRONOUS on the
 * snapshot (that is the race-avoidance), chained asynchronously per child.
 */
export function makeSubagentEndListener(deps: AutoSaveDeps): (info: SubagentEndInfoLike) => void {
  // Per-child promise chain: repeated settlements of the SAME child serialize
  // (the watermark makes the second save only see the first's records); distinct
  // children never queue against each other. Same pattern as the signature listener.
  const chains = new Map<string, Promise<void>>()
  return (info) => {
    try {
      const id = info?.id
      if (typeof id !== 'string' || id === '') {
        deps.warn('subagent auto-save: settlement event without a child session id — nothing archived')
        return
      }
      // --- synchronous snapshot NOW: `end` strictly precedes disposal (measured).
      let view: AutoSaveChildView | undefined
      try {
        view = deps.liveChild(id)
      } catch (error) {
        deps.warn(`subagent auto-save: live read failed for ${id}: ${String((error as Error)?.message ?? error)}`)
        view = undefined
      }
      const hadLiveHandle = view !== undefined
      const job = async (): Promise<void> => {
        let arm = 'live'
        if (view === undefined && deps.durableChild !== undefined) {
          try {
            view = await deps.durableChild(id)
            arm = 'durable'
          } catch (error) {
            deps.warn(`subagent auto-save: durable read failed for ${id}: ${String((error as Error)?.message ?? error)}`)
          }
        }
        if (view === undefined) {
          deps.warn(`subagent auto-save: child ${id} unreadable at settlement (live handle ${hadLiveHandle ? 'read failed' : 'gone'}${deps.durableChild === undefined ? ', no durable arm available' : ', durable read empty'}) — its knowledge was NOT archived`)
          deps.onSettled?.(id, 'skipped:unreadable')
          return
        }
        const suffix = arm === 'durable' ? '@durable' : ''
        // Gates, in the order the docs state. Expected skips are quiet: this fires
        // for EVERY subagent in the profile; a warn per non-chapters child would
        // bury the anomalies that need a human.
        if (view.header.origin !== 'subagent') {
          deps.onSettled?.(id, `skipped:origin${suffix}`)
          return
        }
        if (view.header.agentPreset !== deps.presetId) {
          deps.onSettled?.(id, `skipped:preset${suffix}`)
          return
        }
        if (!hasCompletedTurn(view.events)) {
          deps.onSettled?.(id, `skipped:no-completed-turn${suffix}`)
          return
        }
        try {
          const out = await deps.save(view)
          deps.onSettled?.(id, out.skipped === null ? `saved${suffix}` : `skipped:${out.skipped}${suffix}`)
        } catch (error) {
          deps.warn(`subagent auto-save: archiving ${id} failed: ${String((error as Error)?.message ?? error)} — its knowledge was NOT archived`)
          deps.onSettled?.(id, `failed${suffix}`)
        }
      }
      const prev = chains.get(id)
      const next = prev === undefined ? job() : prev.then(job)
      chains.set(id, next)
      void next.catch(() => undefined).finally(() => { if (chains.get(id) === next) chains.delete(id) })
    } catch (error) {
      // never-break containment, twice: the emitter catches us, we catch ourselves.
      deps.warn(`subagent auto-save listener threw (contained): ${String((error as Error)?.message ?? error)}`)
    }
  }
}

// ------------------------------------------------------------------ wiring

/** The kernel Session surface the live read needs (structural). */
interface SessionLike {
  snapshotEvents(): readonly unknown[]
  header?: AutoSaveChildHeader
}

/** A minimal slice of the host ctx the wiring reads (structural, cordis-free). */
export interface AutoSaveCtx {
  get?(name: string): unknown
  logger?: { info?(m: string): void; warn?(m: string): void }
}

export interface AutoSaveWiring extends SaveSessionConfig {
  presetId: string
  /** §5 sync scheduler: every archive is a push point. */
  scheduler?: { schedule(cwd: string, reason: string): void } | undefined
}

/**
 * Bind the listener to the host-plane services: `agents` for the live read,
 * `sessionQuery` for the durable fallback, `saveSession` for the archive.
 * Returns the callback to register with `ctx.on('subagent/end', …)`.
 *
 * ENRICHMENT DELIBERATELY ABSENT: settlement never runs the annotator — a
 * ten-child fanout must not fire ten LLM drains; new chapters are pending work
 * for the idle/afterPush ladders exactly like a `/chapters-save` that skipped
 * the manual nudge. A test pins that nothing here calls runNow.
 */
export function wireSubagentAutoSave(
  ctx: AutoSaveCtx,
  store: RegistryStore,
  wiring: AutoSaveWiring,
): (info: SubagentEndInfoLike) => void {
  const warn = (message: string): void => {
    // #54: the shared seam (logger warn + sink), not a second copy of the same three lines.
    diagnosticWarn(ctx.logger, 'auto-save', message)
  }
  const liveChild = (sessionId: string): AutoSaveChildView | undefined => {
    const agents = ctx.get?.('agents') as { get?(id: string): unknown } | undefined
    const handle = agents?.get?.(sessionId) as { agent?: { session?: SessionLike }; session?: SessionLike } | undefined
    const session = handle?.agent?.session ?? handle?.session
    if (session === undefined || typeof session.snapshotEvents !== 'function') return undefined
    return { events: [...session.snapshotEvents()] as SessionEventLike[], header: (session.header ?? {}) as AutoSaveChildHeader }
  }
  const durableChild = async (sessionId: string): Promise<AutoSaveChildView | undefined> => {
    const sq = ctx.get?.('sessionQuery') as { listEvents?(id: string): Promise<SessionEventLike[]>; listSessions?(signal?: unknown): Promise<Array<{ header?: AutoSaveChildHeader }>> } | undefined
    if (sq?.listEvents === undefined || sq.listSessions === undefined) return undefined
    const events = await sq.listEvents(sessionId)
    if (!Array.isArray(events) || events.length === 0) return undefined
    const records = await sq.listSessions()
    const header = (records ?? []).find((r) => r?.header?.id === sessionId)?.header
    if (header === undefined) return undefined
    return { events, header }
  }
  const save = async (child: AutoSaveChildView): Promise<{ archived: number; skipped: string | null }> => {
    const cwd = child.header.cwd
    if (cwd === undefined || cwd === '') throw new Error('subagent child session has no workspace cwd — nowhere reachable to write')
    const out = await saveSession({
      events: child.events,
      sessionId: child.header.id ?? '',
      cwd,
      store,
      config: wiring,
      subagentOf: lineageOf(child.header),
    })
    if (out.skipped === null && out.records.length > 0 && wiring.scheduler !== undefined && cwd !== '') {
      wiring.scheduler.schedule(cwd, 'archive:autoSave')
    }
    return { archived: out.records.length, skipped: out.skipped }
  }
  return makeSubagentEndListener({
    presetId: wiring.presetId,
    liveChild,
    durableChild,
    save,
    warn,
    onSettled: (id, outcome) => { ctx.logger?.info?.(`dsh-chapters: subagent ${id} settled → ${outcome}`) },
  })
}
