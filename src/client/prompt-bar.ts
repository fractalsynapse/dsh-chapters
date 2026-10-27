/**
 * The Suggested Next Step bar — every decision the row makes, kept out of React (#113).
 *
 * Deliberately shaped like the goal bar, because that implementation is tested, already fits, and gets the
 * split right: the **durable** facts (`status`, `text`, `turnSeq` — the server's one-generation-per-turn
 * identity) versus the **process-local** intent (`autorun`, `expanded` — the goal's `activation` in
 * everything but name). Nothing transient is persisted, and nothing persisted is guessed here.
 *
 * The failures the maintainer rejected are all decision bugs, not rendering bugs: firing while a turn is
 * running, shouting a refusal that should have been silence, an autorun that outlives the purpose that
 * justified it. Each has a row in `tests/unit/prompt-bar.test.ts`.
 */

export type PromptBarStatus = 'off' | 'idle' | 'analyzing' | 'ready' | 'failed'
export type PromptBarAutorun = 'armed' | 'disarmed'
/** Mirrors the host's `GoalPhase` vocabulary (`dsh-goal` types) so goal composition needs no translation. */
export type GoalPhaseView = 'none' | 'active' | 'paused' | 'blocked' | 'complete'

export interface PromptBarState {
  status: PromptBarStatus
  /** The offer, verbatim. Never truncated — an over-cap answer is refused upstream. */
  text: string | null
  /** #113: what kind of step the server classified this as. `goal-edit` is held for the human's keystroke,
   * because goal edits require a direct human turn in the host and an autorun message is not one. */
  intent: 'worker-step' | 'goal-edit'
  /** The `turn/end` seq this offer belongs to; its identity, not a timestamp. */
  turnSeq: number | null
  /** Set only with `status: 'failed'`; rendered as `role="alert"` (#61: delivered, not swallowed). */
  error: string | null
  /** Why an action did not happen, on the bar's face (#113). Empty when there is nothing to explain. */
  note: string
  autorun: PromptBarAutorun
  expanded: boolean
  running: boolean
  goalPhase: GoalPhaseView
  /** The offer a human dismissed or interrupted. A NEW `turnSeq` clears it; this one stays hidden. */
  hiddenTurnSeq: number | null
  /** Live goal facts, when the caller can read them (the goal driver owns the next turn when active+armed). */
  goal: { phase: string; activation: string; revision: number } | null
}

export type PromptBarEvent =
  | { t: 'polled', status: PromptBarStatus, text?: string | null, turnSeq?: number | null, error?: string | null, intent?: 'worker-step' | 'goal-edit' }
  | { t: 'expand' } | { t: 'collapse' }
  /** Why an action did not happen, on the bar's own face (#113). Cleared when a new offer lands. */
  | { t: 'note'; note: string }
  | { t: 'autorun', on: boolean }
  | { t: 'human/prompt' }
  | { t: 'off' }
  | { t: 'goal', phase: GoalPhaseView }
  | { t: 'running', running: boolean }

export function initialBarState(autorun: PromptBarAutorun = 'disarmed'): PromptBarState {
  return { status: 'off', text: null, turnSeq: null, error: null, note: '', intent: 'worker-step', goalPhase: 'none', goal: null, autorun, expanded: false, running: false, hiddenTurnSeq: null }
}

export function promptBarReducer(state: PromptBarState, ev: PromptBarEvent): PromptBarState {
  if (ev.t === 'note') return { ...state, note: ev.note }
  const next = baseBarReducer(state, ev)
  // A note is about the gesture that just failed, so a NEW offer retires it. A poll that repeats the same
  // offer (the bar re-reads every few seconds) does not — otherwise the explanation would blink out before
  // the human could read it.
  return ev.t === 'polled' && (next.turnSeq !== state.turnSeq || next.text !== state.text) ? { ...next, note: '' } : next
}

function baseBarReducer(state: PromptBarState, ev: PromptBarEvent): PromptBarState {
  switch (ev.t) {
    case 'polled': {
      if (ev.status === 'off') return { ...state, status: 'off', text: null, turnSeq: null, error: null, expanded: false, autorun: 'disarmed' }
      // A fresh generation invalidates the previous offer: acting on a stale one is how a bar lies.
      if (ev.status === 'analyzing') return { ...state, status: 'analyzing', text: null, error: null }
      return {
        ...state,
        status: ev.status,
        text: ev.status === 'ready' ? (ev.text ?? null) : null,
        intent: ev.status === 'ready' ? (ev.intent ?? 'worker-step') : 'worker-step',
        turnSeq: ev.turnSeq ?? state.turnSeq,
        error: ev.status === 'failed' ? (ev.error ?? 'the suggestion call failed') : null,
      }
    }
    case 'expand': return { ...state, expanded: true }
    // Collapsing is a reading action. It keeps the offer — only a human prompt or `Off` dismisses it.
    case 'collapse': return { ...state, expanded: false }
    case 'autorun': return { ...state, autorun: ev.on ? 'armed' : 'disarmed' }
    case 'running': return { ...state, running: ev.running }
    case 'human/prompt':
      // The human took the wheel: yield the loop, and drop the offer that was on screen. Generation itself
      // continues on the NEXT turn boundary — suspension is not disable.
      return { ...state, autorun: 'disarmed', hiddenTurnSeq: state.turnSeq, expanded: false }
    case 'off': return { ...state, status: 'off', text: null, turnSeq: null, error: null, expanded: false, autorun: 'disarmed' }
    case 'goal':
      // Per spec: autorun runs ALONGSIDE an active goal and disarms itself when the goal completes — the
      // suggestion loop exists to serve the session's purpose, and stops when that purpose stops.
      return { ...state, goalPhase: ev.phase, autorun: ev.phase === 'complete' ? 'disarmed' : state.autorun }
  }
  // Exhaustive fallback: a new event without a case must return the state unchanged rather than
  // compile into `undefined` and blank the bar.
  return state
}

/** The status label. `failed` keeps the ready label so the error span is the delta, not a mystery row. */
export function barLabel(s: PromptBarState): string | null {
  if (s.status === 'analyzing') return 'Analyzing situation…'
  if (s.status === 'ready' || s.status === 'failed') return 'Recommended Next Step'
  return null
}

export function barVisible(s: PromptBarState): boolean {
  // Only `off` hides the row. `idle` is enabled-and-waiting, and showing it is the difference between
  // "the feature is live, nothing to say yet" and silence that reads as disabled (#113).
  if (s.status === 'off') return false
  if (s.status === 'ready' && (s.text === null || s.text === '')) return false
  // The goal bar's `clearedGoalId` guard, in our terms: don't flicker back the offer just dismissed.
  if (s.hiddenTurnSeq !== null && s.hiddenTurnSeq === s.turnSeq) return false
  return true
}

/** May the bar submit its own offer? Armed, present, idle, not dismissed, and still serving a purpose. */
export function shouldAutoFire(s: PromptBarState): boolean {
  if (s.status !== 'ready') return false
  if (s.text === null || s.text === '') return false
  // #113: two host-imposed stops before anything else. A goal re-cut needs a human turn (dsh-tool-goal's
  // requireDirectHuman), and an armed goal driver already intends to start this turn — firing here would be
  // two turn-starters at one boundary, racing the driver's own reservation fence.
  if (s.intent === 'goal-edit') return false
  if (s.goal !== null && s.goal.phase === 'active' && s.goal.activation === 'armed') return false
  if (s.autorun !== 'armed') return false
  if (s.running) return false
  if (s.goalPhase === 'complete') return false
  if (s.hiddenTurnSeq !== null && s.hiddenTurnSeq === s.turnSeq) return false
  return true
}

/** The command the bar pulls. One string, so the client and the command plane cannot drift silently. */
export const BAR_STATE_COMMAND = '/chapters-prompt state'
/** The bar's Run button: the server submits the on-screen offer as the human's own turn. */
export const BAR_RUN_COMMAND = '/chapters-prompt run'

/**
 * Parse the `state` verb's `k: v` lines into a pull event.
 *
 * One output serving the human and the component is the design (see `docs/contract.md`); this function is
 * the cost of that choice, and it is kept honest: an unrecognised line is IGNORED, not guessed at, and a
 * payload that yields no `status` is `null` so the caller keeps its last state rather than inventing `off`
 * (which would hide a bar that is merely mid-reply). Indentation and the prompt's own lines are the reason
 * the prompt is collected separately from the scalar fields — it is the only multi-line value.
 */
export function parseBarState(text: string): PromptBarEvent | null {
  const lines = text.split('\n')
  const head = lines[0] ?? ''
  const statusWord = head.startsWith('suggested next step:') ? head.slice('suggested next step:'.length).trim() : ''
  const status = statusWord === 'off' ? 'off'
    : statusWord === 'idle' ? 'idle'
    : statusWord === 'analyzing' ? 'analyzing'
    : statusWord === 'ready' ? 'ready'
    : statusWord === 'failed' ? 'failed'
    : null
  if (status === null) return null
  const scalars: Record<string, string> = {}
  const prompt: string[] = []
  let inPrompt = false
  for (const line of lines.slice(1)) {
    if (inPrompt) { prompt.push(line.replace(/^ {4}/, '')); continue }
    const m = /^ {2}([a-z]+): ?(.*)$/.exec(line)
    if (m === null) continue
    const key = m[1]!, value = m[2]!.trim()
    if (key === 'prompt') { inPrompt = true; continue }
    scalars[key] !== undefined ? (scalars[key] += ` ${value}`) : (scalars[key] = value)
  }
  const turnRaw = scalars['turn'] ?? ''
  const turnSeq = /^\d+$/.test(turnRaw) ? Number(turnRaw) : null
  const errorRaw = scalars['error'] ?? ''
  const intentWord = (scalars['intent'] ?? '').split(' ')[0] ?? ''
  return {
    t: 'polled',
    intent: intentWord === 'goal-edit' ? 'goal-edit' : 'worker-step',
    status,
    ...(status === 'ready' ? { text: prompt.join('\n'), turnSeq } : {}),
    ...(status === 'failed' ? { error: errorRaw, turnSeq } : {}),
  }
}

/** The autorun flag, read from the same payload — the row is durable, the flag is not. */
export function parseBarAutorun(text: string): 'armed' | 'disarmed' | null {
  const m = /^ {2}autorun: (armed|disarmed)\b/m.exec(text)
  return m === null ? null : (m[1] as 'armed' | 'disarmed')
}

/**
 * Does the host say this session is busy right now?
 *
 * The dock's props are HOOKS (`useSessionStatus`, `useChat`, `useInput`, …) — documented in
 * docs/contract.md § "What a dock component is handed" — so a component that waits for a scalar
 * `props.running` waits forever, which is precisely why Autorun declared itself unavailable while the host
 * was publishing the signal one field away. Shapes differ across hosts and versions, so every form is folded
 * here, in one pure function, with `undefined` (unknown) kept distinct from `false` (idle): the loop refuses
 * to start a turn on an unknown, and that distinction is the whole safety property.
 */
export function deriveRunning(status: unknown): boolean | undefined {
  if (status === undefined || status === null) return undefined
  if (typeof status === 'boolean') return status
  if (typeof status === 'string') {
    if (/^(running|streaming|busy|active)$/i.test(status)) return true
    if (/^(idle|done|stopped|finished|ready|waiting)$/i.test(status)) return false
    return undefined
  }
  if (typeof status === 'object') {
    const s = status as { status?: unknown, state?: unknown, running?: unknown, phase?: unknown }
    if (s.running !== undefined) return typeof s.running === 'boolean' ? s.running : undefined
    return deriveRunning(s.status ?? s.state ?? s.phase)
  }
  return undefined
}
