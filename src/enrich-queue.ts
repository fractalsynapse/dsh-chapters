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
  /** #565: drain ALL pending (or at most `limit`) in chained capped passes, in the BACKGROUND.
   *  Returns immediately with what was started; single-flight (a second call reports the running
   *  drain and starts nothing). Failure-stops / short-pass-ends / dispose-ends — same rules as #529. */
  drainAll: (limit?: number) => { started: boolean; alreadyRunning: boolean; pendingEstimate: number }
  /** #565: is a full drain currently running (the report surface prints its state). */
  isDraining: () => boolean
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
  const nextHead = async (): Promise<string | undefined> => {
    try { const p = await deps.listPending(modelCache ?? 'peek', 1); return p[0]?.key } catch { return undefined }
  }
  let fullDrain: Promise<void> | null = null
  let disposed = false

  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms)
    return { cancel: () => clearTimeout(t) }
  })

  const drain = (forced = false, capOverride?: number): Promise<number> => {
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
        const cap = Math.min(deps.batchCap, capOverride ?? deps.batchCap) // #565: run <n> ends EXACTLY at n
        const pending = await deps.listPending(model, cap)
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
        // #529: a full batch means the cap clipped the backlog — chase. A partial batch means
        // the queue is empty — nothing to schedule. The honest read of pending.length vs done,
        // not an estimate, because this is the last place the real numbers exist.
        if (done > 0 && pending.length >= cap) scheduleChase()
        return done
      } catch (error) {
        deps.log(`enrichment drain failed (kept silent for the user): ${String(error)}`)
        stopChase() // #529: a chase against a failing model would hammer it — stop, let the next event restart
        return 0
      } finally {
        draining = null
      }
    })()
    return draining
  }

  // #529: BACKLOG CHASE. A drain that leaves pending work schedules its own follow-up, at a
  // fixed modest spacing, until the queue is empty. The maintainer's directive: enrichment runs
  // on ALL non-enriched chapters whenever a new chapter is created, directly after, if a model
  // is set — and the measured defect was that busy self-driving sessions NEVER idle, so the
  // idle sweeper starved the backlog for hours. batchCap stays per pass (memory discipline
  // unchanged); only the WAITING changes. Failure paths stop the chase (the batchCap-less loop
  // against a broken model would hammer it); dispose cancels it; nothing here outlives the realm.
  let chaseTimer: { cancel: () => void } | null = null
  const CHASE_SPACING_MS = 5_000
  const stopChase = (): void => { chaseTimer?.cancel(); chaseTimer = null }
  const scheduleChase = (): void => {
    if (!deps.enabled || deps.trigger === 'manual') return
    stopChase()
    chaseTimer = setTimer(() => {
      chaseTimer = null
      void drain().then((done) => { if (done > 0) scheduleChase() })
    }, CHASE_SPACING_MS)
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
    // #565: FULL DRAIN (maintainer decision, overriding the one-batch manual design): chained
    // capped passes until the queue comes back short — per-pass batchCap UNCHANGED (memory
    // discipline), the CHAINING is what changed. Runs in the background: the command returns the
    // pending it started with, and `report` follows the number down. A failing pass ends the
    // pump (drain() returns 0 on failure and logs why — never hammer a broken model); a short
    // or empty pass ends it naturally; dispose ends it. Single-flight: a second run while
    // draining reports that and starts nothing, so two operators can never double-pump the model.
    drainAll: (limit?: number) => {
      if (!deps.enabled) {
        deps.log('enrichment drain skipped: disabled (enrichmentEnabled=false)')
        return { started: false, alreadyRunning: false, pendingEstimate }
      }
      if (fullDrain !== null) return { started: false, alreadyRunning: true, pendingEstimate }
      const budget = limit !== undefined && limit > 0 ? limit : Number.POSITIVE_INFINITY
      let processed = 0
      let passes = 0
      let lastHead: string | undefined
      fullDrain = (async () => {
        while (!disposed && processed < budget) {
          const head = await nextHead()
          if (head !== undefined && head === lastHead) {
            // #565 circuit-breaker: the ladder claimed success but the SAME chapter is still at
            // the head — pending is not shrinking. A chained pump against a non-depleting queue
            // would spin the model forever; stop loudly instead. (The unit fake that never shrinks
            // found this the day the feature shipped — the class is real: an enrichment that
            // writes but whose re-qualification key never settles is exactly this shape.)
            deps.log(`enrichment full drain STOPPED: head ${head} unchanged after a successful pass — pending is not shrinking; investigate before re-running`)
            break
          }
          lastHead = head
          const done = await drain(true, Number.isFinite(budget) ? budget - processed : undefined)
          if (done === 0) break // empty, failing, or model-unresolvable — drain() names which
          processed += done
          passes += 1
          stopChase() // a boundary chase is redundant under a full drain — one pump at a time
        }
        deps.log(`enrichment full drain ended: ${processed} chapter(s) across ${passes} pass(es)`)
      })().finally(() => { fullDrain = null })
      return { started: true, alreadyRunning: false, pendingEstimate }
    },
    isDraining: () => fullDrain !== null,
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
    dispose: () => { disposed = true; idleTimer?.cancel(); idleTimer = null; stopChase() }, // #565: the full drain loop checks disposed
  }
}
