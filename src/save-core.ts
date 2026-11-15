/**
 * saveSession — the archive-only pipeline, ONE implementation (issue #47).
 *
 * Extracted verbatim from the `/chapters-save` command body so door 3 (the human
 * command) and door 5 (subagent settlement) cannot drift: same watermark, same
 * composition, same render + write + commit. Policy stays OUTSIDE this function —
 * what to say to the human, whether to run enrichment now or queue it, whether to
 * schedule a sync — because those differ per door by design; the ARCHIVE does not.
 *
 * Rules this honors (AGENTS.md): never trusts ranges it did not derive, anchors
 * ONLY on `turn/end` (an interrupted tail is skipped, never half-archived), writes
 * append-only with read-back verification, and stamps lineage from the durable
 * header only (`RenderConfig.subagentOf` via `lineageOf`).
 */
import { composeChapters } from './compose.ts'
import { deriveRanges } from './continue-core.ts'
import { citationBaseOf, estimateTokens, nextUnarchivedSeq, oversizeRanges, renderChapter } from './render.ts'
import { chapterTopics } from './signature.ts'
import { makeArchiveFs, commitChapters, type RegistryStore } from './store.ts'
import { releaseReservation, reserve, reservePlan as reservePlanNumber } from './registry.ts'

/** One serialized read-allocate-write for a door that cannot use makeAllocator (same rule, #59). */
async function reserveNumbers(
  store: RegistryStore,
  sessionId: string,
  attemptId: string,
  count: number,
  plan = false,
): Promise<{ numbers: number[] }> {
  let numbers: number[] = []
  await store.mutate(sessionId, (state) => {
    const r = plan ? reservePlanNumber(state, attemptId, count) : reserve(state, attemptId, count)
    numbers = r.numbers
    return r.state
  })
  return { numbers }
}
import { writeArchive, attemptKey } from './archive.ts'
import { supersedeChapter, type SupersedeReason } from './repair.ts'
import type { ChapterRecord } from './archive.ts'
import type { ChapterRange } from './types.ts'
import type { RenderConfig, SessionEventLike } from './types.ts'

export interface SaveSessionConfig extends RenderConfig {
  artifactStoreRoot: string
  /** Topic-sequential composition (record §4.2): merge while overlap ≥ τ. */
  mergeThreshold: number
  /** Estimated-token cap per composed chapter. */
  chapterLimit: number
  /** Hard oversize multiple of `chapterTokenTarget`; past it a door refuses (#59). */
  chapterOversizeFactor?: number | undefined
}

export interface SaveSessionArgs {
  /** Full snapshot of the authoring session's durable log (the caller read it). */
  events: SessionEventLike[]
  /** The session whose registry state owns the watermark and the numbering. */
  sessionId: string
  /** Workspace cwd — where the store root lives (makeArchiveFs roots RELATIVE paths here). */
  cwd: string
  store: RegistryStore
  config: SaveSessionConfig
  /**
   * Lineage stamp for the chapter frontmatter (issue #47). Pass
   * `lineageOf(session.header)` — undefined for an ordinary session, which
   * renders byte-identically to the pre-feature shape.
   */
  subagentOf?: string | undefined
  /**
   * REPAIR ONLY (#60): archive this exact span instead of the watermark tail. A repair must re-derive a
   * specific hole (a hollow chapter's seqs, an unsigned completed turn), not "everything new".
   */
  span?: { fromSeq: number; toSeq: number } | undefined
  /**
   * REPAIR ONLY (#60): mark chapter `over` superseded by what this call writes, in the SAME registry
   * section that commits the replacement — so a record and its replacement can never be observed apart.
   */
  supersede?: { over: number; reason: SupersedeReason } | undefined
  /** REPAIR ONLY: a distinct idempotence key per repair run, so a repair is not eaten by the original save's key. */
  attemptSalt?: string | undefined
}

export type SaveSessionSkip =
  | 'no-completed-turn'
  /** Everything in the span was already archived (watermark at or past the anchor). */
  | 'nothing-new'
  /**
   * #58 — the span rendered zero conversation bytes. A payload read that went wrong, never a
   * short conversation, and never a reason to reserve a number or write a file.
   */
  | 'payloadless'
  /** The archive rendered, but a chapter blew past the hard oversize ceiling (#59). */
  | 'oversize'

export interface SaveSessionOutcome {
  /** null → the archive was written. Otherwise WHY nothing was written. */
  skipped: SaveSessionSkip | null
  fromSeq: number
  /** Last completed turn (the anchor); -1 when there is none. */
  anchor: number
  /** Highest endSeq already archived before this call (watermark). */
  lastArchived: number
  /** Chapter records already in the registry for this session, BEFORE this call. */
  priorChapters: number
  /** Records written by THIS call (empty when skipped). */
  records: ChapterRecord[]
  warnings: string[]
}

/**
 * Split a range whose RENDERED size would blow past the oversize ceiling (#60, repair path only).
 *
 * The normal doors cut on `turn/end` and warn when a chapter is over `chapterTokenTarget`, because a
 * boundary is around the corner and clipping is forbidden. A REPAIR span can be one gigantic turn — a
 * delegated subagent whose single turn ran to 4 MB — where there IS no next boundary, and refusing it
 * (the #59c gate) would leave the husk superseded-by-nothing. So the repair splits at EVENT boundaries
 * inside the turn: nothing is truncated, every byte still lands in a chapter, and the TOC gains several
 * consecutive ranges instead of one unreadable one. The rule that binds is completeness, not "one chapter
 * per turn" — and a chapter nobody can `read` back is not an archive.
 */
/**
 * #344: exported so the deterministic doors' real behaviour can be measured on real logs in a test,
 * rather than re-derived by a replica in the test that could drift from the thing it checks.
 */
export function splitOversize(
  chapters: ChapterRange[],
  events: readonly SessionEventLike[],
  chapterTokenTarget: number,
  oversizeFactor: number,
): { ranges: ChapterRange[]; notes: string[] } {
  const ceiling = Math.floor(chapterTokenTarget * oversizeFactor)
  const notes: string[] = []
  const out: ChapterRange[] = []
  for (const c of chapters) {
    const inRange = events.filter((e) => e.seq >= c.startSeq && e.seq <= c.endSeq)
    const total = inRange.reduce((m, e) => m + estimateTokens(JSON.stringify(e.data ?? {})), 0)
    if (total <= ceiling) { out.push(c); continue }
    // #344: GREEDY and size-aware, cutting at the event boundary before a part would pass the target.
    //
    // The form below divided the range into `ceil(total/ceiling)` chunks of EQUAL EVENT COUNT. Real turns
    // are wildly uneven — one tool result can be 200 KB beside a dozen two-token events — so equal counts
    // leave parts still over the ceiling and the door refuses again. Measured on the real logs after one
    // pass of the old split: 42 of 121 eadc parts, 528 of 1,397 platfolio parts, 453 of 1,386 arcnexus
    // parts remained over-limit. Subdividing "but not really" is worse than not doing it, because the
    // note claims a split happened.
    //
    // Packing greedily against `chapterTokenTarget` rather than the refusal `ceiling` keeps the
    // factor-of-two margin for the gap between this proxy — estimateTokens over the event payload — and
    // what the gate actually measures, the RENDERED markdown length. The proxy runs under the rendered
    // size, so a target-sized part can still land above target; only the ceiling refuses.
    //
    // Cuts happen between events only: a range is never re-derived or re-ordered, and one event larger
    // than the pack target travels alone rather than being sliced (invariant 1).
    const packTo = Math.max(1, Math.floor(chapterTokenTarget))
    let partStart = inRange[0]!.seq
    let partTokens = 0
    let partIndex = 0
    const flush = (endSeq: number): void => {
      out.push({
        ...c,
        title: partIndex === 0 ? c.title : `${c.title} (part ${String(partIndex + 1)})`,
        startSeq: partStart, endSeq: Math.max(partStart, endSeq),
      })
      partIndex += 1
    }
    for (const e of inRange) {
      const t = estimateTokens(JSON.stringify(e.data ?? {}))
      if (partTokens > 0 && partTokens + t > packTo) {
        flush(e.seq - 1)
        partStart = e.seq
        partTokens = 0
      }
      partTokens += t
    }
    flush(inRange[inRange.length - 1]!.seq)
    notes.push(`"${c.title}" (seqs ${String(c.startSeq)}-${String(c.endSeq)}) is ${String(total)} est tokens over a ${String(packTo)}-token target — packed into ${String(partIndex)} chapters at event boundaries (nothing truncated)`)
  }
  return { ranges: out, notes }
}

/**
 * Force a repaired archive to cover exactly the span the finding named (#60). Composition may still cut
 * it into topics - a cut is a chapter boundary, not a loss - but nothing may start above `fromSeq` or
 * stop before the last completed turn inside the span, or the hole the finding reported stays open while
 * the repair reports success.
 */
function clampSpan(
  chapters: ChapterRange[],
  fromSeq: number,
  toSeq: number,
  events: readonly { type: string; seq: number }[],
): ChapterRange[] {
  // Nothing to clamp: the span held no completed turn at all. Returning EMPTY is the honest answer —
  // inventing a title here would fabricate a chapter, and an empty `records` makes the caller skip the
  // supersede, which is exactly right: a record is never marked superseded without its replacement (#60).
  if (chapters.length === 0) return []
  const lastCompleted = events.reduce(
    (m, e) => (e.type === 'turn/end' && e.seq <= toSeq && e.seq > m ? e.seq : m), fromSeq,
  )
  return chapters.map((c, i) => ({
    ...c,
    startSeq: i === 0 ? Math.min(c.startSeq, fromSeq) : Math.max(c.startSeq, chapters[i - 1]!.endSeq + 1),
    endSeq: i === chapters.length - 1 ? lastCompleted : Math.min(c.endSeq, lastCompleted),
  }))
}

export async function saveSession(a: SaveSessionArgs): Promise<SaveSessionOutcome> {
  const { events, sessionId, cwd, store, config } = a
  if (cwd === '') throw new Error('saveSession: session has no workspace cwd — nowhere reachable to write')
  if (sessionId === '') throw new Error('saveSession: no session id to own the archive')

  // A repair targets a span it chose; every other door archives the watermark tail up to the last
  // completed turn. One pipeline, one difference (#60).
  const anchor = a.span !== undefined ? a.span.toSeq : [...events].reverse().find((e) => e.type === 'turn/end')?.seq
  if (anchor === undefined) {
    return { skipped: 'no-completed-turn', fromSeq: 0, anchor: -1, lastArchived: 0, priorChapters: 0, records: [], warnings: [] }
  }

  // Watermark: only archive what is newer than the last saved chapter.
  const state = await store.get(sessionId)
  const fromSeq = a.span !== undefined ? a.span.fromSeq : nextUnarchivedSeq(state.chapters)
  // Derived from the SAME predicate as fromSeq (#336), never a second reduce. The old form seeded at 0
  // and special-cased `lastArchived > 0`, so a chapter that legitimately covered seq 0 — every real log
  // begins with `permission/preset` at seq 0 — made this door re-archive seq 0 forever while
  // continue-core's twin did not. -1 now honestly means "nothing archived yet".
  const lastArchived = nextUnarchivedSeq(state.chapters) - 1
  // A REPAIR span is deliberate re-derivation of seqs the watermark has already passed (#60): the
  // nothing-new guard is about not re-archiving a tail, and would otherwise refuse to fix the hole a
  // hollow chapter sits exactly on top of. The span caller has already decided what needs re-rendering.
  if (a.span === undefined && fromSeq > 0 && anchor <= lastArchived) {
    return { skipped: 'nothing-new', fromSeq, anchor, lastArchived, priorChapters: state.chapters.length, records: [], warnings: [] }
  }

  // Topic-sequential composition — same pipeline as fork/continue.
  const composed = composeChapters(events, fromSeq, anchor, state.collections, {
    mergeThreshold: config.mergeThreshold,
    chapterLimit: config.chapterLimit,
  })
  let chapters = composed.chapters.length > 0
    ? composed.chapters
    : deriveRanges(events, anchor, config.chapterTokenTarget, fromSeq).chapters
  const compositionNotes: string[] = []
  if (a.span !== undefined) {
    // A repair's span is bounded by the finding, so force exactly that range: composition inside a hole
    // may cut it into topics, and a cut is fine, but nothing may start above `fromSeq` or end below the
    // last completed turn inside the span.
    chapters = clampSpan(chapters, a.span.fromSeq, a.span.toSeq, events)
  }
  // #344: subdivide over-ceiling chapters in EVERY deterministic door, not only in repair. This call used
  // to sit inside the `a.span !== undefined` arm, so `/chapters-save`, `/chapters-fork`, subagent
  // settlement and forced-child archive all refused instead — measured with the real functions on real
  // logs: eadc refused 2 of 3 turns (67%), platfolio 55 of 152, arcnexus 32 of 307, and the refused
  // range was the OPENING turn in every one. A session's first turn is exactly the thing a later
  // continuation needs, and it was the thing no deterministic door could archive.
  //
  // `splitOversize` cuts at event boundaries, so a range is never re-derived or re-ordered; only where a
  // single event exceeds the ceiling does the gate below still refuse — and now says so in the door's
  // own reply instead of reporting success.
  const split = splitOversize(chapters, events, config.chapterTokenTarget, config.chapterOversizeFactor ?? 2)
  chapters = split.ranges
  // Named for what it holds now: split notes arrive on EVERY path, not only repair.
  compositionNotes.push(...split.notes.map((n) => a.span !== undefined ? n : `subdivided to fit the ceiling: ${n}`))

  // Render + write archive (same as runContinue steps 2-3, minus child creation).
  const below = events.filter((e) => e.seq <= anchor)
  const renderConfig: RenderConfig = {
    // #348: the door already knows all three values (it passes the first two to
    // writeArchive below); the renderer needs them so a citation is a path `read` can open.
    citationBase: citationBaseOf(config.artifactStoreRoot, state.rootSession, cwd),
    toolResultDeferFloorTokens: config.toolResultDeferFloorTokens,
    chapterTokenTarget: config.chapterTokenTarget,
    ...(config.planInlineChars !== undefined ? { planInlineChars: config.planInlineChars } : {}),
    ...(config.callArgArtifactTokens !== undefined ? { callArgArtifactTokens: config.callArgArtifactTokens } : {}),
    ...(a.subagentOf !== undefined && a.subagentOf !== '' ? { subagentOf: a.subagentOf } : {}),
  }
  const rendered = chapters.map((range) => renderChapter(below, range, renderConfig, [], chapterTopics(below, range.startSeq, range.endSeq)))

  // #58 — NEVER commit an archive that rendered nothing. A `tool/call` is always preceded by an
  // `assistant/message`, so a non-empty range with zero rendered messages is not a short
  // conversation: it is a read that carried no payloads. The real instance was
  // `sessionQuery.listEvents`, whose `SessionEventRecord` rows have `seq`/`type`/`time`/`surface`
  // and no `data` — 12 children on this machine archived as `**unknown**` / `{}` / `0 B` shells.
  // The refusal is BEFORE `writeArchive`, so no number is reserved and no file is written: a
  // committed husk would poison the watermark (`max(endSeq)`), and the child could then never be
  // re-archived without a repair (#60). Refuse with numbers, never truncate — AGENTS.md.
  //
  // AMENDED #60: the test is on the ARCHIVE, not on each chapter. A repair may split one enormous turn
  // into consecutive parts, and a part holding only tool calls legitimately renders zero messages —
  // refusing the whole re-read over that stranded five SAIP children's knowledge again, which is the
  // opposite of what the gate protects. "No payloads anywhere" is the anomaly; `describeHollow` keeps
  // naming every message-free part so it is never silent, and the single-chapter case (#58's instance)
  // still refuses exactly as before.
  const describeHollow = (r: (typeof rendered)[number]): string => {
    const un = r.stats.unrenderedSeqs
    return `"${r.range.title}" spans seqs ${r.range.startSeq}..${r.range.endSeq}: ${r.stats.events} events, `
      + `${r.stats.toolCalls} tool calls, 0 rendered messages, ${un.length} unrendered`
      + `${un.length > 0 ? ` (first: ${un.slice(0, 5).join(', ')})` : ''}`
  }
  const hollow = rendered.filter((r) => r.stats.events > 0 && r.stats.messages === 0)
  if (rendered.length > 0 && hollow.length === rendered.length) {
    return {
      skipped: 'payloadless',
      fromSeq,
      anchor,
      lastArchived,
      priorChapters: state.chapters.length,
      records: [],
      warnings: hollow.map((r) => `${describeHollow(r)} — the read carried event SHAPES but no payloads; nothing was reserved or written`),
    }
  }
  // Parts that carry tool calls but no prose are reported and STILL archived (#60): "what was
  // attempted" is half the record, and silence about it is the defect class this issue is named for.
  const hollowNotes = hollow.map((r) => `${describeHollow(r)} — archived for its tool calls, not a payload failure`)

  // #59: refuse before reserving anything, exactly like the payloadless gate — a spent number with no
  // file behind it is the burned-reservation state this whole round is eliminating. The factor is
  // config, never a literal: over `chapterTokenTarget` warns, over `target × factor` refuses.
  const oversize = oversizeRanges(rendered, config.chapterTokenTarget, config.chapterOversizeFactor ?? 2)
  if (oversize.errors.length > 0) {
    return {
      skipped: 'oversize', fromSeq, anchor, lastArchived,
      priorChapters: state.chapters.length, records: [], warnings: oversize.errors,
    }
  }

  const wrote = await writeArchive({
    fs: makeArchiveFs(cwd),
    allocator: {
      // One section per allocation (#59) — identical semantics to makeAllocator, which is why the
      // shared helper is used by every other door; this door had its own copy of the race.
      async reserve(attemptId, count) {
        const { numbers } = await reserveNumbers(store, sessionId, attemptId, count)
        return numbers
      },
      async reservePlan(attemptId, count) {
        const { numbers } = await reserveNumbers(store, sessionId, attemptId, count, true)
        return numbers
      },
      async release(attemptId) {
        await store.mutate(sessionId, (state) => releaseReservation(state, attemptId))
      },
    },
    // raw value: makeArchiveFs roots RELATIVE paths at the session cwd and
    // passes absolute ones through — resolving here would double-root relative stores
    storeRoot: config.artifactStoreRoot,
    cwd,  // #69: records are stored workspace-relative
    rootSessionId: state.rootSession,
    authorSessionId: sessionId, // #337
    chapters: rendered,
    attemptId: attemptKey(sessionId, anchor, a.attemptSalt),
  })

  // Commit chapter records to session state so search index picks them up.
  if (a.supersede !== undefined && wrote.records.length > 0) {
    // Commit AND mark in one section: no reader can ever see the replacement without the old record
    // marked, or the mark without its replacement (#60).
    await store.mutate(sessionId, (fresh) => supersedeChapter(fresh, a.supersede!.over, wrote.records, a.supersede!.reason))
  } else {
    await commitChapters(store, sessionId, wrote.records, cwd)
  }

  return { skipped: null, fromSeq, anchor, lastArchived, priorChapters: state.chapters.length, records: wrote.records, warnings: [...compositionNotes, ...hollowNotes, ...oversize.indivisible, ...wrote.warnings] }
}
