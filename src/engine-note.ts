/**
 * The relief decision note — one formatter, so the numbers a diagnosis needs are never optional (#143).
 *
 * Why a module for one string: the live instrumented run of 2026-10-28 showed the note already carried the compaction
 * id, the route, the surface and the ratio, but **nothing** about the span a pass removed — `grep -c shadowed` over
 * 3,772 engine lines in the sink returned zero. That is the difference between answering "why did relief need ~19
 * calls?" and re-guessing at it, so the field is now produced here and pinned by a row (`engine-lifecycle.test.ts`,
 * #143) rather than being remembered at the call site. Same reason `#noteDecision` exists at all: `decided: none` covers
 * two opposite bugs (no routed target vs. genuinely under threshold), so the abstention has to say which.
 *
 * Pure: no cordis, no ctx, no fs. `#noteDecision` gathers the inputs (it can fail, and the try/catch stays there) and
 * hands them over; this turns them into bytes. Every field the previous inline template emitted is still emitted, in
 * the same spellings, because existing rows grep them.
 */

export type CompactionNoteInput = {
  readonly where: string
  readonly trigger: unknown
  readonly sessionId?: string | null
  /** `null` means the session has no routed target — a different failure than "under threshold". */
  readonly route: string | null
  readonly surfaceTokens: number | null
  readonly window: number | null
  readonly ratio?: number | string | null
  /** Nodes still on the surface — read off the SESSION, because the result does not carry it (#143). */
  readonly surfaceNodes?: number | null
  /** The base engine's result, or `null` when it abstained. Field names mirror `CompactionResult` in
   * `@deepseek-ai/dsh-compaction/lib/types/types.d.ts:shadowedSeqs / shadowedTokenCount`, measured not assumed. */
  readonly result: {
    readonly compactionId?: string | null
    readonly shadowedSeqs?: readonly number[] | null
    readonly shadowedTokenCount?: number | null
  } | null
}

/** One line, every field, no missing values: absent counts are `0`, absent numbers are `?`. */
export function compactionNote(input: CompactionNoteInput): string {
  const r = input.result
  const shadowed = Array.isArray(r?.shadowedSeqs) ? (r.shadowedSeqs as readonly number[]).length : 0
  const shadowedTok = typeof r?.shadowedTokenCount === 'number' ? r.shadowedTokenCount : 0
  const decided = r === null
    ? 'none'
    : `compaction ${String(r?.compactionId ?? '?')}`
  const route = input.route === null ? 'none' : input.route
  const surface = input.surfaceTokens === null ? '?' : `${String(input.surfaceTokens)} tok`
  const window = input.window === null ? '?' : String(input.window)
  const nodes = input.surfaceNodes === null || input.surfaceNodes === undefined ? '?' : String(input.surfaceNodes)
  const ratio = input.ratio === null || input.ratio === undefined ? '?' : String(input.ratio)
  return `${input.where} decided: ${decided} (trigger=${JSON.stringify(input.trigger)}, `
    + `session=${String(input.sessionId ?? '?')}, route=${route}, surface=${surface}, ratio=${ratio}, `
    + `window=${window}, shadowed=${String(shadowed)}, shadowedTok=${String(shadowedTok)}, nodes=${nodes})`
}
