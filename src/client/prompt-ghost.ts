/**
 * The client ghost body for prompt recommendations (#71, site §28) — React-free,
 * exactly like the door runner beside it: this module owns the wire call, the
 * reply parsing, and the visibility decision; `src/client/index.ts` stays thin
 * chrome. The anti-dup row in tests/unit/client-doors.test.ts pins that
 * index.ts never touches the wire itself; the ghost obeys the same rule with
 * its OWN single body here (two call sites in this file, one per verb —
 * a pinned row proves it).
 *
 * Lifecycle (per session-scope mount):
 *   idle transition (running true→false) → fetch once per boundary →
 *   shown while the draft is EMPTY → typing hides it → ArrowRight/click
 *   accepts into the draft → Esc dismisses until the next boundary.
 * A refusal (off, no route, model failure) shows NOTHING and retries only at
 * the next boundary — the disabled state is invisible, never a banner.
 *
 * @module dsh-chapters/src/client/prompt-ghost
 */
import type { ClientRemote } from './doors.ts'

export type GhostPhase = 'idle' | 'shown' | 'accepted' | 'dismissed' | 'refused'

/** One boundary's fetched suggestion. `model` is the defining model's spec,
 *  fetched once per mount for the hover label — a display fact, never part of
 *  the accepted text. */
export interface GhostSuggestion { text: string; model?: string | undefined }

/**
 * The ONE visibility predicate, in the host's own terms: the shipped
 * placeholder shows on `draft === '' && attachments.length === 0`
 * (InputBar.tsx `showPlaceholder`) — whitespace-only is CONTENT, it hides the
 * guidance. The ghost agrees exactly, so the two layers can never disagree
 * about "empty", and a typed (or space-typed) draft hides ours instantly.
 */
export function shouldShowGhost(phase: GhostPhase, running: boolean, draft: string, hasAttachments: boolean, suggestion: GhostSuggestion | null): boolean {
  return phase === 'shown' && !running && !hasAttachments && draft === '' && suggestion !== null && suggestion.text !== ''
}

/**
 * The gesture decision for a keydown while the ghost is visible:
 * ArrowRight accepts, Escape dismisses, anything else is the host's business.
 * Returns the action for the caller to apply (and whether to preventDefault).
 */
export function ghostKeyAction(key: string): 'accept' | 'dismiss' | null {
  if (key === 'ArrowRight') return 'accept'
  if (key === 'Escape') return 'dismiss'
  return null
}

export interface GhostFetchResult { ok: boolean; text: string; refused?: boolean }

/**
 * Execute `/chapters-prompt suggest` for one session. Never throws: every arm
 * answers. `refused: true` marks a refusal worth retrying at the next boundary;
 * a wire/registry failure is also a refusal, so one bad network cannot loop.
 */
export function makePromptFetcher(remote: ClientRemote): (sessionId: string) => Promise<GhostFetchResult> {
  return async (sessionId) => {
    if (remote.commands?.execute === undefined) return { ok: false, text: 'commands remote unavailable', refused: true }
    try {
      const res = await remote.commands.execute(sessionId, '/chapters-prompt suggest', [])
      const result = res.value?.result
      const text = typeof result?.text === 'string' ? result.text : ''
      if (result?.kind === 'success' && text !== '') return { ok: true, text }
      return { ok: false, text, refused: true }
    } catch (error) {
      return { ok: false, text: String((error as Error)?.message ?? error).slice(0, 90), refused: true }
    }
  }
}

/**
 * Execute `/chapters-prompt model` once per mount and pull the spec out of the
 * status sentence for the hover label. Absent/unparseable ⇒ no label (the chip
 * still works) — a display fact is never a dependency.
 */
export function makeModelLabelFetcher(remote: ClientRemote): (sessionId: string) => Promise<string | null> {
  return async (sessionId) => {
    if (remote.commands?.execute === undefined) return null
    try {
      const res = await remote.commands.execute(sessionId, '/chapters-prompt model', [])
      const text = res.value?.result?.kind === 'success' ? res.value.result.text ?? '' : ''
      const m = text.match(/^prompt model: (\S+(?: \S+)*) \(.*\) — ON$/)
      return m?.[1] ?? null
    } catch {
      return null
    }
  }
}

/**
 * The boundary bookkeeping as a pure reducer so the component holds no logic:
 * `runningEdge` reports the true→false transition of the session.
 */
export function ghostReducer(state: { phase: GhostPhase; boundary: number }, event:
  | { type: 'idle-edge' }
  | { type: 'fetched'; ok: boolean }
  | { type: 'accept' }
  | { type: 'dismiss' },
): { phase: GhostPhase; boundary: number } {
  switch (event.type) {
    case 'idle-edge':
      return { phase: 'idle', boundary: state.boundary + 1 }
    case 'fetched':
      if (state.phase !== 'idle') return state // accept/dismiss/refused wins over a late answer
      return { ...state, phase: event.ok ? 'shown' : 'refused' }
    case 'accept':
      return { ...state, phase: 'accepted' }
    case 'dismiss':
      return { ...state, phase: 'dismissed' }
  }
}

/** The reducer's event union, named for the chrome's dispatch call. */
export type GhostEvent = Parameters<typeof ghostReducer>[1]
