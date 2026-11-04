/**
 * The Suggested Next Step runner: one generation per completed turn (#113).
 *
 * Modelled on `makeChildArchiveListener` on purpose — that is the door this repo already trusts for
 * "fire at the turn boundary, read the live session, be watermark-idempotent, never let one failure take
 * the chain down". Per-session work is serialized on a promise chain so two turn/end events cannot
 * interleave a read-analyze-write against the same row, which is the #59 class of bug in a new costume.
 *
 * What it persists is the bar's contract from `docs/contract.md`: `analyzing` is written BEFORE the model is
 * called, so a pull during the call shows the human honest progress instead of a stale offer; the outcome
 * then replaces it. A quiet refusal (`nothing to recommend yet`) is `off`, not `failed` — silence and
 * failure are different states, and collapsing them was defect #2 of the removed ghost.
 */
import type { SessionEventLike } from './types.ts'
import { isHumanAuthored, stripReminderSpans } from './injections.ts'
import { classifyOffer, noSuggestion, type PromptSuggestionState } from './prompt-state.ts'
import type { SessionState } from './registry.ts'

/**
 * #289: was this offer ALREADY SENT? Deterministic, model-free, durable-log-only: the row's offer
 * text, normalized, equal to a HUMAN-authored `user/message` that arrived AFTER the offer was born.
 * The exact case is the whole rule — fuzzy similarity would invent retirements, and a suggestion
 * the human rewrote into their own words is a NEW instruction, not this offer running. Narration is
 * excluded by `isHumanAuthored` (the ONE predicate, #59): the bar's authored autorun message, goal
 * rounds, and host injections are not the human sending it. Reminder spans are stripped before
 * comparing, because the host wraps a real keystroke in them.
 *
 * Who retired what: #285 made a successful Run consume its offer; this covers offers the human sent
 * outside Run (typed, or Run on a version that predated consumption — the maintainer's row 4036,
 * sent twice pre-update and re-rendered forever after it). Read together, an offer that ran cannot
 * be served again from ANY surface, even if the boundary door is dead.
 */
export function deliveredOffer(session: unknown, offer: PromptSuggestionState): boolean {
  if (offer.status !== 'ready' || offer.text === '') return false
  const s = session as { events?: readonly SessionEventLike[]; snapshotEvents?: () => readonly SessionEventLike[]; header?: Record<string, unknown> } | undefined
  const events = Array.isArray(s?.events) ? s?.events : (typeof s?.snapshotEvents === 'function' ? s.snapshotEvents() : undefined)
  if (!Array.isArray(events)) return false
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const want = norm(offer.text)
  if (want === '') return false
  const bornAt = offer.turnSeq ?? Number.NEGATIVE_INFINITY
  for (const ev of events) {
    if (ev.type !== 'user/message') continue
    if (typeof ev.seq === 'number' && ev.seq <= bornAt) continue
    const data = (ev.data ?? {}) as Record<string, unknown>
    if (!isHumanAuthored(data)) continue
    const message = (data.message ?? data) as Record<string, unknown>
    const blocks = Array.isArray(message.content) ? message.content as { type?: string; text?: string }[] : []
    const text = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('')
    if (norm(stripReminderSpans(text).text) === want) return true
  }
  return false
}

export interface GenerateOutcome {
  ok: boolean
  text?: string
  /** #113: the goal revision this offer was generated against (null = no goal). A later edit bumps it, and
   * an outstanding offer made under the OLD revision must not run — that is how a re-cut objective interrupts
   * the loop instead of being bulldozed by last cycle's directive. */
  goalRevision?: number | null
  /** Present when !ok && !quiet: what actually went wrong. */
  reason?: string
  /** True for "there is nothing to recommend yet" — stored as `off`, never as an error. */
  quiet?: boolean
}

export interface PromptRunnerDeps {
  /** The model IS the switch: false ⇒ the door is inert and writes nothing at all. */
  enabled: () => boolean
  /** Session eligibility: root, interactive, preset-mounted. Headless children never pay the call. */
  eligible: (session: { id: string; header?: Record<string, unknown> }) => boolean
  store: { mutate(sessionId: string, fn: (state: SessionState) => SessionState): Promise<unknown> }
  generate: (session: { id: string; header?: Record<string, unknown> }, turnSeq: number) => Promise<GenerateOutcome>
  /**
   * Called after a `ready` offer is durably written, with the state as written. The autorun loop rides this
   * rather than polling the row: firing on a persisted offer is what makes "the offer the human would have
   * seen" and "the offer that ran" the same fact, and a loop that fires from its own memory can outrun the
   * row it is supposed to be showing.
   */
  onReady?: (sessionId: string, state: PromptSuggestionState) => void
  /** #194: mirror every durable row write to the push transport. The wiring owns payload assembly
   * and ordering; the runner only reports (session, id) at each write. Failures here must never
   * affect the round — the pull schedule and its staleness confirm cover a dead push. */
  pushRow?: (session: unknown, sessionId: string) => void
  now: () => string
  log?: (message: string) => void
  warn?: (message: string) => void
}

export function makePromptRoundRunner(deps: PromptRunnerDeps): (session: { id: string; header?: Record<string, unknown> }, event: unknown) => void {
  const chains = new Map<string, Promise<void>>()
  const section = (id: string, job: () => Promise<void>): void => {
    const prev = chains.get(id) ?? Promise.resolve()
    const next = prev.then(job, job)
    chains.set(id, next.then(() => undefined, () => undefined))
  }
  const write = async (id: string, next: PromptSuggestionState): Promise<void> => {
    await deps.store.mutate(id, (row) => ({ ...row, promptSuggestion: next }))
  }

  return (session, event) => {
    try {
      const ev = event as { type?: string; seq?: number } | undefined
      if (ev?.type !== 'turn/end' || typeof ev.seq !== 'number') return
      // Each early return NAMED, because "the bar never updates" has three different causes and only one of
      // them is a switch the human set. Silent guards are how tonight took a day.
      if (!deps.enabled()) { deps.log?.('prompt: not enabled (no defining model) — round skipped'); return }
      if (!deps.eligible(session)) { deps.log?.(`prompt: session ${String(session.id)} not eligible — round skipped`); return }
      const id = session.id
      const turnSeq = ev.seq
      section(id, async () => {
        // Claim the turn inside the mutate: the row is the only place "have I already done this turn?" can
        // be answered after a restart, and the decision must see the LIVE row, not a snapshot.
        let claimed = false
        await deps.store.mutate(id, (row) => {
          const cur = row.promptSuggestion ?? noSuggestion
          const inFlightForThisTurn = cur.turnSeq === turnSeq && (cur.status === 'analyzing' || cur.status === 'ready' || cur.status === 'failed')
          if (inFlightForThisTurn) { claimed = false; return row }
          claimed = true
          return { ...row, promptSuggestion: { ...noSuggestion, status: 'analyzing', turnSeq, at: deps.now() } }
        })
        if (!claimed) { deps.log?.(`prompt: turn ${String(turnSeq)} already claimed for ${id}`); return }
        deps.pushRow?.(session, id)
        try {
          const out = await deps.generate(session, turnSeq)
          if (out.ok && typeof out.text === 'string' && out.text !== '') {
            // Classified HERE, at the moment of authorship: intent is a property of the durable offer, so the
            // bar, the `state` verb and the loop read the same fact instead of re-parsing the text three ways
            // (one predicate per decision, #59). The `GOAL:` prefix is stripped — the worker must never be
            // handed protocol scaffolding as if it were the human's own words.
            const offer = classifyOffer(out.text)
            const ready: PromptSuggestionState = {
              status: 'ready', text: offer.text, turnSeq, error: '', at: deps.now(),
              intent: offer.intent, goalRevision: out.goalRevision ?? null,
            }
            await write(id, ready)
            deps.pushRow?.(session, id)
            deps.log?.(`prompt: recommended next step ready for ${id} (turn ${String(turnSeq)}, ${offer.intent})`)
            deps.onReady?.(id, ready)
            return
          }
          if (out.quiet === true) {
            await write(id, { ...noSuggestion, turnSeq: null })
            deps.pushRow?.(session, id)
            deps.log?.(`prompt: nothing to recommend for ${id} — bar stays silent`)
            return
          }
          await write(id, { ...noSuggestion, status: 'failed', turnSeq, error: out.reason ?? 'the suggestion call returned nothing', at: deps.now() })
          deps.pushRow?.(session, id)
          deps.warn?.(`prompt: generation failed for ${id}: ${out.reason ?? 'unknown'}`)
        } catch (error) {
          // A failed generation is a DELIVERED failure (#61): the bar shows it, it does not vanish.
          const message = String((error as Error)?.message ?? error).slice(0, 200)
          await write(id, { ...noSuggestion, status: 'failed', turnSeq, error: message, at: deps.now() }).catch(() => undefined)
          deps.pushRow?.(session, id)
          deps.warn?.(`prompt: generation threw for ${id}: ${message}`)
        }
      })
    } catch (error) {
      deps.warn?.(`prompt: turn listener failed: ${String((error as Error)?.message ?? error).slice(0, 160)}`)
    }
  }
}
