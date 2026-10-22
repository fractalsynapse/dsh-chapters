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
import { estimateTokens, oversizeRanges, renderChapter } from './render.ts'
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
import { supersedeChapter, type FindingClass } from './repair.ts'
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
  supersede?: { over: number; reason: FindingClass } | undefined
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
function splitOversize(
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
    const parts = Math.ceil(total / ceiling)
    const perPart = Math.ceil(inRange.length / parts)
    let title = c.title
    for (let i = 0, n = 0; i < inRange.length; i += perPart, n++) {
      const from = inRange[i]!.seq
      const to = inRange[Math.min(i + perPart, inRange.length) - 1]!.seq
      out.push({ ...c, title: n === 0 ? title : `${title} (part ${n + 1})`, startSeq: from, endSeq: to })
    }
    notes.push(`"${c.title}" (seqs ${c.startSeq}-${c.endSeq}) is ${total} est tokens in a single unfinished turn — split into ${parts} chapters at event boundaries (repair path; nothing truncated)`)
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
  const lastArchived = state.chapters.reduce((m, c) => Math.max(m, c.endSeq), 0)
  const fromSeq = a.span !== undefined ? a.span.fromSeq : (lastArchived > 0 ? lastArchived + 1 : 0)
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
  const repairNotes: string[] = []
  if (a.span !== undefined) {
    // A repair's span is bounded by the finding, so force exactly that range: composition inside a hole
    // may cut it into topics, and a cut is fine, but nothing may start above `fromSeq` or end below the
    // last completed turn inside the span.
    chapters = clampSpan(chapters, a.span.fromSeq, a.span.toSeq, events)
    // A repair span may be one enormous turn; the oversize gate would refuse it and leave the husk
    // un-replaced. Split inside it at event boundaries — see `splitOversize`.
    const split = splitOversize(chapters, events, config.chapterTokenTarget, config.chapterOversizeFactor ?? 2)
    chapters = split.ranges
    repairNotes.push(...split.notes)
  }

  // Render + write archive (same as runContinue steps 2-3, minus child creation).
  const below = events.filter((e) => e.seq <= anchor)
  const renderConfig: RenderConfig = {
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
  const hollow = rendered.filter((r) => r.stats.events > 0 && r.stats.messages === 0)
  if (hollow.length > 0) {
    return {
      skipped: 'payloadless',
      fromSeq,
      anchor,
      lastArchived,
      priorChapters: state.chapters.length,
      records: [],
      warnings: hollow.map((r) => {
        const un = r.stats.unrenderedSeqs
        return `"${r.range.title}" spans seqs ${r.range.startSeq}..${r.range.endSeq}: ${r.stats.events} events, `
          + `${r.stats.toolCalls} tool calls, 0 rendered messages, ${un.length} unrendered`
          + `${un.length > 0 ? ` (first: ${un.slice(0, 5).join(', ')})` : ''}`
          + ' — the read carried event SHAPES but no payloads; nothing was reserved or written'
      }),
    }
  }

  // #59: refuse before reserving anything, exactly like the payloadless gate — a spent number with no
  // file behind it is the burned-reservation state this whole round is eliminating. The factor is
  // config, never a literal: over `chapterTokenTarget` warns, over `target × factor` refuses.
  const tooBig = oversizeRanges(rendered, config.chapterTokenTarget, config.chapterOversizeFactor ?? 2)
  if (tooBig.length > 0) {
    return {
      skipped: 'oversize', fromSeq, anchor, lastArchived,
      priorChapters: state.chapters.length, records: [], warnings: tooBig,
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
    rootSessionId: state.rootSession,
    chapters: rendered,
    attemptId: attemptKey(sessionId, anchor, a.attemptSalt),
  })

  // Commit chapter records to session state so search index picks them up.
  if (a.supersede !== undefined && wrote.records.length > 0) {
    // Commit AND mark in one section: no reader can ever see the replacement without the old record
    // marked, or the mark without its replacement (#60).
    await store.mutate(sessionId, (fresh) => supersedeChapter(fresh, a.supersede!.over, wrote.records, a.supersede!.reason))
  } else {
    await commitChapters(store, sessionId, wrote.records)
  }

  return { skipped: null, fromSeq, anchor, lastArchived, priorChapters: state.chapters.length, records: wrote.records, warnings: [...repairNotes, ...wrote.warnings] }
}
