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
import type { PromptSuggestionState } from './prompt-state.ts'

export type AutorunFlag = 'armed' | 'disarmed'

export interface PromptLoopDeps {
  /** live-session authoring: the runner supplies the agent handle it was given at the turn boundary. */
  followup: (sessionId: string, text: string) => void
  /** counts only FIRED rounds, so a suggestion nobody armed never spends the budget. */
  maxRounds: () => number
  now?: () => string
  log?: (message: string) => void
  warn?: (message: string) => void
}

export interface PromptLoop {
  statusOf(sessionId: string): { autorun: AutorunFlag; fired: number }
  /** The human's `/chapters-prompt autorun on|off`. Arming does not fire anything by itself. */
  setArmed(sessionId: string, on: boolean): { autorun: AutorunFlag; fired: number }
  /** A human took the wheel: disarm now, keep the offer visible, and say why. */
  disarmForHuman(sessionId: string): AutorunFlag
  /** Called after the runner persisted a `ready` offer. Fires at most one turn per offer. */
  maybeFire(sessionId: string, state: PromptSuggestionState): boolean
  /** `agent/created` and mount parity with the host driver: nothing arrives armed. */
  reset(sessionId: string): void
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
      // Arming mid-offer is allowed to fire for the offer already on screen: the human said "keep going
      // from here", and making them wait for the next turn boundary is the difference between a loop and a
      // poller. Re-arming does NOT reset the budget — that is what stops it being an infinite bypass.
      note(`prompt: autorun ${on ? 'armed' : 'disarmed'} for ${id} (${String(s.fired)} round(s) spent of ${String(deps.maxRounds())})`)
      return { autorun: s.armed, fired: s.fired }
    },

    disarmForHuman(id) {
      const s = slot(id)
      if (s.armed === 'disarmed') return s.armed
      s.armed = 'disarmed'
      note(`prompt: autorun disarmed for ${id} — a human prompt took the wheel`)
      return s.armed
    },

    maybeFire(id, state) {
      const s = slot(id)
      if (s.armed !== 'armed' || state.status !== 'ready' || state.text === '') return false
      if (state.turnSeq === null) return false
      if (s.firedFor === state.turnSeq) return false // one turn per offer, never a retry storm
      const cap = deps.maxRounds()
      if (s.fired >= cap) {
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
