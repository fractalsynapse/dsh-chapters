/**
 * #319 — the reload self-check. One pure predicate over a session's events answering exactly
 * one question: WOULD the host's cold-load validator refuse this log?
 *
 * The rule is the vendor's `foldSurface` guard (measured 2026-11-05, 0.2.0-rc.2,
 * `@deepseek-ai/dsh-session-format-v3-to-v4`): a `system/message` folding onto a NON-EMPTY
 * surface that has no protected head throws `SessionFormatError: system/message requires a
 * protected first surface head` — before any `surfaceOp` is consulted. Surface membership is
 * the vendor's `SURFACE_TYPES`; the head is adopted (per their append branch) only by a
 * `system/message` that finds the surface EMPTY. Setup/lifecycle events (permission/preset,
 * sandbox/mode, turn/*, step/*, command/*) are not surface, which is why ordinary sessions
 * load and seeded children — whose seq 0 IS a surface `user/message` (the sanctioned
 * agents.create seed, invariant 2) — do not: the engine's own first-turn header recording
 * then lands mid-surface with no head, and their validator rejects what their recorder wrote.
 *
 * This file TRANSCRIBES that rule deliberately — and `tests/unit/reload-check.test.ts`
 * pins the transcription against the vendor's OWN reader on the same fixtures, so drift
 * reddens in CI instead of surfacing as user-facing corruption months later. One predicate,
 * one decision (§ "one predicate per semantic decision"): "is this session's reload doomed"
 * lives HERE and nowhere else.
 */

export interface ReloadEvent {
  readonly type: string
  readonly seq: number
  readonly data?: Record<string, unknown>
  readonly surfaceOp?: unknown
}

export type ReloadRule = 'protected-head'

export interface ReloadRefusal {
  readonly seq: number
  readonly type: string
  readonly rule: ReloadRule
}

/** Verbatim vendor SURFACE_TYPES (0.2.0-rc.2, lib/index.js:485). Equivalence-tested. */
export const VENDOR_SURFACE_TYPES: readonly string[] = [
  'system/message',
  'user/message',
  'developer/message',
  'assistant/message',
  'tool/result',
]

/**
 * The first event the host's cold-load validator would refuse, or null when the log passes.
 * The predicate tracks exactly the two facts the vendor's guard reads: surface emptiness at
 * fold time, and whether a protected head has been adopted. Replacement semantics (head
 * migration, compaction shadowing) cannot PRODUCE a refusal — the guard precedes them — and
 * a head, once adopted, can never legally re-trigger it, so the single-pass simplification
 * is faithful to the throw, not an approximation of it.
 */
export function reloadRuleRefusal(events: readonly ReloadEvent[]): ReloadRefusal | null {
  const surface = new Set<string>(VENDOR_SURFACE_TYPES)
  let hasSurface = false
  let head: number | undefined
  for (const ev of events) {
    if (!surface.has(ev.type)) continue
    if (ev.type === 'system/message') {
      if (hasSurface && head === undefined) {
        return { seq: ev.seq, type: ev.type, rule: 'protected-head' }
      }
      if (head === undefined) head = ev.seq // the vendor's adoption branch (empty surface)
    }
    hasSurface = true
  }
  return null
}
