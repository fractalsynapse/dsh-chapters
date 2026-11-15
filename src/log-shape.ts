/**
 * Event-shape readers — the single place that knows how DSH nests payloads in
 * the durable log.
 *
 * Extracted from `render.ts` (docs/plans-carriage.md § 1: the chapter renderer and the plan detector
 * must agree on which `tool/result` answers which `tool/call`, or a plan's verdict could be read
 * differently in two places). Shapes here were MEASURED from real logs, never guessed — see
 * tests/unit/render.test.ts:18-22 for the fixture mirror and spikes/probe/FINDINGS.md.
 *
 * Pure module: no cordis, no fs, no DSH imports.
 */
import type { ContentBlock, SessionEventLike } from './types.ts'

export const blocksOf = (value: unknown): ContentBlock[] =>
  Array.isArray(value) ? value as ContentBlock[] : []

export const textOfBlocks = (value: unknown): string =>
  blocksOf(value)
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n')

/**
 * Flatten a tool-result payload, which nests a content array inside a tool-result block.
 * REAL shape (measured e2e, 2026-09-19): `message.content` blocks are
 * `{ type: 'tool-result', toolCallId, isError, content: [{ type:'text', text }] }`.
 */
export function toolResultText(data: Record<string, unknown>): string {
  const message = data.message as Record<string, unknown> | undefined
  const inner = blocksOf(message?.content ?? data.content)
  const parts: string[] = []
  for (const block of inner) {
    if (block.type === 'text') parts.push((block as { text?: string }).text ?? '')
    else if (block.type === 'tool-result') {
      const nested = (block as { content?: unknown }).content
      parts.push(typeof nested === 'string' ? nested : textOfBlocks(nested))
    }
  }
  return parts.filter((p) => p.length > 0).join('\n')
}

/** True when the paired tool-result carries an error flag (a failed call). */
export function toolResultIsError(data: Record<string, unknown>): boolean {
  const message = data.message as Record<string, unknown> | undefined
  const inner = blocksOf(message?.content ?? data.content)
  return inner.some((b) => (b as { isError?: boolean }).isError === true)
}

/** The callId a `tool/result` answers (measured: it rides on `message.source.callId`). */
export function resultCallId(ev: SessionEventLike): string | undefined {
  const msg = (ev.data as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
  const cid = (msg?.source as Record<string, unknown> | undefined)?.callId
  if (typeof cid === 'string') return cid
  const flat = (ev.data as Record<string, unknown> | undefined)?.callId
  return typeof flat === 'string' ? flat : undefined
}

/** The callId a `tool/call` carries. */
export const callIdOf = (ev: SessionEventLike): string | undefined => {
  const cid = (ev.data as Record<string, unknown> | undefined)?.callId
  return typeof cid === 'string' ? cid : undefined
}

/** Does this result answer this call? Both sides must name a callId — never guess by adjacency. */
export function sameCall(call: SessionEventLike, result: SessionEventLike): boolean {
  const cid = callIdOf(call)
  const rcid = resultCallId(result)
  return cid !== undefined && rcid !== undefined && String(cid) === String(rcid)
}

/**
 * Which copies of a `tool/result` a chapter must render, decided over the WHOLE log.
 *
 * #334. There was no single predicate here — `render.ts` and `collectCandidates` each kept "the LAST
 * result per callId", on the 2026-09-29 premise that a second copy is a host redelivery of the SAME
 * text. On current host bytes that premise never fires. Measured over three production sessions:
 * 44 callIds carry more than one result, **0 are byte-identical**, and **44 are this plugin's own
 * arrival-time shadowing** (`surfaceOp:{op:'replace'}` + a `compaction/prune by:'dsh-chapters-arrival'`)
 * whose content is a ~500-byte stub. Keeping the last copy therefore kept the stub and discarded
 * 932,462 characters of durable payload, with no mention of the dropped seq anywhere in the chapter.
 *
 * The rule is now about SIZE, not position: the **largest** copy of a callId is the payload, ties
 * breaking to the last (which preserves the documented behaviour for a true redelivery, where the
 * copies are identical and the newest is the verdict). A stub can never win a size contest against
 * what it replaced.
 *
 * Deciding over the whole log, not the chapter range, is what makes the archive a function of the
 * log rather than of where the model drew a boundary — invariant 4. `renderChapter` previously
 * computed it over `inRange`, so the same session archived the 49 KB original or the 500 B stub
 * depending on the chapter edge.
 *
 * The returned map covers EVERY result seq: the entry is the event whose BYTES that chapter position
 * renders, or `undefined` when some other in-range position already renders them (never twice in one
 * chapter). When a chapter holds only a stub whose original lives in another chapter, the original's
 * bytes are rendered at the stub's position — duplicated across chapters, which is the accepted cost
 * of never silently losing a payload. The artifact store is content-addressed, so the blob is still
 * written once.
 */
export interface ResultPlan {
  /** Each in-range result → the event whose BYTES that position renders, or undefined when another
   *  in-range position already carries them. */
  render: Map<SessionEventLike, SessionEventLike | undefined>
  /** A position that renders nothing, mapped to the seq whose payload replaced it (#334: a skipped
   *  shadowing stub must still be VISIBLE in the chapter — silently dropping it repeats, in the other
   *  direction, the substitution that lost the payload). */
  shadowedBy: Map<number, number>
}

export function resultRenderPlan(
  allEvents: readonly SessionEventLike[],
  rangeEvents: readonly SessionEventLike[],
): ResultPlan {
  const copies = new Map<string, SessionEventLike[]>()
  for (const ev of allEvents) {
    if (ev.type !== 'tool/result') continue
    const cid = resultCallId(ev)
    if (cid === undefined) continue
    const list = copies.get(cid)
    if (list === undefined) copies.set(cid, [ev])
    else list.push(ev)
  }
  // Largest payload wins; identical sizes keep the later copy (the redelivery rule).
  const authoritative = new Map<string, SessionEventLike>()
  for (const [cid, list] of copies) {
    let best = list[0]!
    for (const c of list) {
      if (toolResultText(c.data ?? {}).length >= toolResultText(best.data ?? {}).length) best = c
    }
    authoritative.set(cid, best)
  }

  const plan = new Map<SessionEventLike, SessionEventLike | undefined>()
  const shadowedBy = new Map<number, number>()
  // Per callId, decide which single in-range position carries the bytes. Ordered pass, so the
  // choice does not depend on Map iteration order.
  const inRangeByCall = new Map<string, SessionEventLike[]>()
  for (const ev of rangeEvents) {
    if (ev.type !== 'tool/result') continue
    const cid = resultCallId(ev)
    if (cid === undefined) { plan.set(ev, ev); continue }
    const list = inRangeByCall.get(cid)
    if (list === undefined) inRangeByCall.set(cid, [ev])
    else list.push(ev)
  }
  for (const [cid, inRange] of inRangeByCall) {
    const auth = authoritative.get(cid) ?? inRange[0]!
    // Exactly one position renders this call's payload:
    //  - the authoritative copy itself, when this chapter contains it (the common case, and the
    //    one #334 broke: the stub used to win here);
    //  - otherwise the first in-range copy, which then carries the original's bytes so no chapter
    //    is left holding only a pointer.
    const carrier = inRange.includes(auth) ? auth : inRange[0]!
    for (const ev of inRange) {
      if (ev === carrier) { plan.set(ev, auth); continue }
      plan.set(ev, undefined)
      // Only call it a shadow when the survivor really is bigger — i.e. this position is the stub,
      // not one of several identical redeliveries.
      if (toolResultText(auth.data ?? {}).length > toolResultText(ev.data ?? {}).length
        || ev.seq > auth.seq) shadowedBy.set(ev.seq, auth.seq)
    }
  }
  return { render: plan, shadowedBy }
}

/**
 * The LAST result event for one callId, over an already-range-filtered list.
 * Host redelivery is real (measured 2026-09-28: 25 calls carried TWO tool/result
 * events), so the newest copy is the authoritative verdict.
 *
 * @deprecated #334: "newest" is the wrong rule once the newer copy is an arrival stub, and a
 * chapter rendered through this helper silently archives the pointer instead of the payload.
 * Use {@link resultRenderPlan}. Kept only for callers that genuinely mean "the newest event".
 */
export function lastResultFor(results: readonly SessionEventLike[], callId: string): SessionEventLike | undefined {
  let last: SessionEventLike | undefined
  for (const ev of results) if (resultCallId(ev) === callId) last = ev
  return last
}

/** `tool/call` arguments as one serialized string (object or pre-serialized string both occur). */
export function callArgsText(data: Record<string, unknown>): string {
  const args = data.arguments
  if (typeof args === 'string') return args
  try { return JSON.stringify(args ?? {}) } catch { return String(args) }
}

/** One named argument from either shape (string JSON or object). */
export function callArg(data: Record<string, unknown>, name: string): string | undefined {
  const args = data.arguments
  let obj: Record<string, unknown> | undefined
  if (typeof args === 'string') {
    try { obj = JSON.parse(args) as Record<string, unknown> } catch { obj = undefined }
  } else if (args !== null && typeof args === 'object') {
    obj = args as Record<string, unknown>
  }
  const value = obj?.[name]
  return typeof value === 'string' ? value : undefined
}
