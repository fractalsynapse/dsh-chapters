/**
 * P2 S2 — the enrichment queue: one queue, pluggable triggers, hard idle
 * guarantee (record §6.2, plan decisions).
 *
 * Isomorphic factory (host plane + realm engine each own an instance, like
 * createSyncScheduler). Providers are the ONLY variance:
 *   afterPush  — schedule(reason) called after each completed sync pass
 *   idle       — a resettable debounce timer (enrichment.idleMs)
 *   both       — the default
 *   manual     — no auto triggers; the /chapters-enrich run command drains
 *
 * Invariants this module owns:
 *   - NEVER in a hot path: enrichOne is only reached from drain(), and
 *     drain() is only fired by trigger events that already completed the
 *     user's work (post-push) or by silence (idle) or a command.
 *   - Idempotency key = chapter number + rootSession + model. Re-enqueue
 *     after vocab change is NOT needed (vocab affects canonicalization at
 *     index build, not the model call); after a MODEL change it IS (key
 *     includes model, so the key naturally changes).
 *   - enabled:false ⇒ every entry point is a pure no-op (kill-switch exit
 *     criterion: the corpus stays fully functional, signatures-only).
 *   - Cross-plane double-run: the caller-supplied lock (store-dir, same
 *     pattern as sync's acquireLock) makes the realm + host queues safe on
 *     one workspace.
 */

export interface EnrichQueueDeps {
  /** enumerate chapters lacking current-model enrichment (cheap, durable-read only) */
  listPending: (model: string, cap: number) => Promise<{ key: string; label: string }[]>
  /** run the ladder for one chapter; must never throw (S1 core + persistence) */
  enrichOne: (key: string) => Promise<{ ok: boolean; skipped?: string }>
  /** current enrichment model id ('' = resolver said: conversation model — queue still needs a concrete string for keys) */
  resolveModel: () => Promise<string>
  enabled: boolean
  trigger: 'afterPush' | 'idle' | 'both' | 'manual'
  idleMs: number
  batchCap: number
  log: (msg: string) => void
  /** injectable timer for tests */
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void }
}

export interface EnrichQueue {
  /** a sync pass just completed (or any natural idle point) */
  onSyncDone: (reason: string) => void
  /** archive activity happened — resets the idle timer */
  noteActivity: () => void
  /** manual drain (command surface); returns processed count */
  drainNow: () => Promise<number>
  /** queue state for /chapters-status + reports */
  state: () => { enabled: boolean; trigger: string; pendingEstimate: number; lastBatch: number; model: string | null }
  dispose: () => void
}

export function createEnrichQueue(deps: EnrichQueueDeps): EnrichQueue {
  let idleTimer: { cancel: () => void } | null = null
  let draining: Promise<number> | null = null
  let lastBatch = 0
  let modelCache: string | null = null
  let pendingEstimate = 0

  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms)
    return { cancel: () => clearTimeout(t) }
  })

  const drain = (forced = false): Promise<number> => {
    // auto drains honor the trigger choice; a forced drain (the command /
    // manual surface) only honors the kill switch
    // #61a, and the reason this file exists in the release: a queue that decides not to work must
    // say WHICH decision it made. The `enrich` leg burned 420 s polling for ladder output while the
    // tape showed only the conversation and title requests and the sink had no enrichment line at
    // all — the queue knew (disabled? manual trigger? no model? nothing pending?) and told nobody.
    if (!deps.enabled) { deps.log('enrichment drain skipped: disabled (enrichmentEnabled=false)'); return Promise.resolve(0) }
    if (!forced && deps.trigger === 'manual') { deps.log('enrichment drain skipped: trigger=manual — only /chapters-enrich run drains it'); return Promise.resolve(0) }
    if (draining !== null) return draining // one batch at a time; requests collapse
    draining = (async () => {
      try {
        const model = await deps.resolveModel()
        modelCache = model
        if (model === '') { deps.log('enrichment drain skipped: no enrichment model resolvable'); return 0 }
        const pending = await deps.listPending(model, deps.batchCap)
        pendingEstimate = pending.length
        if (pending.length === 0) deps.log(`enrichment drain: pending=0 via ${model} (trigger=${deps.trigger}, idleMs=${String(deps.idleMs)})`)
        let done = 0
        for (const item of pending) {
          const r = await deps.enrichOne(item.key)
          if (r.ok) done++
          // Measured: the manual command reported `processed 0 chapter(s); 1 pending` and the sink
          // had nothing, because only successes were ever written. A skip IS a decision with a cause
          // (`skipped:` is the ladder's own label), and an unreported one turns a 420-second poll into
          // an argument — the third time today a queue knew and said nothing (#61a).
          else deps.log(`enrichment skipped ${item.key}: ${r.skipped ?? 'no reason given by the ladder'}`)
        }
        lastBatch = done
        if (done > 0) deps.log(`enrichment batch: ${done}/${pending.length} chapter(s) via ${model}`)
        return done
      } catch (error) {
        deps.log(`enrichment drain failed (kept silent for the user): ${String(error)}`)
        return 0
      } finally {
        draining = null
      }
    })()
    return draining
  }

  return {
    onSyncDone: (reason) => {
      if (!deps.enabled) return
      if (deps.trigger === 'afterPush' || deps.trigger === 'both') {
        deps.log(`enrichment scheduled after sync (${reason})`)
        void drain()
      }
    },
    noteActivity: () => {
      if (!deps.enabled || (deps.trigger !== 'idle' && deps.trigger !== 'both')) return
      idleTimer?.cancel()
      idleTimer = setTimer(() => { void drain() }, deps.idleMs)
    },
    drainNow: async () => {
      // same rule as `drain`: an entry point that returns zero names its reason, or the next
      // 420-second poll has nothing to read but a guess.
      if (!deps.enabled) { deps.log('enrichment drain skipped: disabled (enrichmentEnabled=false)'); return 0 }
      return await drain(true)
    },
    state: () => ({
      enabled: deps.enabled,
      trigger: deps.trigger,
      pendingEstimate,
      lastBatch,
      model: modelCache,
    }),
    dispose: () => { idleTimer?.cancel(); idleTimer = null },
  }
}
