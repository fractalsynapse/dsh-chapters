/**
 * Engine core — the deterministic logic behind ChaptersCompactionEngine, as
 * pure functions over minimal structural types. NO cordis, NO @deepseek-ai
 * imports: this file runs under `node --test` with no harness, which is where
 * the two scariest engine-path bugs get caught — a lost TOC bullet (silently
 * unreachable chapter) and a mis-resolved citation (wrong text archived).
 *
 * The correlation model (docs/host-compaction-seam.md + FINDINGS § Phase 0b):
 *   summarize()  — sees region CONTENT (no seqs); reserves numbers keyed by the
 *                  OPEN transaction's compactionId (found by scanning the log:
 *                  the last `compaction/start` without a matching `end` — the
 *                  durable lock guarantees uniqueness) and emits the TOC text
 *                  citing deterministic paths.
 *   finalize()   — post-commit, from authoritative CompactionResult.shadowedSeqs,
 *                  renders bodies from the DURABLE LOG, following each
 *                  `tool/result` replacement's `sourceEventSeqs` chain back to
 *                  the pre-prune original. Never from summarize's input.
 *
 * Checkpoint merge-forward: the next compaction's span usually includes the
 * previous checkpoint node (r12 measured it). Its TOC bullets are extracted
 * and re-emitted; an embedded LLM-style summary (a host `basic` checkpoint
 * from before this engine was mounted) is carried verbatim ONCE — honest,
 * bounded, and never silently dropped.
 */
import type { ChapterRange, RenderedChapter, SessionEventLike } from './types.ts'
import { chapterTopics } from './signature.ts'
import type { ChapterRecord } from './archive.ts'
import { estimateTokens, renderChapter, renderIndex } from './render.ts'
import { isInjectedProse } from './injections.ts'
import { lineageOf } from './types.ts'
import { slugify, toStoredPath } from './archive.ts'
import { isFinalized } from './registry.ts'
import type { PlanChapter, SessionState } from './registry.ts'

/** provider tag written into `compaction/summary` — our event-scan discriminator. */
export const CHAPTERS_PROVIDER = 'dsh-chapters'
export const DETERMINISTIC_MODEL = 'deterministic'

/** Framing tags the host's summarizer wraps checkpoints in (compaction-basic summarizer.ts:21-22). */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** One TOC bullet, as re-parsed from prior checkpoints — the accumulation unit. */
export interface TocBullet {
  title: string
  path: string
  summary: string
}

export interface EngineConfig {
  /** Workspace cwd, so a resolved-absolute store root still yields workspace-relative records (#69). */
  workspaceCwd?: string | undefined
  /** Workspace-relative archive root; must be reachable by the `read` tool. */
  artifactStoreRoot: string
  /**
   * #85: where approved rules and the knowledge pool are read from when a notice is composed.
   * Defaults to the historical `.dsh-knowledge` for real installs; an e2e boot pins it per port,
   * because a tape is a claim about ONE world and a fixed path inside the developer's repo is not
   * part of that world.
   */
  knowledgeMirrorDir: string
  chapterTokenTarget: number
  toolResultDeferFloorTokens: number
  /** Composer tunables (record §4.2/§12) — same register, same defaults as the host plugin's. */
  mergeThreshold: number
  chapterLimit: number
  /** #61 Amendment A — the seventh archive moment (see auto-save.ts `shouldForceChildArchive`). */
  childAutoArchive?: boolean | undefined
  childAutoArchiveMinTurns?: number | undefined
  /** Arrival-time artifacting floor (architecture.md amendment 2026-09-19):
   * tool results at/above this many estimated tokens are stored as artifacts
   * and replaced by reference stubs BEFORE the next request is composed. */
  toolResultArtifactTokens: number
  /** Verbatim plan characters printed in a chapter's Plans block (plans-carriage § 2).
   * The full plan is ALWAYS artifact-backed, so this is display economy, not data. */
  planInlineChars: number
  /** Above this many estimated tokens a tool-call ARGUMENT is artifact-backed and the
   * inline text is a bounded head. 0 = off (default): enabling it changes chapter
   * bytes, hence the model tapes — a deployment opts in deliberately. */
  callArgArtifactTokens: number
  /** Elicit a plot note with one bounded call when the model wrote none. */
  elicitedPlot: boolean
  /**
   * Carry the operative session plan into every in-place checkpoint (the PLOT
   * mechanism, applied to plans — docs/plans-carriage.md § 9). Shadowing can hide the
   * chapter that holds a plan; a directive that survives only in a file the agent may
   * never open is a directive it drifts from.
   */
  plansInCheckpoint: boolean
  /** Bounded plan characters carried in the checkpoint text; the archive keeps all. */
  planCheckpointChars: number
}

export const ENGINE_CONFIG_DEFAULTS: EngineConfig = {
  artifactStoreRoot: '.dsh-chapters',
  knowledgeMirrorDir: '.dsh-knowledge',
  chapterTokenTarget: 8000,
  toolResultDeferFloorTokens: 200,
  mergeThreshold: 0.3,
  chapterLimit: 8000,

  toolResultArtifactTokens: 8000,
  planInlineChars: 900,
  callArgArtifactTokens: 0,
  elicitedPlot: true,
  plansInCheckpoint: true,
  planCheckpointChars: 1600,}

// ---------------------------------------------------------------- input/output vocabulary
// Structural restatements of @deepseek-ai/dsh-compaction-basic's SummarizationInput /
// SummaryResult (the npm package does not export those types from its root entry).
// test/engine-core.test.ts drift-guards them against the installed d.ts.

export interface SummarizeInputLike {
  readonly tools?: readonly unknown[]
  readonly messages: readonly EngineMessage[]
}

export interface EngineMessage {
  readonly role: string
  readonly content?: readonly { type: string; text?: string }[]
}

export interface SummarizeResultLike {
  summary: { type: 'text'; text: string }[]
  provider: string
  model: string
}

// ---------------------------------------------------------------- minimal session surface

/** The slice of `Session` the core reads. Kept small so fakes are honest. */
export interface EngineSession {
  readonly id: string
  readonly seq: number
  eventAt(seq: number): EngineSessionEvent | undefined
  /**
   * Present on the real host Session (a class) — `reconstructShadowedSeqs`
   * needs them to map summarize-input messages back to log seqs. Absence of
   * either simply means: no reconstruction, legacy single-chapter compaction.
   */
  readonly surface?: { readonly nodes?: readonly { readonly seq: number }[] }
  deriveEventMessage?(event: EngineSessionEvent): EngineMessage | null | undefined
}

export interface EngineSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly sourceEventSeqs?: readonly number[]
  readonly data?: Record<string, unknown>
}

// ---------------------------------------------------------------- text helpers

const messageText = (msg: EngineMessage | undefined): string =>
  (msg?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')

/** Every `<compacted-summary>…</compacted-summary>` block in the region, in order. */
export function extractCheckpointBlocks(messages: readonly EngineMessage[]): string[] {
  const blocks: string[] = []
  for (const msg of messages) {
    const text = messageText(msg)
    let from = 0
    for (;;) {
      const open = text.indexOf(SUMMARY_OPEN_TAG, from)
      if (open === -1) break
      const close = text.indexOf(SUMMARY_CLOSE_TAG, open)
      if (close === -1) { blocks.push(text.slice(open + SUMMARY_OPEN_TAG.length)); break }
      blocks.push(text.slice(open + SUMMARY_OPEN_TAG.length, close))
      from = close + SUMMARY_CLOSE_TAG.length
    }
  }
  return blocks
}

/** `N. [Title](path) — summary` as rendered by renderIndex; the accumulation format. */
const BULLET = /^\s*\d+\.\s+\[(.*?)\]\((.*?)\)\s+—\s+(.*)$/

/**
 * Merge-forward: parse prior bullets out of every checkpoint block. Lines that
 * are not our bullet format (e.g. an LLM summary produced by `basic` before
 * this engine took over) are returned as verbatim carry-overs — dropping them
 * would be exactly the loss this plugin exists to prevent.
 */
export function parseTocState(blocks: readonly string[]): {
  bullets: TocBullet[]
  carriedProse: string[]
} {
  const bullets: TocBullet[] = []
  const carriedProse: string[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    let blockHadBullets = false
    for (const line of block.split('\n')) {
      const m = BULLET.exec(line)
      if (m === null) continue
      blockHadBullets = true
      const bullet = { title: m[1]!, path: m[2]!, summary: m[3]! }
      if (seen.has(bullet.path)) continue // accumulation dedups by path; numbers may repeat across roots
      seen.add(bullet.path)
      bullets.push(bullet)
    }
    if (!blockHadBullets && block.trim().length > 0) carriedProse.push(block.trim())
  }
  return { bullets, carriedProse }
}

// ---------------------------------------------------------------- transaction scanning

/**
 * The open transaction's compactionId: the latest `compaction/start` with no
 * later `compaction/end` carrying the same id. The base appends the start
 * BEFORE awaiting summarize (region.ts:211) and the durable lock admits only
 * one open transaction per session — so a backward scan finds exactly it.
 */
export function findOpenCompactionId(session: EngineSession): string | null {
  const closed = new Set<string>()
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const ev = session.eventAt(seq)
    const raw = ev?.data?.compactionId
    const cid = typeof raw === 'string' && raw.length > 0 ? raw : null
    if (ev?.type === 'compaction/end' && cid !== null) { closed.add(cid); continue }
    if (ev?.type === 'compaction/start' && cid !== null && !closed.has(cid)) return cid
  }
  return null
}

/** All OUR finalized-or-not summary events (provider-tagged), oldest first. */
export function scanChaptersSummaries(session: EngineSession): Array<{ compactionId: string; summarySeq: number; shadowedSeqs: number[] }> {
  const out: Array<{ compactionId: string; summarySeq: number; shadowedSeqs: number[] }> = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const ev = session.eventAt(seq)
    if (ev?.type !== 'compaction/summary') continue
    if (ev.data?.provider !== CHAPTERS_PROVIDER) continue
    const cid = ev.data?.compactionId
    const shadowed = ev.data?.shadowedSeqs
    if (typeof cid !== 'string' || !Array.isArray(shadowed)) continue
    out.push({ compactionId: cid, summarySeq: seq, shadowedSeqs: shadowed.map(Number) })
  }
  return out
}

// ---------------------------------------------------------------- citation resolution

/**
 * Follow `tool/result` replacement chains to the first version (the un-pruned
 * original). Only single-cited tool results qualify — a compaction checkpoint
 * `user/message` also carries sourceEventSeqs, and following THOSE would pull
 * lifecycle bookkeeping into chapter bodies.
 */
export function resolveOriginalEvent(session: EngineSession, seq: number): EngineSessionEvent | undefined {
  let cursor = seq
  const guard = new Set<number>()
  for (;;) {
    if (guard.has(cursor)) throw new Error(`resolveOriginalEvent: citation cycle at seq ${cursor}`)
    guard.add(cursor)
    const ev = session.eventAt(cursor)
    if (ev === undefined) throw new Error(`resolveOriginalEvent: missing event at ${cursor}`)
    if (ev.type !== 'tool/result') return ev
    const cited = ev.sourceEventSeqs
    if (cited === undefined || cited.length !== 1) return ev
    cursor = cited[0]!
  }
}

// ---------------------------------------------------------------- planning

export interface SummarizePlan {
  /** TOC text for the checkpoint (what summarize returns). */
  tocText: string
  /** Chapter numbers reserved during planning — attemptId `compaction:${id}`. */
  numbers: number[]
  /** Everything finalize needs, since finalize cannot re-derive the title. */
  chapter: { title: string; summary: string; path: string }
  /**
   * Topic-composed plan (r29): when the composer ran over the span, one
   * manifest chapter per composed range — finalize renders exactly these,
   * it never recomposes (the TOC cited them; determinism is the contract).
   */
  chapters?: PlanChapter[]
}


/** Deterministic title/summary from region content. Never model-authored (invariant 4 — the model is absent). */
export function deriveIdentity(
  messages: readonly EngineMessage[],
  hasCheckpoint: boolean,
  /**
   * A plan submitted inside this span, when there is one (docs/plans-carriage.md
   * § 6): the submission IS the identity of a planning chapter, and it beats the
   * first prose line the same way a file's own header beats a guess about it.
   * Callers that hold events pass it; the summarize path, which sees provider
   * messages only, passes nothing and keeps the old derivation.
   */
  planTitle?: string,
): { title: string; summary: string } {
  // Title source: the first USER message that is actual human/agent prose.
  // Harness injections (system reminders, runtime-context snapshots) ride as
  // user messages too — an earlier fork titled a chapter "System reminder 1"
  // from a runtime snapshot that happened to open the span. Skip them; the
  // r29 command tests pin this behavior.
  // The same predicate that screens chapter BODIES chooses a title (#59). Two lists of what counts as
  // injected context is how a runtime snapshot became a filename and a TOC citation.
  const firstUser = messages.find((m) => m.role === 'user'
    && !messageText(m).includes(SUMMARY_OPEN_TAG)
    && !isInjectedProse(messageText(m)))
  const userCount = messages.filter((m) => m.role === 'user').length
  const assistantCount = messages.filter((m) => m.role === 'assistant').length
  const headLine = planTitle !== undefined && planTitle.trim() !== ''
    ? planTitle.trim()
    : firstUser === undefined ? '' : messageText(firstUser).split('\n')[0]!.trim()
  const title = headLine.length > 0
    ? headLine.length > 72 ? `${headLine.slice(0, 72)}…` : headLine
    : hasCheckpoint ? 'Earlier history' : 'Conversation span'
  return {
    title,
    summary: `${userCount} user / ${assistantCount} assistant messages (${estimateTokens(
      messages.map(messageText).join(' '),
    )} est tokens)`,
  }
}

/** Workspace-relative chapter path for a reserved number. */
export const chapterPathFor = (config: EngineConfig, rootSession: string, number: number, title: string): string =>
  // #69: normalized at the mint. The realm resolves an ABSOLUTE store root to reach the filesystem, but
  // the RECORD must carry the workspace-relative form, or chapter 1 written by compaction never matches
  // the same file listed from disk and the auditor reports its own archive as lost knowledge.
  toStoredPath(config.workspaceCwd,
    `${config.artifactStoreRoot.replace(/\/+$/, '')}/${rootSession}/chapters/${String(number).padStart(3, '0')}-${slugify(title)}.md`)

/**
 * Map the prepared summarize input back to the log seqs it was built from
 * (the host builds region messages as `deriveEventMessage(eventAt(seq))` for
 * the shadowed selection). Returns null — meaning "use the legacy
 * single-chapter path" — whenever the Session lacks the mapping API, nothing
 * matches, or MORE THAN ONE contiguous run matches (duplicate small
 * messages are common; guessing a wrong span would cite chapters that never
 * cover their seqs, and an honest legacy chapter beats that).
 */
export function reconstructShadowedSeqs(
  session: EngineSession,
  input: SummarizeInputLike,
): number[] | null {
  const nodes = session.surface?.nodes
  const derive = session.deriveEventMessage
  if (nodes === undefined || nodes.length === 0 || derive === undefined) return null
  let region: readonly EngineMessage[] = input.messages
  if (region[0]?.role === 'system') region = region.slice(1) // the prepended system head
  if (region.length === 0) return null
  const encoded = region.map((m) => JSON.stringify(m))
  const matches: number[][] = []
  for (let start = 0; start < nodes.length && matches.length < 2; start += 1) {
    const seqs: number[] = []
    let mi = 0
    let ok = true
    for (let ni = start; ni < nodes.length && mi < encoded.length; ni += 1) {
      const ev = session.eventAt(nodes[ni]!.seq)
      if (ev === undefined) continue
      const msg = derive(ev)
      if (msg === null || msg === undefined) continue
      if (JSON.stringify(msg) !== encoded[mi]) { ok = false; break }
      seqs.push(ev.seq)
      mi += 1
    }
    if (ok && mi === encoded.length && seqs.length > 0) matches.push(seqs)
  }
  return matches.length === 1 ? matches[0]! : null
}

/**
 * The summarize-time plan: merge prior bullets, derive this span's identity,
 * reserve numbers (attempt-keyed by the OPEN transaction's compactionId),
 * build the TOC. Pure given the state; the caller persists the returned
 * state change BEFORE this text can ever be cited.
 *
 * `composition` (r29): topic-sequential ranges from the composer (record
 * §4.2), spanning the whole selected region head-to-tail (the adapter
 * absorbs any strays). Present => reserve one number per chapter and cite
 * them all; absent => the legacy single-chapter identity path, unchanged.
 */
export function planSummarize(
  session: EngineSession,
  state: SessionState,
  input: SummarizeInputLike,
  config: EngineConfig,
  reserveFn: (state: SessionState, attemptId: string, count: number) => { state: SessionState; numbers: number[] },
  /** Required: the caller fails loudly when no `compaction/start` is open. */
  compactionId: string,
  composition: readonly ChapterRange[] | null = null,
  /** Model-authored plot note carried into this checkpoint (may be null). */
  plot: string | null = null,
  /**
   * The operative plan, already rendered as checkpoint prose by `carryActivePlan`
   * (plans.ts). Carried on BOTH the composed and the legacy path, because the
   * composed path is where real pressure compaction lands. Note the asymmetry this
   * deliberately does NOT touch: `plot` is still only prefixed on the legacy path
   * (`:415`), and changing that would rewrite checkpoint bytes for every plot-carrying
   * session — i.e. the committed tapes. Plans are new, so carrying them is free.
   */
  planCarry: string | null = null,
  /**
   * #50 §7.6 — the rules block carried across this checkpoint, already rendered
   * by the ONE builder that renders it for the notice too (`rules.buildRulesSection`).
   * This is the hole the round exists to close: `leadSections` was
   * `[planSection, plotSection]`, so a plan and a plot survived a compaction and a
   * RULE did not. Null (nothing active, or the corpus unreadable) renders ZERO
   * bytes — which is what keeps every committed plot-carrying checkpoint intact.
   */
  rulesCarry: string | null = null,
): { plan: SummarizePlan; state: SessionState } {
  const planSection = planCarry !== null && planCarry.trim() !== ''
    ? `Active plan — carried across this checkpoint (it is STILL the work directive):\n\n${planCarry.trim()}`
    : null
  const rulesSection = rulesCarry !== null && rulesCarry.trim() !== '' ? rulesCarry.trim() : null
  const leadSections0 = [planSection, rulesSection].filter((x): x is string => x !== null && x !== '')
  const blocks = extractCheckpointBlocks(input.messages)
  const { bullets, carriedProse } = parseTocState(blocks)
  const identity = deriveIdentity(input.messages, blocks.length > 0)

  const attemptId = `compaction:${compactionId}`

  if (composition !== null && composition.length > 0) {
    const reserved = reserveFn(state, attemptId, composition.length)
    const usedPaths = new Set<string>()
    const chapters: PlanChapter[] = composition.map((range, i) => {
      const number = reserved.numbers[i]!
      let path = chapterPathFor(config, state.rootSession, number, range.title)
      // Mirror writeArchive's collision rule so the cited path can never dangle.
      if (usedPaths.has(path)) path = path.replace(/\.md$/, `-${number}.md`)
      usedPaths.add(path)
      return { number, path, title: range.title, summary: range.summary, startSeq: range.startSeq, endSeq: range.endSeq }
    })
    const allBullets = [...bullets, ...chapters.map((c) => ({ title: c.title, path: c.path, summary: c.summary }))]
    const index = renderIndex(allBullets)
    const quote = (p: string): string => p.split('\n').map((l) => `> ${l}`).join('\n')
    const composedParts: string[] = [
      `Chapter archive: ${allBullets.length} chapter(s) under ${config.artifactStoreRoot}/ — verbatim text; reload any with the read tool on its path.`,
      'Tool results shown as head+…+tail in the replaced history were archived in full; oversized ones are file references inside the chapter.',
      index,
    ]
    if (carriedProse.length > 0) {
      composedParts.push('Earlier summary carried forward (not chapter-formatted):', ...carriedProse.map(quote))
    }
    return {
      plan: {
        tocText: leadSections0.length === 0
          ? composedParts.join('\n\n')
          : `${leadSections0.join('\n\n')}\n\n${composedParts.join('\n\n')}`,
        numbers: reserved.numbers,
        chapter: { title: chapters[0]!.title, summary: chapters[0]!.summary, path: chapters[0]!.path },
        chapters,
      },
      state: reserved.state,
    }
  }
  const reserved = reserveFn(state, attemptId, 1)
  const number = reserved.numbers[0]!
  const path = chapterPathFor(config, state.rootSession, number, identity.title)

  const allBullets = [...bullets, { title: identity.title, path, summary: identity.summary }]
  const index = renderIndex(allBullets)
  const quote = (p: string): string => p.split('\n').map((l) => `> ${l}`).join('\n')
  const parts: string[] = [
    `Chapter archive: ${allBullets.length} chapter(s) under ${config.artifactStoreRoot}/ — verbatim text; reload any with the read tool on its path.`,
    'Tool results shown as head+…+tail in the replaced history were archived in full; oversized ones are file references inside the chapter.',
    index,
  ]
  if (carriedProse.length > 0) {
    parts.push('Earlier summary carried forward (not chapter-formatted):', ...carriedProse.map(quote))
  }
  const plotSection = plot !== null && plot.trim() !== ''
    ? `Working plot (model-authored, carried across this checkpoint):\n\nPLOT: ${plot.trim()}\n\n(If it has gone stale, revise it in your next reply.)`
    : null
  const leadSections = [planSection, rulesSection, plotSection].filter((x): x is string => x !== null && x !== '')
  const tocText = leadSections.length === 0 ? parts.join('\n\n') : `${leadSections.join('\n\n')}\n\n${parts.join('\n\n')}`

  return {
    plan: {
      tocText,
      numbers: reserved.numbers,
      chapter: { title: identity.title, summary: identity.summary, path },
    },
    state: reserved.state,
  }
}

/**
 * The plot note (architecture.md amendment 2026-09-19): a short forward-
 * maintained statement of what the agent is MID-WAY through, authored by the
 * model itself and carried forward across every in-place checkpoint.
 */
export const PLOT_MARKER = 'PLOT:'

/**
 * Latest plot paragraph in the region about to be shadowed. Assistant text
 * wins; a PLOT carried in an earlier checkpoint (user-role, plugin-sourced)
 * is the fallback, so the thread survives repeatedly shadowed chains.
 * Returns the paragraph text WITHOUT the marker line, capped at maxChars.
 *
 * Shaped by the 2026-09-25 real-world audit (treeseed's first four-session
 * run): ALL EIGHT checkpoints carried a "plot" that was actually the persona
 * suffix's own instruction text — `...end each reply with one line beginning
 * 'PLOT:' (max 60 words — objective...)`. A raw substring scan matched that
 * quoted marker, and because the result was non-null it also SUPPRESSED the
 * bounded elicited fallback: every session silently inherited boilerplate
 * instead of a plot. Extraction now honors the contract the marker lives in:
 *   - the marker must START a line ("one line beginning 'PLOT:'" —
 *     mid-sentence quotes are instructions, not plots);
 *   - system-role messages never yield a plot (invariant 4's cousin: the
 *     MODEL authors plots; the prompt only asks for them);
 *   - bodies echoing the instruction template are rejected (belt and braces
 *     for historical sessions where such text already rides in user
 *     messages).
 * A null result now genuinely means "no plot authored" — which is exactly
 * when the bounded elicited fallback must run.
 */
const PLOT_LINE = /^[ \t]*PLOT:[ \t]*([^\n]*)/gm
const PLOT_TEMPLATE_ECHO = /max \d+ words|carries this plot forward|revise it on your next plot line/i

export function extractPlot(messages: readonly EngineMessage[], maxChars = 900): string | null {
  const scan = (roleWanted: 'assistant' | 'any'): string | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: string }
      if (m.role === 'system') continue
      if (roleWanted === 'assistant' && m.role !== 'assistant') continue
      const text = messageText(messages[i])
      let found: string | null = null
      for (const line of text.matchAll(PLOT_LINE)) {
        const body = (line[1] ?? '').trim()
        if (body.length === 0) continue
        if (PLOT_TEMPLATE_ECHO.test(body)) continue
        found = body
      }
      if (found !== null) return found.length > maxChars ? found.slice(0, maxChars) + '…' : found
    }
    return null
  }
  return scan('assistant') ?? scan('any')
}

// ---------------------------------------------------------------- finalization

/**
 * Post-commit: render the chapter body for one compaction from the durable
 * log (citation-resolved), and return the record to commit. The caller writes
 * files (via archive.writeArchive) and persists state; this stays pure over
 * the event data so the pruner-composition rule is testable.
 */
export function buildFinalizedChapter(
  session: EngineSession,
  shadowedSeqs: readonly number[],
  plan: SummarizePlan,
  config: EngineConfig,
): RenderedChapter {
  const events: SessionEventLike[] = shadowedSeqs.map((seq) => {
    const ev = resolveOriginalEvent(session, seq)
    if (ev === undefined) throw new Error(`buildFinalizedChapter: event vanished at ${seq}`)
    return ev as SessionEventLike
  })
  const lo = Math.min(...shadowedSeqs, ...events.map((e) => e.seq))
  const hi = Math.max(...shadowedSeqs, ...events.map((e) => e.seq))
  // Subagent lineage (issue #47): a compacting child stamps the same header fact
  // the save doors do — undefined for ordinary sessions, byte-identical output.
  const lineage = lineageOf((session as { header?: { parentSession?: string } }).header)
  return renderChapter(events, {
    title: plan.chapter.title,
    summary: plan.chapter.summary,
    startSeq: lo,
    endSeq: hi,
  }, {
    chapterTokenTarget: config.chapterTokenTarget,
    toolResultDeferFloorTokens: config.toolResultDeferFloorTokens,
    planInlineChars: config.planInlineChars,
    callArgArtifactTokens: config.callArgArtifactTokens,
    ...(lineage !== undefined ? { subagentOf: lineage } : {}),
  }, [], chapterTopics(events, lo, hi))
}

/**
 * Render the manifest's chapters (r29) — authoritative ranges, no
 * recomposition (the TOC cited them). A plan without composed chapters
 * returns the legacy single render. Mismatch between manifest and the
 * committed shadowed span is a LOUD error: the finalizer defers and warns,
 * never silently archives the wrong content.
 */
export function buildFinalizedChapters(
  session: EngineSession,
  shadowedSeqs: readonly number[],
  plan: SummarizePlan,
  config: EngineConfig,
): RenderedChapter[] {
  const composed = plan.chapters
  if (composed === undefined || composed.length === 0) {
    return [buildFinalizedChapter(session, shadowedSeqs, plan, config)]
  }
  const events = shadowedSeqs.map((seq) => {
    const ev = resolveOriginalEvent(session, seq)
    if (ev === undefined) throw new Error(`buildFinalizedChapters: event vanished at ${seq}`)
    return ev as SessionEventLike
  })
  const shadowMin = Math.min(...shadowedSeqs)
  const shadowMax = Math.max(...shadowedSeqs)
  const last = composed[composed.length - 1]!
  if (composed[0]!.startSeq > shadowMin || last.endSeq < shadowMax) {
    throw new Error(`buildFinalizedChapters: manifest [${composed[0]!.startSeq}..${last.endSeq}] does not cover shadowed [${shadowMin}..${shadowMax}] — reconstruction drift`)
  }
  const lineage = lineageOf((session as { header?: { parentSession?: string } }).header)
  const renderCfg = {
    chapterTokenTarget: config.chapterTokenTarget,
    toolResultDeferFloorTokens: config.toolResultDeferFloorTokens,
    planInlineChars: config.planInlineChars,
    callArgArtifactTokens: config.callArgArtifactTokens,
    ...(lineage !== undefined ? { subagentOf: lineage } : {}),
  }
  return composed.map((ch) => {
    const inRange = events.filter((e) => e.seq >= ch.startSeq && e.seq <= ch.endSeq)
    if (inRange.length === 0) {
      throw new Error(`buildFinalizedChapters: chapter ${ch.number} [${ch.startSeq}..${ch.endSeq}] holds no shadowed events`)
    }
    // The WHOLE shadowed list goes in, not just this chapter's events: a plan
    // verdict can land past a composed boundary, and pairing inside one range
    // only would print an approved plan as pending (plans-carriage § 1).
    // renderChapter filters to the range itself.
    return renderChapter(events, {
      title: ch.title,
      summary: ch.summary,
      startSeq: Math.min(...inRange.map((e) => e.seq)),
      endSeq: Math.max(...inRange.map((e) => e.seq)),
    }, renderCfg, [], chapterTopics(inRange, ch.startSeq, ch.endSeq))
  })
}

/** The registry record shape written post-writeArchive for an engine chapter. */
export function engineRecord(plan: SummarizePlan, shadowedSeqs: readonly number[], rendered: RenderedChapter, writtenPath: string, sha256hex: string): ChapterRecord {
  return {
    number: plan.numbers[0]!,
    path: writtenPath,
    title: plan.chapter.title,
    summary: plan.chapter.summary,
    startSeq: rendered.range.startSeq,
    endSeq: rendered.range.endSeq,
    topics: rendered.topics,
    messages: rendered.stats.messages,
    shadowedSeqs: [...shadowedSeqs],
    sha256: sha256hex,
    estimatedTokens: rendered.stats.estimatedTokens,
    artifacts: rendered.artifacts.map((a) => ({ path: a.path, sha256: a.sha256, bytes: a.bytes })),
    ...(rendered.stats.plans !== undefined && rendered.stats.plans.length > 0 ? { plans: rendered.stats.plans } : {}),
    ...(rendered.stats.planMode !== undefined && rendered.stats.planMode !== 'unknown' ? { planMode: rendered.stats.planMode } : {}),
  }
}

/** Numbers the plan reserved, or null when the manifest disagrees (corruption). */
/**
 * Walk the provider-tagged summaries of one session and finalize each that is not yet finalized,
 * ONE AT A TIME (#59): an item whose manifest is gone is reported and skipped, never allowed to
 * abort the items behind it. Pure over injected effects so the poison-pill case is testable without
 * a host.
 */
export async function scanAndFinalize(
  state: SessionState,
  summaries: readonly { compactionId: string; summarySeq: number; shadowedSeqs: number[] }[],
  finalizeOne: (found: { compactionId: string; summarySeq: number; shadowedSeqs: number[] }) => Promise<void>,
  onSkip?: (reason: { compactionId: string; reason: string }, error: unknown) => void,
): Promise<{ done: string[]; skipped: Array<{ compactionId: string; reason: string }> }> {
  const done: string[] = []
  const skipped: Array<{ compactionId: string; reason: string }> = []
  for (const found of summaries) {
    if (isFinalized(state, found.compactionId)) continue
    const hasManifest = state.plans[found.compactionId] !== undefined
      && state.reservations[`compaction:${found.compactionId}`] !== undefined
    if (!hasManifest) {
      // The field case: the manifest row was erased by a stale whole-row put. Nothing can write the
      // chapter now (the cited path/number are not durable), so say which and move on.
      skipped.push({ compactionId: found.compactionId, reason: 'no-manifest' })
      onSkip?.({ compactionId: found.compactionId, reason: 'no-manifest' }, new Error('no durable plan/reservation'))
      continue
    }
    try {
      await finalizeOne(found)
      done.push(found.compactionId)
    } catch (error) {
      // Keep the rest of the queue alive; the item itself stays un-finalized and is retried next touch.
      skipped.push({ compactionId: found.compactionId, reason: 'finalize-failed' })
      onSkip?.({ compactionId: found.compactionId, reason: 'finalize-failed' }, error)
    }
  }
  return { done, skipped }
}

export function assertReservationMatchesPlan(state: SessionState, compactionId: string, plan: SummarizePlan): boolean {
  const got = state.reservations[`compaction:${compactionId}`]
  return got !== undefined && got.length === plan.numbers.length && got.every((n, i) => n === plan.numbers[i])
}
