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
import { renderChapter } from './render.ts'
import { chapterTopics } from './signature.ts'
import { makeArchiveFs, commitChapters, type RegistryStore } from './store.ts'
import { reserve, reservePlan as reservePlanNumber } from './registry.ts'
import { writeArchive, attemptKey } from './archive.ts'
import type { ChapterRecord } from './archive.ts'
import type { RenderConfig, SessionEventLike } from './types.ts'

export interface SaveSessionConfig extends RenderConfig {
  artifactStoreRoot: string
  /** Topic-sequential composition (record §4.2): merge while overlap ≥ τ. */
  mergeThreshold: number
  /** Estimated-token cap per composed chapter. */
  chapterLimit: number
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

export async function saveSession(a: SaveSessionArgs): Promise<SaveSessionOutcome> {
  const { events, sessionId, cwd, store, config } = a
  if (cwd === '') throw new Error('saveSession: session has no workspace cwd — nowhere reachable to write')
  if (sessionId === '') throw new Error('saveSession: no session id to own the archive')

  const anchor = [...events].reverse().find((e) => e.type === 'turn/end')?.seq
  if (anchor === undefined) {
    return { skipped: 'no-completed-turn', fromSeq: 0, anchor: -1, lastArchived: 0, priorChapters: 0, records: [], warnings: [] }
  }

  // Watermark: only archive what is newer than the last saved chapter.
  const state = await store.get(sessionId)
  const lastArchived = state.chapters.reduce((m, c) => Math.max(m, c.endSeq), 0)
  const fromSeq = lastArchived > 0 ? lastArchived + 1 : 0
  if (fromSeq > 0 && anchor <= lastArchived) {
    return { skipped: 'nothing-new', fromSeq, anchor, lastArchived, priorChapters: state.chapters.length, records: [], warnings: [] }
  }

  // Topic-sequential composition — same pipeline as fork/continue.
  const composed = composeChapters(events, fromSeq, anchor, state.collections, {
    mergeThreshold: config.mergeThreshold,
    chapterLimit: config.chapterLimit,
  })
  const chapters = composed.chapters.length > 0
    ? composed.chapters
    : deriveRanges(events, anchor, config.chapterTokenTarget, fromSeq).chapters

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

  const wrote = await writeArchive({
    fs: makeArchiveFs(cwd),
    allocator: {
      async reserve(attemptId, count) {
        const fresh = await store.get(sessionId)
        const r = reserve(fresh, attemptId, count)
        await store.put(sessionId, r.state)
        return r.numbers
      },
      async reservePlan(attemptId, count) {
        const fresh = await store.get(sessionId)
        const r = reservePlanNumber(fresh, attemptId, count)
        await store.put(sessionId, r.state)
        return r.numbers
      },
    },
    // raw value: makeArchiveFs roots RELATIVE paths at the session cwd and
    // passes absolute ones through — resolving here would double-root relative stores
    storeRoot: config.artifactStoreRoot,
    rootSessionId: state.rootSession,
    chapters: rendered,
    attemptId: attemptKey(sessionId, anchor),
  })

  // Commit chapter records to session state so search index picks them up.
  await commitChapters(store, sessionId, wrote.records)

  return { skipped: null, fromSeq, anchor, lastArchived, priorChapters: state.chapters.length, records: wrote.records, warnings: wrote.warnings }
}
