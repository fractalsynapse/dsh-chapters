/**
 * #349 — carry the active goal across a renewal: state it, and (per the maintainer's decision of
 * 2026-11-19) RE-ARM it on the child through the goal SERVICE.
 *
 * HISTORY OF THE AUTHORITY, kept because the reasoning is the point. This module first shipped the
 * conservative slice — objective in the notice, "only a human can re-arm" stated aloud — because the
 * issue reserved plugin-authored goal creation as a maintainer decision: the `requireDirectHuman` gate
 * guards the create_goal TOOL, and reaching past a gate because the wrapper is the only thing
 * enforcing it is an unexamined authority widening. The decision arrived (2026-11-19, in the #349
 * thread): YES, scoped — `goalRearmDecision` here is the ONE predicate, only ACTIVE unfinished goals
 * carry, the call happens post-birth on the tools plane, every refusal is a delivered warning naming
 * `/goal resume`, and `goalRearmOnCarry` can restore the notice-only behavior byte-for-byte (the
 * default-mode wording rows in goal-carriage.test.ts pin exactly that compatibility). What this file
 * never does, in either mode: claim the parent's `activation` — that stays the service's to know.
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
 * The ONE re-arm predicate (#349, maintainer decision 2026-11-19): an ACTIVE, unfinished goal is the
 * only state the plugin may carry into the child as a live goal. Paused/blocked stay human-owned (a
 * human stopped them); complete/cleared never return. Everything else about the decision — the door's
 * wording, the birth payload, the e2e assertion — reads THIS.
 */
export function goalRearmDecision(goal: GoalSnapshot | null): { rearm: boolean; why: string } {
  if (goal === null) return { rearm: false, why: 'none' }
  if (goal.finished) return { rearm: false, why: 'finished' }
  if (goal.phase === 'paused') return { rearm: false, why: 'paused' }
  if (goal.phase === 'blocked') return { rearm: false, why: 'blocked' }
  if (goal.phase !== 'active') return { rearm: false, why: goal.phase }
  return { rearm: true, why: 'active' }
}

export interface TaskItem { content: string; status: string }

/**
 * The FINAL `todo/write` snapshot folded from the log — measured host shape
 * (`dsh-tool-todo`: every call appends the WHOLE list as { todos: [{ content, status }] }), so the
 * last write is the list. null when the session never wrote one: no list, zero bytes, tapes unmoved.
 */
export function foldTaskListFromLog(events: readonly SessionEventLike[]): TaskItem[] | null {
  let last: TaskItem[] | null = null
  for (const ev of events) {
    if (ev.type !== 'todo/write') continue
    const todos = (ev.data ?? {}).todos
    if (!Array.isArray(todos)) continue
    const items: TaskItem[] = []
    for (const t of todos) {
      const o = t as { content?: unknown, status?: unknown }
      if (typeof o?.content === 'string' && o.content.trim() !== '') {
        items.push({ content: o.content.trim(), status: typeof o.status === 'string' ? o.status : 'pending' })
      }
    }
    last = items
  }
  return last
}

/** The notice block for a carried task list. Empty when absent — the zero-bytes rule again. */
export function renderTaskCarriage(list: TaskItem[] | null): string {
  if (list === null || list.length === 0) return ''
  const lines = ['## Task list (carried from the parent session)']
  for (const t of list) lines.push(`- [${t.status}] ${t.content}`)
  return lines.join('\n')
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
  /**
   * #349: 're-armed' states the birth step the maintainer decision authorized; the default keeps the
   * conservative wording BYTE-IDENTICAL (recorded tapes and pre-decision expectations untouched).
   */
  mode: 're-armed' | 'notice-only' = 'notice-only',
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
    if (mode === 're-armed') {
      // True under BOTH birth outcomes by construction: the step RUNS at birth, and the door's
      // warning channel — never this block's silence — carries the exception. Wording verified by the
      // #349 rows: re-created on the child, /goal resume as the human fallback, no human-only claim.
      lines.push('The plugin re-created this goal on the child at birth (armed by the host\u0027s goal service; revision and round counts restart here, the round cap carries) \u2014 the maintainer-set authority model for continuations (#349, knob goalRearmOnCarry). Pause, edit, or clear it here with /goal; if the birth step was refused, the door\u0027s reply said so and /goal resume is the human fallback.')
    } else {
      lines.push(goal.phase === 'active'
        ? 'This goal is NOT armed in the child: a continuation child cannot create or resume a goal (the host requires a direct human turn). Only the human can send /goal resume or re-cut the objective.'
        : `Goal is ${goal.phase}. The child cannot change that — only the human can send /goal resume.`)
    }
  }
  return lines.join('\n')
}
