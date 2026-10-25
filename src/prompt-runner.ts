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
import { classifyOffer, noSuggestion, type PromptSuggestionState } from './prompt-state.ts'
import type { SessionState } from './registry.ts'

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
      if (!deps.enabled()) return
      if (!deps.eligible(session)) return
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
            deps.log?.(`prompt: recommended next step ready for ${id} (turn ${String(turnSeq)}, ${offer.intent})`)
            deps.onReady?.(id, ready)
            return
          }
          if (out.quiet === true) {
            await write(id, { ...noSuggestion, turnSeq: null })
            deps.log?.(`prompt: nothing to recommend for ${id} — bar stays silent`)
            return
          }
          await write(id, { ...noSuggestion, status: 'failed', turnSeq, error: out.reason ?? 'the suggestion call returned nothing', at: deps.now() })
          deps.warn?.(`prompt: generation failed for ${id}: ${out.reason ?? 'unknown'}`)
        } catch (error) {
          // A failed generation is a DELIVERED failure (#61): the bar shows it, it does not vanish.
          const message = String((error as Error)?.message ?? error).slice(0, 200)
          await write(id, { ...noSuggestion, status: 'failed', turnSeq, error: message, at: deps.now() }).catch(() => undefined)
          deps.warn?.(`prompt: generation threw for ${id}: ${message}`)
        }
      })
    } catch (error) {
      deps.warn?.(`prompt: turn listener failed: ${String((error as Error)?.message ?? error).slice(0, 160)}`)
    }
  }
}
