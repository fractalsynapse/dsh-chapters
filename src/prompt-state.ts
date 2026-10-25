/**
 * Reading the session's goal, so a suggestion can serve it (#113).
 *
 * The durable-log shape is measured, not assumed — from a live session's own `goal/change` events:
 *   { kind:'goal/change', version:1, operation:'create'|'resume'|'pause'|…,
 *     goal:{ id, revision, objective, phase:'active'|'paused'|…, maxGoalRounds } }
 * and goal rounds themselves arrive as `user/message` with `source.kind:'goal'` carrying
 * `{goalId, revision, round}`. So the goal is readable from the log with no service dependency, which is how
 * this plugin works everywhere else (durable reads, never a guessed API).
 *
 * Why it matters: a suggested next step that ignores an active goal is noise. The maintainer's rule is that
 * the two compose — the suggestion runs alongside the goal and the loop yields when the purpose ends.
 */
import type { SessionEventLike } from './types.ts'

export type GoalPhaseView = 'none' | 'active' | 'paused' | 'blocked' | 'complete'

export interface ActiveGoal {
  id: string
  revision: number
  objective: string
  phase: GoalPhaseView
  maxGoalRounds: number | null
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * The newest goal declaration in the events, or null when the session has no goal.
 *
 * A malformed or partial row is SKIPPED rather than thrown on: this is host-authored data crossing a plugin
 * boundary, and one unexpected row must not take the bar (or the archive) down with it.
 *
 * The operation vocabulary is now established from the shipped types — `GoalOperation =
 * 'create'|'edit'|'pause'|'resume'|'complete'|'block'|'clear'` (`dsh-goal/lib/types/domain.d.ts:12`) — so
 * `clear` (which carries `cleared: GoalRef`, not `goal`) is the real terminal removal. `delete`/`remove` are
 * still accepted defensively: when I first wrote this I could not see the type, and a reader should not have
 * to trust that a host rename would not silently resurrect a finished goal.
 *
 * LIVE reads should prefer the host's own accessors over this fold — `ctx.get('goals').get(agent)` for a
 * `GoalView` (which also carries `roundsStarted` and the process-local `activation`), or
 * `ctx.sessionProjections.stateOf(session,'goal')` the way `tools.ts` already reads `agentPreset`. This
 * function exists for the paths that have only the log: repair, distill, and tests.
 */
export function readActiveGoal(events: readonly SessionEventLike[]): ActiveGoal | null {
  let current: ActiveGoal | null = null
  for (const ev of events) {
    if (ev.type !== 'goal/change') continue
    const data = (ev.data ?? {}) as Record<string, unknown>
    const operation = isStr(data.operation) ? data.operation : ''
    if (operation === 'clear' || operation === 'delete' || operation === 'remove') { current = null; continue }
    const goal = (data.goal ?? {}) as Record<string, unknown>
    if (!isStr(goal.id) || !isStr(goal.objective)) continue
    const rawPhase = isStr(goal.phase) ? goal.phase : 'active'
    const phase: GoalPhaseView = rawPhase === 'paused' ? 'paused'
      : rawPhase === 'blocked' ? 'blocked'
      : rawPhase === 'complete' ? 'complete'
      : 'active'
    const merged: ActiveGoal = {
      id: goal.id,
      revision: Number.isFinite(goal.revision as number) ? (goal.revision as number) : (current?.revision ?? 0),
      objective: goal.objective,
      // A later terminal phase must not be resurrected by an unrelated row: complete is sticky per id.
      phase: current !== null && current.id === goal.id && current.phase === 'complete' ? 'complete' : phase,
      maxGoalRounds: Number.isFinite(goal.maxGoalRounds as number) ? (goal.maxGoalRounds as number) : null,
    }
    current = operation === 'complete' ? { ...merged, phase: 'complete' } : merged
  }
  return current === null || current.phase === 'complete' ? null : current
}

/** Whether the autorun loop still has a purpose to serve: armed means run on, anything else means stand down. */
export function goalAuthorizesAutorun(goal: ActiveGoal | null): boolean {
  return goal !== null && goal.phase === 'active'
}

/**
 * The goal block folded into the suggestion input. Written as a constraint on the NEXT step, not a restated
 * objective: the model already has the conversation, and what it cannot see is that a goal governs this one.
 */
export function goalDirectiveOf(goal: ActiveGoal | null): string {
  if (goal === null) return 'No goal is active for this session. Recommend the next step the work itself calls for.'
  return [
    `An ACTIVE GOAL governs this session (revision ${String(goal.revision)}): ${goal.objective.slice(0, 600)}`,
    'The recommended next step MUST advance that goal — a step that merely continues current work does not count.',
    'If the goal is already accomplished, recommend the step that closes it out (mark it complete) rather than another round.',
  ].join('\n')
}

/**
 * The bar's durable facts, as stored on the session row (#113). `turnSeq` is the identity of an offer:
 * it is the `turn/end` seq the suggestion was generated FOR, which is what makes "one generation per
 * turn" idempotent across a re-delivered event, a restart, or a second pull by the client.
 *
 * Deliberately absent: `autorun` and `expanded`. Those are the client's process-local intent — the goal
 * bar's `activation` in everything but name — and persisting them would let a loop resume itself across a
 * restart, which is the property the host's goal driver explicitly does NOT have.
 */
export interface PromptSuggestionState {
  status: 'off' | 'analyzing' | 'ready' | 'failed'
  text: string
  turnSeq: number | null
  error: string
  at: string
  /** #113: what kind of step this is. `goal-edit` re-cuts the standing objective, which the host reserves for
   * a human turn, so autorun must never act on it. Measured: `dsh-tool-goal`'s `requireDirectHuman` gates
   * create/edit/pause/resume on `source.kind === 'user'` in the open turn. */
  intent: 'worker-step' | 'goal-edit'
  /** The goal `revision` this offer was generated against, or null when no goal was active. A revision bump
   * invalidates an outstanding offer rather than pushing last cycle's directive into a re-cut objective. */
  goalRevision: number | null
}

export const noSuggestion: PromptSuggestionState =
  { status: 'off', text: '', turnSeq: null, error: '', at: '', intent: 'worker-step', goalRevision: null }

/** What the loop needs to know about the goal RIGHT NOW, from the service (activation is process-local and
 *  is not in the log, so this is the only honest source). */
export interface GoalSignal {
  phase: GoalPhaseView
  activation: 'armed' | 'disarmed'
  revision: number
}

/**
 * Split the protocol prefix off a suggestion. `GOAL:` means "this step changes the objective" and the human
 * must be the one to send it; anything else is worker execution and may auto-run.
 *
 * Deliberately a PREFIX rule on the model's own one-line answer rather than a second structured call: the
 * suggestion surface already validates one bounded string, and a protocol the model can see in the rules
 * (see `prompt.ts`) costs 5 characters of `promptMaxChars` instead of another auxiliary request.
 */
export function classifyOffer(raw: string): { intent: 'worker-step' | 'goal-edit'; text: string } {
  const t = raw.trim()
  const m = /^GOAL\s*:\s*/i.exec(t)
  if (m === null) return { intent: 'worker-step', text: t }
  const rest = t.slice(m[0].length).trim()
  // `GOAL:` with nothing after it is not a re-cut; treat it as a worker step so an empty protocol never
  // blocks the loop with a phantom "needs you" offer.
  if (rest === '') return { intent: 'worker-step', text: t }
  return { intent: 'goal-edit', text: rest }
}

/**
 * Does the host goal driver intend to start the next turn itself? Measured rule (`dsh-goal-round-driver`):
 * it queues a round on idle when `phase === 'active' && activation === 'armed'`. Two loops starting turns at
 * one boundary is a race against the driver's own reservation fence, so when this says yes we yield.
 */
export function goalDriverOwnsTheTurn(goal: GoalSignal | null): boolean {
  return goal !== null && goal.phase === 'active' && goal.activation === 'armed'
}

/**
 * What the Suggested Next Step bar can ask the server for (#113), and the single shape the command plane
 * exposes to the client. Kept next to `PromptSuggestionState` rather than in the loop module because the bar
 * and the row are the same contract — a client that can read it can render it.
 */
export interface PromptBarAccess {
  read(sessionId: string): Promise<PromptSuggestionState & { autorun: 'armed' | 'disarmed'; fired: number }>
  setAutorun(sessionId: string, on: boolean): { autorun: 'armed' | 'disarmed'; fired: number }
  disarmHuman(sessionId: string): void
  setOff(sessionId: string): Promise<void>
  setOn(sessionId: string): Promise<void>
}
