/**
 * Autorun: the suggestion loop that starts the next real turn (#113).
 *
 * This is the piece that makes the feature a loop rather than a widget, and it is deliberately built out of
 * the host goal driver's own observed semantics:
 *   - the flag is **process-local** and starts disarmed, so a restart cannot resurrect a loop
 *     (`dsh-goal-round-driver` disarms every agent on mount; a re-arm is an explicit human act);
 *   - the next turn is started with the agent's own `followup`, which is how the goal round chains turns —
 *     no timers, no private queue, nothing that can drift from the agent's real idle state;
 *   - a human message **disarms** it. The host's driver only defers in that case; here the human said
 *     "stop", because the maintainer's rule is that autorun runs "until the user stops it".
 *
 * The authored message carries our producer kind and its own form, so it is captured as conversation by
 * `isSessionStateNarration` yet can never be mistaken for a human turn — the host's goal tool decides
 * "direct human turn" by `source.kind === 'user'`, so authoring as `user` would hand this loop authority to
 * pause and resume goals. It also never uses `source.kind: 'goal'`: an invariant companion deep-equals every
 * goal-sourced message against the host's own template, so impersonating it is a loud failure by design.
 */
import { assertKernelAcceptedUserMessage } from './notice.ts'
import { goalDriverOwnsTheTurn, type GoalSignal } from './prompt-state.ts'
import type { PromptSuggestionState } from './prompt-state.ts'

export type AutorunFlag = 'armed' | 'disarmed'

export interface PromptLoopDeps {
  /**
   * Stop the goal driver re-injecting its own round while KEEPING the goal durable and unchanged
   * (`GoalService.disarm` — "without changing durable goal phase or revision"). Optional: if the seam is
   * absent the loop falls back to yielding the turn, so a missing host verb degrades safely instead of
   * starting two turns at one boundary.
   */
  displaceGoal?: (sessionId: string) => boolean
  /** live-session authoring: the runner supplies the agent handle it was given at the turn boundary. */
  followup: (sessionId: string, text: string) => void
  /** counts only FIRED rounds, so a suggestion nobody armed never spends the budget. */
  maxRounds: () => number
  /** The LIVE goal signal for a session, from the goal service. Optional: absent means "no goal read", and
   * the loop then behaves as if there is no goal — never as if a goal is armed. */
  goalSignal?: (sessionId: string) => GoalSignal | null
  now?: () => string
  log?: (message: string) => void
  warn?: (message: string) => void
}

export interface PromptLoop {
  statusOf(sessionId: string): { autorun: AutorunFlag; fired: number }
  /** The human's `/chapters-prompt autorun on|off`. Arming does not fire anything by itself. */
  /**
   * The human's `/chapters-prompt autorun on|off`. Arming fires nothing by itself — but it DOES displace the
   * goal's continuation, per the spec: prompt autorun "can either introduce or REPLACE the autorun by the
   * goal if it is running". My first pass yielded to an armed goal instead, which made the two features
   * mutually exclusive — with a goal armed, a director's autorun would have quietly done nothing.
   */
  setArmed(sessionId: string, on: boolean): { autorun: AutorunFlag; fired: number; displaced: boolean }
  /** A human took the wheel: disarm now, keep the offer visible, and say why. */
  disarmForHuman(sessionId: string): AutorunFlag
  /** Called after the runner persisted a `ready` offer. Fires at most one turn per offer. */
  /**
   * `goal` is the LIVE goal signal from the service, or null when there is no goal. Passing it in rather than
   * reading a cached copy is the point: activation is process-local and changes under us (a human pause, a
   * goal edit), and a loop that starts turns must decide against the current fact.
   */
  maybeFire(sessionId: string, state: PromptSuggestionState, goal?: GoalSignal | null): boolean
  /** `agent/created` and mount parity with the host driver: nothing arrives armed. */
  reset(sessionId: string): void
  /** The live goal signal, exposed so the door can pass it at the moment of firing (never a cached copy). */
  goalSignal(sessionId: string): GoalSignal | null
}

export function makePromptLoop(deps: PromptLoopDeps): PromptLoop {
  interface Slot { armed: AutorunFlag; fired: number; firedFor: number | null }
  const slots = new Map<string, Slot>()
  const slot = (id: string): Slot => {
    let s = slots.get(id)
    if (s === undefined) { s = { armed: 'disarmed', fired: 0, firedFor: null }; slots.set(id, s) }
    return s
  }
  const note = (m: string): void => { deps.log?.(m) }

  return {
    statusOf: (id) => { const s = slot(id); return { autorun: s.armed, fired: s.fired } },

    setArmed(id, on) {
      const s = slot(id)
      s.armed = on ? 'armed' : 'disarmed'
      // Displace, do not defer. One loop owns the next turn: whichever the human armed last.
      let displaced = false
      if (on && deps.displaceGoal !== undefined) {
        try { displaced = deps.displaceGoal(id) === true } catch (error) {
          deps.warn?.(`prompt: could not disarm the goal driver for ${id}: ${String((error as Error)?.message ?? error).slice(0, 120)}`)
        }
      }
      // Arming mid-offer is allowed to fire for the offer already on screen: the human said "keep going
      // from here", and making them wait for the next turn boundary is the difference between a loop and a
      // poller. Re-arming does NOT reset the budget — that is what stops it being an infinite bypass.
      note(on
        ? `prompt: autorun armed for ${id} — ${displaced
            ? "goal continuation DISARMED (objective unchanged); the suggestion loop drives the worker"
            : 'the goal keeps its own continuation; this loop yields the turn to it'}`
        : `prompt: autorun disarmed for ${id} (${String(s.fired)} round(s) spent of ${String(deps.maxRounds())})`)
      return { autorun: s.armed, fired: s.fired, displaced }
    },

    disarmForHuman(id) {
      const s = slot(id)
      if (s.armed === 'disarmed') return s.armed
      s.armed = 'disarmed'
      note(`prompt: autorun disarmed for ${id} — a human prompt took the wheel`)
      return s.armed
    },

    maybeFire(id, state, goal = null) {
      const s = slot(id)
      if (s.armed !== 'armed' || state.status !== 'ready' || state.text === '') return false
      // #113, the authority boundary the host drew: `GOAL:` offers RE-CUT the standing objective, and
      // dsh-tool-goal gates that on a direct human turn (`source.kind === 'user'` in the open turn). Our
      // autorun message is plugin-authored, so running it would either be refused mid-turn or — if we
      // faked the kind — escalate the loop into authority it was never given. Hold it for the keystroke
      // and SAY so, rather than trying.
      if (state.intent === 'goal-edit') {
        deps.log?.(`prompt: NOT auto-run for ${id} — this step re-cuts the goal, which needs your keystroke (Run)`)
        return false
      }
      // One turn-starter per boundary. The host driver queues its own round when the goal is active AND
      // armed; two loops following up at one idle edge is a race with the driver's reservation fence. We
      // keep generating (the director's eye stays open) and run nothing until the driver is not owning it.
      if (goalDriverOwnsTheTurn(goal)) {
        deps.log?.(`prompt: yielding the next turn to the goal driver for ${id} (goal active and armed) — offers continue, autorun does not`)
        return false
      }
      // A goal edit invalidates the offer made against the previous revision: do not push last cycle's
      // directive into an objective the human just re-cut.
      if (goal !== null && state.goalRevision !== null && goal.revision !== state.goalRevision) {
        deps.log?.(`prompt: dropping a stale offer for ${id} (generated against revision ${String(state.goalRevision)}, goal is now ${String(goal.revision)})`)
        return false
      }
      if (state.turnSeq === null) return false
      if (s.firedFor === state.turnSeq) return false // one turn per offer, never a retry storm
      // #188: the round budget is a governor for open-ended iteration, not a guillotine for a goal.
      // While a goal exists (active OR paused — paused may resume), the pursuit is bounded by the
      // GOAL's lifecycle: max_goal_rounds where the driver runs, complete/blocked/cleared where this
      // loop displaced it. The suggestion budget must never cut the pursuit off before the objective.
      // No goal, or a goal that reached a terminal phase: the budget applies exactly as before.
      const goalBoundsIt = goal !== null && (goal.phase === 'active' || goal.phase === 'paused')
      const cap = deps.maxRounds()
      if (!goalBoundsIt && s.fired >= cap) {
        s.armed = 'disarmed'
        deps.warn?.(`prompt: autorun stopped for ${id} after ${String(cap)} rounds (promptMaxRounds) — re-arm to continue`)
        return false
      }
      s.fired += 1
      s.firedFor = state.turnSeq
      deps.followup(id, state.text)
      note(`prompt: autorun fired round ${String(s.fired)} of ${String(cap)} for ${id} (turn ${String(state.turnSeq)})`)
      return true
    },

    goalSignal: (id) => (deps.goalSignal === undefined ? null : deps.goalSignal(id)),

    reset(id) {
      slots.set(id, { armed: 'disarmed', fired: 0, firedFor: null })
    },
  }
}

/**
 * The message the loop puts into the conversation, as kernel-admitted `user/message` data: our producer kind,
 * a published form, and an id so the row survives the host's own admission checks.
 *
 * `form: 'notice'` is a deliberate pick from the kernel's published `ContextForm` union
 * (`instructions|catalog|snapshot|notice|relay|recall`, `dsh-llm/lib/types/message.d.ts:46`), not an invented
 * word: my first version used `prompt-suggestion` and the shared assertion refused it at the authorship
 * boundary — which is exactly what that guard exists for. `snapshot` was unavailable in practice: it is the
 * TOC notice's own kind+form pair, and reusing it would have made the archive screen read suggestions as
 * notices of the archive. Reuses `notice.ts`'s
 * assertion rather than re-deriving the rules — one predicate for one decision (#59's lesson), and the
 * `host-seed-contract` row already drift-gates that transcription against the kernel itself.
 *
 * Deliberately NOT `kind: 'user'`: the host's goal tool decides "a direct human turn exists" by exactly that
 * (`dsh-tool-goal:49-65`), so a user-kinded suggestion would hand this loop the authority to pause and
 * resume goals. And never `kind: 'goal'`: an invariant companion deep-equals every goal-sourced message
 * against the host's own `<goal_round>` template, so impersonation fails loudly by design.
 */
export function suggestPromptMessage(text: string, id: string): Record<string, unknown> {
  const data = {
    id: `suggested-${id}`,
    role: 'user',
    source: { kind: 'plugin:dsh-chapters', form: 'notice' },
    content: [{ type: 'text', text }],
  }
  assertKernelAcceptedUserMessage({ type: 'user/message', seq: 0, data } as never)
  return data
}
