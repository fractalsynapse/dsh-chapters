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

export type PromptBarStatus = 'off' | 'analyzing' | 'ready' | 'failed'
export type PromptBarAutorun = 'armed' | 'disarmed'
/** Mirrors the host's `GoalPhase` vocabulary (`dsh-goal` types) so goal composition needs no translation. */
export type GoalPhaseView = 'none' | 'active' | 'paused' | 'blocked' | 'complete'

export interface PromptBarState {
  status: PromptBarStatus
  /** The offer, verbatim. Never truncated — an over-cap answer is refused upstream. */
  text: string | null
  /** The `turn/end` seq this offer belongs to; its identity, not a timestamp. */
  turnSeq: number | null
  /** Set only with `status: 'failed'`; rendered as `role="alert"` (#61: delivered, not swallowed). */
  error: string | null
  autorun: PromptBarAutorun
  expanded: boolean
  running: boolean
  goalPhase: GoalPhaseView
  /** The offer a human dismissed or interrupted. A NEW `turnSeq` clears it; this one stays hidden. */
  hiddenTurnSeq: number | null
}

export type PromptBarEvent =
  | { t: 'polled', status: PromptBarStatus, text?: string | null, turnSeq?: number | null, error?: string | null }
  | { t: 'expand' } | { t: 'collapse' }
  | { t: 'autorun', on: boolean }
  | { t: 'human/prompt' }
  | { t: 'off' }
  | { t: 'goal', phase: GoalPhaseView }
  | { t: 'running', running: boolean }

export function initialBarState(autorun: PromptBarAutorun = 'disarmed'): PromptBarState {
  return { status: 'off', text: null, turnSeq: null, error: null, autorun, expanded: false, running: false, goalPhase: 'none', hiddenTurnSeq: null }
}

export function promptBarReducer(state: PromptBarState, ev: PromptBarEvent): PromptBarState {
  switch (ev.t) {
    case 'polled': {
      if (ev.status === 'off') return { ...state, status: 'off', text: null, turnSeq: null, error: null, expanded: false, autorun: 'disarmed' }
      // A fresh generation invalidates the previous offer: acting on a stale one is how a bar lies.
      if (ev.status === 'analyzing') return { ...state, status: 'analyzing', text: null, error: null }
      return {
        ...state,
        status: ev.status,
        text: ev.status === 'ready' ? (ev.text ?? null) : null,
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
}

/** The status label. `failed` keeps the ready label so the error span is the delta, not a mystery row. */
export function barLabel(s: PromptBarState): string | null {
  if (s.status === 'analyzing') return 'Analyzing situation…'
  if (s.status === 'ready' || s.status === 'failed') return 'Recommended Next Step'
  return null
}

export function barVisible(s: PromptBarState): boolean {
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
  if (s.autorun !== 'armed') return false
  if (s.running) return false
  if (s.goalPhase === 'complete') return false
  if (s.hiddenTurnSeq !== null && s.hiddenTurnSeq === s.turnSeq) return false
  return true
}

/** The command the bar pulls. One string, so the client and the command plane cannot drift silently. */
export const BAR_STATE_COMMAND = '/chapters-prompt state'

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
  return {
    t: 'polled',
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
