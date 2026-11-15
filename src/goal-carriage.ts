/**
 * #349 — carry the active goal across a renewal, conservatively.
 *
 * THE SCOPE OF THIS MODULE, AND WHY IT IS NOT THE WHOLE ISSUE.
 * #349's fuller ask is to RE-ESTABLISH the goal on the child via `ctx.get('goals').create(agent, …)`, which
 * sidesteps the `requireDirectHuman` gate that guards the `create_goal` TOOL. The issue explicitly reserves
 * that as a maintainer decision ("Confirm with the maintainer whether plugin-authored goal creation is the
 * desired authority model before shipping — **if not, the notice must at least instruct the human to
 * re-arm, and say so loudly**"). This file implements THAT FALLBACK: the objective is stated in the child's
 * notice and the human is told, in the notice itself, that only they can re-arm. It creates nothing, calls
 * no goal service, and therefore needs no authority widening to ship.
 *
 * WHAT THE LOG CAN AND CANNOT SAY — measured, not assumed (three production logs):
 *   `goal/change` data keys : kind, version, operation, goal, roundsStarted, createdAt, updatedAt
 *   operations              : create, edit, pause, resume, block, complete, clear
 *   goal object keys        : id, revision, objective, phase, maxGoalRounds, blockedReason
 *   `todo/write`            : { todos: [{ content, status ∈ in_progress | pending | completed }] }
 *
 * So `phase` IS recoverable by folding durable events, and this module uses that. **`activation`
 * (armed/disarmed) is NOT**: `dsh-goal` keeps it process-local in a WeakMap, which is why `index.ts` reads
 * the goal signal from the service and comments that folding the log would be dishonest. Nothing here
 * claims armedness — the notice says who can change it, because a stale claim about the driver's state is
 * the same defect as a health check that cannot fail.
 *
 * One selector, one renderer, used by every renewal surface, per the "one predicate per semantic decision"
 * rule (#59) that this release keeps having to re-apply.
 */
import type { SessionEventLike } from './types.ts'

export interface GoalSnapshot {
  id: string
  revision: number
  objective: string
  /** From the event's `goal.phase`; absent on hosts that never set it. */
  phase: string
  /** The last operation folded — drives the wording, including the re-arm instruction. */
  operation: string
  maxGoalRounds?: number | undefined
  blockedReason?: string | undefined
  roundsStarted?: number | undefined
  /** Seq of the event this was folded from, so a reader can go look. */
  seq: number
  /** True when the goal is over: the objective may be stated, but not as live direction. */
  finished: boolean
}

const GOAL_OPERATIONS = new Set(['create', 'edit', 'pause', 'resume', 'block', 'complete', 'clear'])

/**
 * Fold the session's `goal/change` events into the goal as it stands now.
 *
 * Returns null when there is no goal at all, and when the LAST act on it was `clear` — a cleared goal is
 * not a goal, and carrying it forward would have the child pursuing a purpose the human ended. A
 * `complete` goal returns a snapshot flagged `finished`, because the trajectory fact ("the objective was
 * achieved at seq N") is worth stating while "keep working toward it" is not.
 */
export function foldGoalFromLog(events: readonly SessionEventLike[]): GoalSnapshot | null {
  let current: GoalSnapshot | null = null
  // Carried separately from `current` because TypeScript narrows the assignment target to null
  // before its first write inside the loop, so reading `current.objective` there is a type error even
  // though a previous iteration may have set it. The extra binding is also clearer about intent.
  let lastObjective = ''
  for (const ev of events) {
    if (ev.type !== 'goal/change') continue
    const data = (ev.data ?? {}) as Record<string, unknown>
    const operation = typeof data.operation === 'string' ? data.operation : ''
    // Unknown operations are IGNORED rather than guessed: a host that adds one must not silently
    // rewrite the child's understanding of its own purpose. (The known set was measured, above.)
    if (!GOAL_OPERATIONS.has(operation)) continue

    const g = (data.goal ?? {}) as Record<string, unknown>
    const id = typeof g.id === 'string' ? g.id : ''
    if (id === '') continue
    const objective = typeof g.objective === 'string' ? g.objective : ''
    const revision = typeof g.revision === 'number' ? g.revision : 0
    const phase = typeof g.phase === 'string' ? g.phase : 'active'

    if (operation === 'clear') { current = null; continue }

    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
    current = {
      id,
      revision,
      // A later event may omit the objective (e.g. a bare pause); keep the one we already have rather
      // than blanking the thing this module exists to carry.
      objective: objective !== '' ? objective : lastObjective,
      phase: operation === 'pause' ? 'paused'
        : operation === 'block' ? 'blocked'
          : operation === 'resume' ? 'active'
            : operation === 'complete' ? 'complete' : phase,
      operation,
      maxGoalRounds: num(g.maxGoalRounds),
      blockedReason: typeof g.blockedReason === 'string' && g.blockedReason !== '' ? g.blockedReason : undefined,
      roundsStarted: num(data.roundsStarted),
      seq: ev.seq,
      finished: operation === 'complete' || phase === 'complete',
    }
    lastObjective = current.objective
  }
  return current
}

/**
 * The notice block for a carried goal. Empty string means "inject nothing" — the tape-safety rule every
 * optional notice section follows (`rulesSection`, `plansSection`): a session that never used a goal pays
 * zero bytes, so the archives and recorded requests of ordinary sessions are untouched by this feature.
 *
 * `budgetChars` bounds the OBJECTIVE text only; the instruction lines are fixed and never cut, because a
 * truncated "only a human can re-arm" sentence is worse than no sentence.
 */
export function renderGoalCarriage(
  goal: GoalSnapshot | null,
  budgetChars: number,
): string {
  if (goal === null || goal.objective === '') return ''
  const head = goal.finished ? '## Goal (completed — do not resume it)' : '## Goal (carried from the parent session)'
  const lines: string[] = [head]
  const cap = `round cap ${String(goal.maxGoalRounds ?? 'unbounded')}, revision ${String(goal.revision)}, phase ${goal.phase}`
  lines.push(`Status: ${cap} (from seq ${String(goal.seq)}).`)
  const objective = goal.objective.replace(/\s+/g, ' ').trim()
  if (objective.length > budgetChars) {
    lines.push(`Objective (first ${String(budgetChars)} of ${String(objective.length)} chars): ${objective.slice(0, budgetChars)}…`)
    lines.push('(the whole text is in the parent log and in the chapters that archived it — this is a display budget, never a data decision)')
  } else {
    lines.push(`Objective: ${objective}`)
  }
  if (goal.phase === 'blocked' && goal.blockedReason !== undefined) lines.push(`Blocked on: ${goal.blockedReason}`)
  // The point of the conservative path: the child CANNOT arm its own goal, so say who can, loudly, in
  // the one place the child is guaranteed to read at birth.
  if (!goal.finished) {
    lines.push(goal.phase === 'active'
      ? 'This goal is NOT armed in the child: a continuation child cannot create or resume a goal (the host requires a direct human turn). Only the human can send /goal resume or re-cut the objective.'
      : `Goal is ${goal.phase}. The child cannot change that — only the human can send /goal resume.`)
  }
  return lines.join('\n')
}
