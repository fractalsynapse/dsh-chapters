/**
 * Topic-sequential composition (knowledge-repo.md §4.2–4.4).
 *
 * The user requirement in the record: consecutive message collections that
 * reference the SAME TASK merge into one chapter; a chapter splits only when
 * the task changes (signature overlap < τ) or the chapter outgrows a limit.
 * Greedy, sequential, deterministic — and composed from the per-turn
 * signatures already stored at turn/end (§4.1), so archive time is O(turns).
 *
 * Completeness guard (§4.3): only collections whose turn COMPLETED inside the
 * span are archived; anything cut by a span boundary stays live and is noted,
 * never silently dropped and never silently included.
 *
 * Pure module: events + stored collections + config in, chapter ranges out.
 * The titles/summaries come from deriveIdentity (engine-core) — the same
 * deterministic derivation the rest of the plugin uses; P2 enrichment may
 * relabel later, never re-chapter (append-only, §4.4).
 */
import { deriveIdentity, type EngineMessage } from './engine-core.ts'
import { detectPlans } from './plans.ts'
import type { CollectionSignature } from './signature.ts'
import type { ChapterRange } from './types.ts'
import type { SessionEventLike } from './types.ts'
import { readActiveGoal } from './prompt-state.ts'

export interface ComposeConfig {
  /** Merge threshold τ in [0,1]: collections merge while overlap score ≥ τ. */
  mergeThreshold: number
  /** Estimated-token cap per chapter; overshoot forces a split. */
  chapterLimit: number
}

export interface ComposeResult {
  chapters: ChapterRange[]
  notes: string[]
  /** Span events belonging to turns that did not complete inside the span. */
  unarchivedSeqs: number[]
}

const union = (a: readonly string[], b: readonly string[]): Set<string> => new Set([...a, ...b])
const inter = (a: readonly string[], b: readonly string[]): number => {
  const set = new Set(a)
  return b.reduce((n, v) => n + (set.has(v) ? 1 : 0), 0)
}

/**
 * Overlap score in [0,1]: path matches weigh 2× (same file ≈ same task),
 * command and term matches 1×; denominator is the union, so a collection
 * with mostly NEW signal scores low against the running chapter.
 */
export function signatureScore(a: CollectionSignature, b: CollectionSignature): number {
  const num = 2 * inter(a.paths, b.paths) + inter(a.commands, b.commands) + inter(a.terms, b.terms)
  const den = 2 * union(a.paths, b.paths).size + union(a.commands, b.commands).size + union(a.terms, b.terms).size
  if (den === 0) return 0
  return num / den
}

const messagesOf = (events: readonly SessionEventLike[], lo: number, hi: number): EngineMessage[] =>
  events
    .filter((e) => e.seq >= lo && e.seq <= hi && (e.type === 'user/message' || e.type === 'assistant/message'))
    .map((e) => {
      const d = (e.data ?? {}) as Record<string, unknown>
      const message = (d.message ?? d) as Record<string, unknown>
      const content = Array.isArray(message.content)
        ? (message.content as { type?: string; text?: string }[])
          .filter((b) => b.type === 'text')
          .map((b) => ({ type: 'text', ...(b.text !== undefined ? { text: b.text } : {}) }))
        : []
      return { role: e.type === 'assistant/message' ? 'assistant' : 'user', content }
    })

/**
 * Compose the span [spanStart, spanEnd] of `events` into topic-sequential
 * chapters from `collections` (the session's stored per-turn signatures).
 *
 * Returns no chapters when the span holds no COMPLETED collections — the
 * caller then falls back to its legacy size-based behavior rather than
 * archiving nothing-and-claiming-to.
 */
export function composeChapters(
  events: readonly SessionEventLike[],
  spanStart: number,
  spanEnd: number,
  collections: readonly CollectionSignature[],
  config: ComposeConfig,
): ComposeResult {
  const notes: string[] = []
  // #421 (measured on the FIRST LIVE composed-discussion record, 2026-11-19): the old rule demanded
  // the WHOLE signature range sit inside the span. Live relief is incremental — earlier passes clip
  // older signatures — so one clipped seq disqualified a finished topic FOREVER, and six real passes
  // composed six single chapters while every deterministic row (two COMPLETE signatures in one span)
  // stayed green. Intersection is the honest predicate; the signature then participates with its
  // CLIPPED bounds, because its already-archived head lives in an earlier chapter. Unfinished turns
  // stay unarchived by construction — signatures are only stored at `turn/end`, so the in-flight
  // turn has no collection to participate with (measured in the same session's store row).
  const intersects = (c: CollectionSignature): boolean =>
    c.seqs.length > 0 && c.seqs[c.seqs.length - 1]! >= spanStart && c.seqs[0]! <= spanEnd
  const clippedStart = (c: CollectionSignature): number => Math.max(c.seqs[0]!, spanStart)
  const clippedEnd = (c: CollectionSignature): number => Math.min(c.seqs[c.seqs.length - 1]!, spanEnd)
  const usable = collections.filter(intersects).sort((a, b) => clippedStart(a) - clippedStart(b))
  if (usable.length === 0) {
    const unarchived = events.filter((e) => e.seq >= spanStart && e.seq <= spanEnd).map((e) => e.seq)
    notes.push('no completed collections in span — legacy segmentation applies')
    return { chapters: [], notes, unarchivedSeqs: unarchived }
  }

  const covered = new Set<number>(usable.flatMap((c) => c.seqs))
  const unarchivedSeqs = events
    .filter((e) => e.seq >= spanStart && e.seq <= spanEnd && !covered.has(e.seq))
    .map((e) => e.seq)
  // #59 — this set is NOT evidence of unfinished work. It is simply "no collection signed it", and
  // a collection can be missing because the signature was lost in a registry lost-update while the
  // TURN COMPLETED (measured: session-2edf9694, 32 turn/ends vs 31 collections → 203 events in no
  // chapter, while the note below used to assert they were unfinished). Those seqs are ABSORBED into
  // the neighbouring ranges by `close()` below, so nothing finished is ever dropped; the note now
  // says which of them actually belong to an unfinished turn, derived from `turn/end`, not assumed.
  if (unarchivedSeqs.length > 0) {
    const lastTurnEnd = events.reduce((m: number, e) => (e.type === 'turn/end' && e.seq <= spanEnd && e.seq > m ? e.seq : m), -1)
    const unsignedDone = unarchivedSeqs.filter((sq) => sq <= lastTurnEnd)
    notes.push(unsignedDone.length > 0
      ? `${unsignedDone.length} unsigned event(s) in ${spanStart}..${lastTurnEnd} are inside COMPLETED turns — absorbed into the adjacent chapter (record §4.3, #59)`
      : `only unfinished tail content (${unarchivedSeqs[0]}..${unarchivedSeqs[unarchivedSeqs.length - 1]}) stays live, per §4.3`)
  }

  interface Running { first: CollectionSignature; last: CollectionSignature; paths: Set<string>; commands: Set<string>; terms: Set<string>; size: number; startSeq: number; endSeq: number }
  const runningOf = (c: CollectionSignature): Running => ({
    first: c, last: c, paths: new Set(c.paths), commands: new Set(c.commands), terms: new Set(c.terms),
    // #421: the RUNNING RANGE is the intersection; the scoring identity (first/last) stays whole.
    size: c.size, startSeq: clippedStart(c), endSeq: clippedEnd(c),
  })
  const scoreAgainst = (c: CollectionSignature, r: Running): number =>
    Math.max(signatureScore(c, r.first), signatureScore(c, r.last))
  // primary match: the first path of c equals the first path of either member
  // (with a prefix tolerance: 'src/render' vs 'src/render.ts' — the same file
  // named from prose vs tool args).
  const primaryOf = (sig: CollectionSignature): string | undefined => sig.paths[0]
  const primaryEq = (a: string | undefined, b: string | undefined): boolean => {
    if (a === undefined || b === undefined || a === '' || b === '') return false
    return a === b || a.startsWith(b + '.') || b.startsWith(a + '.')
  }
  const primaryMatch = (c: CollectionSignature, r: Running): boolean =>
    primaryEq(primaryOf(c), primaryOf(r.first)) || primaryEq(primaryOf(c), primaryOf(r.last))

  // A plan submission is the strongest topic boundary a log contains: the
  // planning work CONCLUDES with it (docs/plans-carriage.md § 6), so the
  // collection that carries one closes its chapter and the implementation that
  // follows opens the next. Deterministic, collection-granular, no model call.
  const planSeqs = detectPlans(events.filter((e) => e.seq >= spanStart && e.seq <= spanEnd)).plans
    .map((p) => p.seq)
  const holdsPlan = (lo: number, hi: number): boolean => planSeqs.some((sq) => sq >= lo && sq <= hi)
  const firstPlanTitleIn = (lo: number, hi: number): string | undefined => {
    const hit = detectPlans(events.filter((e) => e.seq >= lo && e.seq <= hi)).plans[0]
    return hit !== undefined && hit.title !== '' ? hit.title : undefined
  }

  const chapters: ChapterRange[] = []
  // Contiguity bookkeeping (#59): the first range starts at the SPAN, not at its collection, and each
  // later range starts one past the previous end — that is what absorbs an unsigned-but-completed
  // turn instead of dropping it. `pendingLo` is the next legal start.
  let pendingLo = spanStart

  let running = runningOf(usable[0]!)
  // True after a plan closed the chapter: the NEXT collection opens the next
  // chapter, it is never merged backwards (and never re-added — a duplicate
  // range would archive the same text twice, which validateRanges refuses).
  let closedAtPlan = false
  for (const c of usable.slice(1)) {
    if (closedAtPlan) {
      running = runningOf(c)
      closedAtPlan = false
      if (holdsPlan(running.startSeq, running.endSeq)) { close(); closedAtPlan = true }
      continue
    }
    // r28 (first live topic test): overlap Jaccard ALONE never reaches τ on
    // real research turns — a same-topic pair touching 5–6 files each scores
    // ~0.08 because one shared path dilutes in a union of ~10. The signal
    // that actually separates is the PRIMARY path (paths[0]: the first file
    // the turn touched): identical across the render pair, distinct at every
    // topic change. Merge on (score ≥ τ) OR (primary match).
    // A chapter that already holds a plan is CLOSED: the submission concludes the
    // planning, so the next turn opens the next chapter even when the topic
    // overlaps. (Merging into a plan-bearing chapter would bury the decision.)
    const merge = (scoreAgainst(c, running) >= config.mergeThreshold || primaryMatch(c, running))
      && running.size + c.size <= config.chapterLimit
      && !holdsPlan(running.startSeq, running.endSeq)
    if (merge) {
      for (const p of c.paths) running.paths.add(p)
      for (const q of c.commands) running.commands.add(q)
      for (const t of c.terms) running.terms.add(t)
      running.size += c.size
      running.last = c
      // #421: merge extends the RUNNING RANGE, and the range is span-clipped — a raw tail here could
      // push a chapter past spanEnd, the one boundary §4.3 never crosses.
      running.endSeq = Math.min(c.seqs[c.seqs.length - 1]!, spanEnd)
    } else {
      close()
      running = runningOf(c)
    }
    // The chapter that carries a plan ENDS there (docs/plans-carriage.md § 6).
    if (holdsPlan(running.startSeq, running.endSeq)) { close(); closedAtPlan = true }
  }
  // Half one of §4.3 still binds: never archive past the last COMPLETED turn. `spanEnd` is the
  // caller's anchor and normally IS a turn/end, so this is the identity; when a manual `/compact`
  // hands a span that cuts a turn, the clamp keeps the unfinished tail live instead of absorbing
  // it. Both halves of the guard, one line: nothing unfinished in, nothing finished out.
  const lastCompletedEnd = events.reduce(
    (m, e) => (e.type === 'turn/end' && e.seq <= spanEnd && e.seq > m ? e.seq : m),
    spanStart,
  )
  // #421: the final bound is the UNION of the two completion witnesses — the running (clipped)
  // signature's end, which proves its content finished by `turn/end` storage, and the last
  // turn/end at or before spanEnd, which extends an unsigned-but-completed tail absorption. When the
  // last signature already reached spanEnd clipped and no later turn closed, pendingLo sits past
  // both and NOTHING closes: the old unconditional close(lastCompletedEnd) here could emit an
  // inverted range (start 6, end 5, measured by the #421 rows) whenever a clipped signature opened
  // after the last in-span turn/end.
  const finalHi = Math.max(running.endSeq, lastCompletedEnd)
  if (!closedAtPlan && pendingLo <= finalHi) close(finalHi)

  function close(hiOverride?: number): void {
    const lo = pendingLo
    const hi = hiOverride ?? running.endSeq
    // #530: the goal ACTIVE at this close point is the span's identity when no plan owns it —
    // self-driving spans have only screened machine prose as "user lines", and their chapters
    // were arriving nameless while the objective sat in the very events being archived.
    const goalHere = readActiveGoal(events.filter((e) => ((e as { seq?: number }).seq ?? 0) <= hi))?.objective
    const identity = deriveIdentity(messagesOf(events, lo, hi), false, firstPlanTitleIn(lo, hi), goalHere)
    const pathsHint = [...running.paths].slice(0, 3).join(', ')
    chapters.push({
      title: identity.title,
      summary: `${identity.summary}${pathsHint !== '' ? ` · ${pathsHint}` : ''}`,
      startSeq: lo,
      endSeq: hi,
    })
    pendingLo = hi + 1
  }
  return { chapters, notes, unarchivedSeqs }
}
