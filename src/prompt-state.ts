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
