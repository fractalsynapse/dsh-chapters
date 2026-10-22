/**
 * chapters_continue — pure orchestration of a citation-linked continuation,
 * behind ports (docs/development.md § L0: this file imports no cordis and no
 * @deepseek-ai package; `src/tools.ts` adapts it).
 *
 * Order is the atomicity contract (docs/architecture.md § Atomicity):
 * validate ranges -> reserve -> write+verify files -> assemble the notice ->
 * budget preflight -> CREATE the child -> commit registry links. A crash before
 * creation leaves orphan files (harmless, numbers already spent); creation
 * without the commit is retried idempotently via attemptKey + linkChild.
 *
 * Budget honesty: allowance is a share of the window REMAINING after the
 * header, never of the whole window; the header is bounded by the last real
 * request's full prompt (conservative — over-counting errs toward loud
 * refusals, which is the designed direction). No usage yet -> the probe says
 * `headerBoundTokens: null` and the allowance conservatively assumes a zero
 * header only because a session with no requests cannot have a large TOC.
 */
import type { ChapterRange, NoticePlan, RenderConfig, SessionEventLike, ToolResultOverride } from './types.ts'
import { chapterTopics } from './signature.ts'
import { estimateTokens, oversizeRanges, renderChapter, validateRanges } from './render.ts'
import { attemptKey, coverage, verifyChapter, writeArchive } from './archive.ts'
import type { ChapterRecord } from './archive.ts'
import { appendChapters, freshSession, linkChild, reserve, reservePlan as reservePlanNumber } from './registry.ts'
import type { SessionState } from './registry.ts'
import { buildTocNotice } from './notice.ts'
import { deriveIdentity } from './engine-core.ts'
import { buildPlansSection, detectPlans, PLAN_MODE_EVENT, type PlanIntent } from './plans.ts'

export interface ContinueArgs {
  callerSessionId: string
  /** The caller's own preset id, resolved by the adapter from its session observation. */
  callerPreset: string | null
  title: string
  handoffNote: string
  chapters: ChapterRange[]
  toolResultOverrides: ToolResultOverride[]
  /**
   * The knowledge-project line for the notice (record §8): `Project: <slug> ·
   * <key>` plus the search instruction. Set by the adapter from the linked
   * project; absent → the notice simply omits the section.
   */
  projectLine?: string
  /** P3 §7.3: rules block for the notice (see assembleNotice). */
  rulesSection?: string
  /** Why this child exists — see PlanIntent. Absent means 'continue'. */
  intent?: PlanIntent | undefined
}

export interface ContinueConfig extends RenderConfig {
  artifactStoreRoot: string
  continuationBudgetRatio: number
  fallbackPreset: string
  /** Topic-sequential composition (record §4.2): merge while overlap ≥ τ. */
  mergeThreshold: number
  /** Estimated-token cap per composed chapter. */
  chapterLimit: number
  /**
   * Hard oversize multiple of `chapterTokenTarget` (#59): over the target warns, over
   * `target × factor` the door refuses before reserving a number. Optional so a profile that predates
   * the key keeps the pre-#59 behaviour of warning only — the default lives in `Config`, not here.
   */
  chapterOversizeFactor?: number
  /**
   * Carry the `## Plans on this path` block into the child's notice
   * (docs/plans-carriage.md § 4). Renders ZERO bytes when the path holds no
   * plan, so a session that never entered plan mode is bit-identical to before
   * this existed — which is what keeps the model tapes matching.
   */
  plansInNotice?: boolean | undefined
  /**
   * Teach a child HOW to look things up, not only what was archived (findability
   * audit, 2026-10-11). The index answers questions about every kind — chapters,
   * `kind: plan` documents, curated rules — but the notice previously pointed at
   * nothing but `read`, so a session had to guess that `chapters_search` exists.
   */
  retrievalHints?: boolean | undefined
  /**
   * Seed `plan/mode {active:true}` into a CONTINUATION child when the archived span
   * ended with plan mode active, so the planning gate survives the boundary the way
   * the plot does (decision 2026-10-10; measured: the kernel accepts a two-event
   * seed and the host's own plan projection folds it to active). Never for a branch.
   */
  planSeedMode?: boolean | undefined
}

export interface BudgetProbe {
  windowTokens: number | null
  headerBoundTokens: number | null
}

export interface ContinuePorts {
  /** The caller's durable events, oldest first (full log; the ceiling trims it). */
  readCallerEvents(): Promise<SessionEventLike[]>
  getState(sessionId: string): Promise<SessionState>
  putState(sessionId: string, state: SessionState): Promise<void>
  /** ArchiveFs anchored at the caller's workspace cwd (the read tool reaches it). */
  fs(): import('./archive.ts').ArchiveFs
  budgetProbe(): Promise<BudgetProbe>
  newId(): string
  /** agents.create + setup-mount + workspace attach; throws on kernel refusal.
   * `modeEvents` are the child's OWN synthetic state events (never a parent slice):
   * they follow the notice, so the seed stays contiguous from seq 0. */
  createChild(input: {
    sessionId: string
    noticeEvent: SessionEventLike
    modeEvents: SessionEventLike[]
    presetId: string
    title: string
  }): Promise<void | { warnings?: readonly string[] }>
  now(): number
  /**
   * The plane's diagnostics seam (#54). The core refuses a child creation with the kernel's
   * own words — and on host 0.2.x those words ended the whole acceptance chain while the
   * error sink stayed empty, because only the engine had ever written to it. The core cannot
   * touch the filesystem (it is L0-pure, and its tests run everywhere), so each plane injects
   * its own: `src/diag.ts` for both of them in practice, but injected so a caller can also
   * surface it. OPTIONAL on purpose: absence must never break a door.
   */
  diagnostic?(where: string, message: string, error?: unknown): void
}

export interface ContinueResult {
  ok: boolean
  childSessionId?: string
  presetUsed?: string
  chapters?: Array<{ number: number; path: string; startSeq: number; endSeq: number }>
  warnings?: string[]
  /** Numbers behind every outcome — AGENTS: refuse WITH the numbers. */
  budget?: { usedTokens: number; allowanceTokens: number; windowTokens: number | null; headerBoundTokens: number | null }
  reason?: string
}

export class Refusal extends Error {
  readonly result: ContinueResult
  constructor(result: ContinueResult) {
    super(result.reason ?? 'refused')
    this.result = result
  }
}

export interface NoticeEntry {
  number: number
  path: string
  title: string
  summary: string
  status: 'ok' | 'modified' | 'missing'
  /** user+assistant message count (record §7.3); absent for legacy records. */
  messages?: number
}

/** The child's whole content: honest preamble, in-flight note, flat index, back-links. */
export function assembleNotice(input: {
  title: string
  handoffNote: string
  entries: readonly NoticeEntry[]
  rootSession: string
  parentSession: string
  storeRoot: string
  projectLine?: string
  /** P3 §7.3: CORE RULES + category index, composed by the adapter from this
   * machine's own approvals. Absent/empty => zero injected bytes (tape-safe). */
  rulesSection?: string
  /**
   * docs/plans-carriage.md § 4: the flat `## Plans on this path` block, in CAUSAL order
   * block, built by buildPlansSection from the ancestor path's chapter records
   * plus whatever plans the caller's live tail still holds. Placed ABOVE the
   * fold because the operative plan is the one fact a continuation must not
   * re-derive — a child that cannot see it either implements something nobody
   * approved or re-plans from recall. Absent/empty => zero injected bytes.
   */
  plansSection?: string
  retrievalHints?: boolean | undefined
}): string {
  const lines = [
    `# Continuation: ${input.title}`,
    ...(input.projectLine !== undefined && input.projectLine !== '' ? ['', input.projectLine] : []),
    ...(input.rulesSection !== undefined && input.rulesSection !== '' ? ['', input.rulesSection] : []),
    ...(input.plansSection !== undefined && input.plansSection !== '' ? ['', input.plansSection] : []),
    '',
    'This session continues an archived conversation. Chapters are verbatim Markdown in the workspace;',
    'every byte remains retrievable — inline, or at artifact paths cited inside a chapter. Read a chapter',
    'by its path with the read tool when the detail matters. The previous session stays intact.',
    '',
    '## In flight',
    input.handoffNote.trim().length > 0 ? input.handoffNote.trim() : '(none stated)',
    '',
    '## Chapters',
  ]
  for (const e of input.entries) {
    const mark = e.status === 'ok' ? '' : ` ⚠ ${e.status} since archived`
    const msgs = e.messages !== undefined ? ` (${e.messages} msgs)` : ''
    lines.push(`${e.number}. [${e.title}](${e.path}) — ${e.summary}${msgs}${mark}`)
  }
  if (input.retrievalHints !== false) {
    // Three verbs, one line each: the child's question decides which to reach for.
    lines.push(
      '',
      '## Finding things',
      '- Chapter detail: open its path above with the read tool.',
      "- A deferred tool result: chapters_artifact (the path, or the bare sha a chapter cites) — action 'toc' | 'search' | 'read'.",
      "- Anything else on this project — other sessions' work, archived plans (`kind: plan`), curated rules: chapters_search.",
      // #50 §7.9: the one rule verb a session is told to reach for, and WHEN to
      // reach for it. This line lives in the notice, not the persona, on purpose:
      // notice prose costs the tape corpus nothing (measured 2026-10-11), while a
      // persona edit forces a re-record of every affected project.
      '- Before starting a task: chapters_rules with the task description — it returns the rules that actually apply, and says what it withheld.',
    )
  }
  // NOTE: CodeGraph integration is INVISIBLE to the model. It enriches
  // chapters_search results with structurally-aware scoring (codegraphBoost)
  // and improves enrichment topics via structural context. The model never
  // sees a separate "Code intelligence" section or references to codegraph_*
  // tools — dsh-chapters owns search, and CodeGraph makes it better from
  // behind the scenes. No notice bytes are added for CodeGraph.
  lines.push('', `Ancestry: root ${input.rootSession}; parent ${input.parentSession}; archive under ${input.storeRoot}/.`)
  return lines.join('\n')
}

/** The budget formula with its refusal numbers, kept apart for direct testing. */
export function preflight(input: {
  noticeTokens: number
  budget: BudgetProbe
  ratio: number
}): { ok: true; budget: NonNullable<ContinueResult['budget']> } | { ok: false; budget: NonNullable<ContinueResult['budget']> } {
  const window = input.budget.windowTokens
  if (window === null) {
    const budget = { usedTokens: input.noticeTokens, allowanceTokens: 0, windowTokens: null, headerBoundTokens: input.budget.headerBoundTokens }
    return { ok: false, budget }
  }
  const remaining = Math.max(0, window - (input.budget.headerBoundTokens ?? 0))
  const allowance = Math.floor(remaining * input.ratio)
  const budget = { usedTokens: input.noticeTokens, allowanceTokens: allowance, windowTokens: window, headerBoundTokens: input.budget.headerBoundTokens }
  return input.noticeTokens <= allowance ? { ok: true, budget } : { ok: false, budget }
}

/** Ancestor ids root-first, via registry links; cycles refuse, never hang. */
async function ancestryPath(ports: ContinuePorts, sessionId: string, limit = 1000): Promise<string[]> {
  const walk: string[] = []
  const seen = new Set<string>()
  let cursor: string | null = sessionId
  while (cursor !== null) {
    if (seen.has(cursor) || walk.length >= limit) throw new Refusal({ ok: false, reason: `registry ancestry cycle/limit at ${cursor}` })
    seen.add(cursor)
    walk.unshift(cursor)
    cursor = (await ports.getState(cursor)).parentSession
  }
  return walk
}

export async function runContinue(
  ports: ContinuePorts,
  args: ContinueArgs,
  config: ContinueConfig,
): Promise<ContinueResult> {
  // ---- 1. Facts: ceiling and ranges.
  const allEvents = await ports.readCallerEvents()
  const lastTurnEnd = [...allEvents].reverse().find((e) => e.type === 'turn/end')
  if (lastTurnEnd === undefined) {
    throw new Refusal({ ok: false, reason: 'no completed turn to archive — the conversation has not reached a turn/end boundary' })
  }
  const ceiling = lastTurnEnd.seq
  // The watermark first: it is the FLOOR the submitted ranges must start at (#59). Reading state is
  // also what step 2 needs, so this is a hoist, not an extra round-trip — and every later step
  // re-reads through a fresh getState inside its own section.
  const callerState0 = await ports.getState(args.callerSessionId)
  const watermark = callerState0.chapters.reduce((m, c) => Math.max(m, c.endSeq), -1)
  const fromSeq = watermark + 1
  try {
    validateRanges(args.chapters, ceiling, fromSeq)
  } catch (error) {
    throw new Refusal({ ok: false, reason: `ranges refused: ${(error as Error).message}` })
  }
  const below = allEvents.filter((e) => e.seq <= ceiling)
  // Internal gaps and a start above the watermark are now REFUSALS inside validateRanges, so the
  // only gap left for `coverage` to report is the TAIL (ranges that stop short of the ceiling) —
  // which is not a loss: the watermark advances to the last archived seq and the rest archives on
  // the next door. Keeping the check for what it can still see, and saying so.
  const gaps = coverage(args.chapters, ceiling, fromSeq).gaps
  const warnings: string[] = gaps.map(
    (g) => `seqs ${g.from}-${g.to} are not archived by this call — they stay live for the next door (a tail is deferred, a hole is refused)`,
  )

  // ---- Seed-vocabulary preflight (issue #43). The live failure sequence was: chapters
  // rendered and written, THEN the child seed was REFUSED by the kernel (`format v4
  // message requires a producer-owned source kind`) — orphaned files, a lock-only child
  // directory (measured: ch-eb3d8927, 2026-10-18), no registry commit. This probe runs
  // the same boundary `buildTocNotice` will, with throwaway text, BEFORE anything is
  // written: a refusal here costs zero bytes on disk. It cannot predict a kernel change
  // (that is the drift gate's job — tests/unit/host-seed-contract.test.ts); it
  // guarantees the emitter and its own validator can never drift apart into orphaning.
  try {
    buildTocNotice('seed-vocabulary probe', { newId: () => 'chapters-preflight', time: ports.now() })
  } catch (error) {
    throw new Refusal({ ok: false, reason: `seed vocabulary preflight refused: ${(error as Error).message}` })
  }

  // ---- 2. Render + reserve + write (idempotent per attempt key).
  const callerState = callerState0
  const renderConfig: RenderConfig = {
    toolResultDeferFloorTokens: config.toolResultDeferFloorTokens,
    chapterTokenTarget: config.chapterTokenTarget,
    ...(config.planInlineChars !== undefined ? { planInlineChars: config.planInlineChars } : {}),
    ...(config.callArgArtifactTokens !== undefined ? { callArgArtifactTokens: config.callArgArtifactTokens } : {}),
  }
  const rendered = args.chapters.map((range) => renderChapter(below, range, renderConfig, args.toolResultOverrides, chapterTopics(below, range.startSeq, range.endSeq)))
  warnings.push(...rendered
    .filter((r) => r.stats.overTarget)
    .map((r) => `chapter "${r.range.title}" is ${r.stats.estimatedTokens} est tokens over chapterTokenTarget — split at the next continuation, never clip`))
  // Same hard ceiling as the save door (#59), same ordering: refuse before anything is reserved.
  const tooBig = oversizeRanges(rendered, config.chapterTokenTarget, config.chapterOversizeFactor ?? 2)
  if (tooBig.length > 0) {
    throw new Refusal({ ok: false, reason: `ranges refused as oversize: ${tooBig.join('; ')}`, warnings })
  }

  const fs = ports.fs()
  const wrote = await writeArchive({
    fs,
    allocator: {
      async reserve(attemptId, count) {
        const fresh = await ports.getState(args.callerSessionId)
        const r = reserve(fresh, attemptId, count)
        await ports.putState(args.callerSessionId, r.state)
        return r.numbers
      },
      // Plan documents allocate on their OWN counter, so writing one can never
      // consume a chapter number or shift the TOC's ordering.
      async reservePlan(attemptId, count) {
        const fresh = await ports.getState(args.callerSessionId)
        const r = reservePlanNumber(fresh, attemptId, count)
        await ports.putState(args.callerSessionId, r.state)
        return r.numbers
      },
    },
    storeRoot: config.artifactStoreRoot,
    rootSessionId: callerState.rootSession,
    chapters: rendered,
    attemptId: attemptKey(args.callerSessionId, ceiling),
  })
  warnings.push(...wrote.warnings)

  // ---- 3. Cumulative flat index over the ancestor path, integrity-verified.
  const bundle = await collectEntries(ports, args.callerSessionId, wrote.records, warnings)

  // ---- 4/5. Notice + budget gate, create the child, commit.
  return await finishChild(ports, config, args, callerState, bundle, warnings, wrote.records)
}

/** Ancestors' committed records (root-first) plus fresh records; verified, numbered for display. */
async function collectEntries(
  ports: ContinuePorts,
  callerSessionId: string,
  freshRecords: readonly ChapterRecord[],
  warnings: string[],
): Promise<{ entries: NoticeEntry[]; records: ChapterRecord[] }> {
  const fs = ports.fs()
  const pathIds = await ancestryPath(ports, callerSessionId)
  const priorRecords: ChapterRecord[] = []
  for (const id of pathIds) {
    const st = await ports.getState(id)
    // Registry order is insertion order = authoring order within a session;
    // sessions walk root-first, so reading order IS causal order.
    priorRecords.push(...st.chapters)
  }
  const seenPaths = new Set<string>()
  const cited: ChapterRecord[] = []
  for (const record of [...priorRecords, ...freshRecords]) {
    if (seenPaths.has(record.path)) continue // a retry re-wrote the same path: cite once
    seenPaths.add(record.path)
    cited.push(record)
  }
  const entries: NoticeEntry[] = []
  const citedRecords: ChapterRecord[] = []
  for (const record of cited) {
    const status = await verifyChapter(fs, record)
    if (status !== 'ok') warnings.push(`${record.path}: ${status} since archived — marked in the TOC, not silently trusted`)
    entries.push({ number: entries.length + 1, path: record.path, title: record.title, summary: record.summary, status, ...(record.messages !== undefined ? { messages: record.messages } : {}) })
    citedRecords.push(record)
  }
  return { entries, records: citedRecords }
}

/**
 * The notice's plan rows: every plan the ARCHIVE carries, cited to the chapter
 * that holds it, in the same display numbering as the chapter list (docs/
 * plans-carriage.md § 4 — flat, in causal order, because the model never
 * traverses; sessions have independent seq spaces, so the caller's order IS the
 * chronology). Artifact paths come from the record (fully workspace-qualified),
 * not from the fact (store-relative), so the child's `read` hits the file.
 */
export function archivedPlanRows(records: readonly ChapterRecord[], entries: readonly NoticeEntry[]): NoticePlan[] {
  const rows: NoticePlan[] = []
  for (const record of records) {
    const display = entries.find((e) => e.path === record.path)
    for (const fact of record.plans ?? []) {
      const written = record.artifacts.find((a) => a.sha256 === fact.sha256)
      const doc = (record.planDocs ?? []).find((d) => d.sha256 === fact.sha256)
      rows.push({
        title: fact.title,
        status: fact.status,
        seq: fact.seq,
        ...(display !== undefined ? { chapterNumber: display.number, chapterPath: display.path } : {}),
        artifactPath: written?.path ?? fact.artifactPath,
        // The plan's own indexed document, when the writer allocated one — the
        // address `chapters_search` answers with, and the history a branch reads.
        ...(doc !== undefined ? { docPath: doc.path } : {}),
        sha256: fact.sha256,
        estTokens: fact.estTokens,
      })
    }
  }
  return rows
}

/**
 * Plans the caller still holds UNARCHIVED — a plan whose review is open sits in an
 * unfinished turn, and the archive ceiling is completed turns only, so it is in no
 * chapter and no artifact (docs/plans-carriage.md § 5). The child must still be
 * told it exists, and told plainly that it was never approved.
 */
export function livePlanRows(events: readonly SessionEventLike[], watermark: number): NoticePlan[] {
  return detectPlans(events, { ceiling: watermark }).plans
    .filter((p) => !p.archived)
    .map((p) => ({ title: p.title, status: p.status, seq: p.seq }))
}

/** The highest seq any cited chapter covers — the boundary between stored and live. */
export const archiveWatermark = (records: readonly ChapterRecord[]): number =>
  records.reduce((m, r) => Math.max(m, r.endSeq), 0)

/** Fields both continue and fork need to create the child. */
export type FinishArgs = Pick<ContinueArgs, 'callerSessionId' | 'callerPreset' | 'title' | 'handoffNote' | 'projectLine' | 'rulesSection' | 'intent'>

/** Shared tail of both flows: notice -> budget gate -> create (invariant 2) -> commit. */
async function finishChild(
  ports: ContinuePorts,
  config: ContinueConfig,
  args: FinishArgs,
  callerState: SessionState,
  bundle: { entries: readonly NoticeEntry[]; records: readonly ChapterRecord[] },
  warnings: string[],
  commitRecords: readonly ChapterRecord[],
): Promise<ContinueResult> {
  // ---- The plans block: stored facts + whatever the caller's live tail holds.
  // Empty list ⇒ '' ⇒ zero injected bytes (the tape-safety property, verify.md P8).
  const intent = args.intent ?? 'continue'
  const watermark = archiveWatermark(bundle.records)
  const callerEvents = await ports.readCallerEvents()
  // The parent's CURRENT mode, folded last-value-wins exactly like the host
  // projection does. Measured against the installed kernel (docs/plans-carriage.md
  // § 10): a two-event seed `notice@0, plan/mode@1` is accepted in the production
  // header shape, and the host's own plan projection then folds the child's log to
  // `active: true` — so the seeded child really IS gated, not merely told.
  const modeActive = detectPlans(callerEvents).modeActive
  const seedMode = intent === 'continue' && config.planSeedMode !== false && modeActive === true
  const modeEvents: SessionEventLike[] = seedMode
    ? [{ type: PLAN_MODE_EVENT, seq: 1, time: ports.now(), data: { active: true } }]
    : []

  let plansSection = ''
  if (config.plansInNotice !== false) {
    plansSection = buildPlansSection(
      [...archivedPlanRows(bundle.records, bundle.entries), ...livePlanRows(callerEvents, watermark)],
      { modeActive, intent, seeded: seedMode },
    )
  }

  // ---- Notice text, then the budget gate (measure the WHOLE notice).
  const noticeText = assembleNotice({
    title: args.title,
    handoffNote: args.handoffNote,
    entries: bundle.entries,
    rootSession: callerState.rootSession,
    parentSession: args.callerSessionId,
    storeRoot: config.artifactStoreRoot,
    ...(args.projectLine !== undefined ? { projectLine: args.projectLine } : {}),
    ...(args.rulesSection !== undefined ? { rulesSection: args.rulesSection } : {}),
    ...(plansSection !== '' ? { plansSection } : {}),
    retrievalHints: config.retrievalHints !== false,
  })
  const budget = preflight({
    noticeTokens: estimateTokens(noticeText),
    budget: await ports.budgetProbe(),
    ratio: config.continuationBudgetRatio,
  })
  if (!budget.ok) {
    throw new Refusal({
      ok: false,
      reason: budget.budget.windowTokens === null
        ? 'cannot resolve the model context window for this caller — refusing to create an unbounded continuation (check agentDefaultModel selection / adapter metadata)'
        : `continuation over budget: notice ~${budget.budget.usedTokens} tokens > allowance ${budget.budget.allowanceTokens} (${config.continuationBudgetRatio} × (window ${budget.budget.windowTokens} − header bound ${budget.budget.headerBoundTokens ?? 'unmeasured'})). Shorten the handoff note or split the archive.`,
      budget: budget.budget,
      warnings,
    })
  }

  // ---- Create the child (one synthetic event at seq 0 — invariant 2), then commit.
  const noticeEvent = buildTocNotice(noticeText, { newId: ports.newId, time: ports.now() })
  const childId = `ch-${ports.newId()}`
  const presetId = args.callerPreset ?? config.fallbackPreset
  try {
    // The plane may come back with warnings of its own — an attached-but-unlisted child,
    // a workspace service that no longer exposes attachSession. Those are facts about the
    // continuation the user is being handed, so they belong in the door's reply, not only
    // in a log the reply already summarizes.
    const created = await ports.createChild({ sessionId: childId, noticeEvent, modeEvents, presetId, title: args.title })
    if (created !== undefined && Array.isArray(created.warnings)) warnings.push(...created.warnings)
  } catch (error) {
    // Full detail to the sink, short detail to the composer. The UI string is sliced to fit
    // a note; the reason a kernel refused the seed is the part an investigator needs whole.
    ports.diagnostic?.(`door:${args.intent ?? 'continue'}`, `child creation refused for ${childId}`, error)
    throw new Refusal({ ok: false, reason: `child creation refused: ${(error as Error).message}`, warnings })
  }
  if (commitRecords.length > 0) {
    const callerFresh = await ports.getState(args.callerSessionId)
    await ports.putState(args.callerSessionId, appendChapters(callerFresh, commitRecords))
  }
  await ports.putState(childId, linkChild(freshSession(childId), args.callerSessionId, callerState.rootSession))

  return {
    ok: true,
    childSessionId: childId,
    presetUsed: presetId,
    chapters: commitRecords.map((r) => ({ number: r.number, path: r.path, startSeq: r.startSeq, endSeq: r.endSeq })),
    warnings,
    budget: budget.budget,
  }
}

/**
 * chapters_fork: open a sibling line citing the SAME archive, archiving nothing
 * new. The point is branching (AGENTS "branchable — history can fork, not
 * just truncate"): parent and child keep working independently; no files are
 * written and no numbers reserved, so a fork is cheap and cannot orphan a
 * citation it did not already exist.
 */
export interface ForkArgs extends FinishArgs {}

export async function runFork(
  ports: ContinuePorts,
  args: ForkArgs,
  config: ContinueConfig,
): Promise<ContinueResult> {
  const warnings: string[] = []
  const callerState = await ports.getState(args.callerSessionId)
  const bundle = await collectEntries(ports, args.callerSessionId, [], warnings)
  return await finishChild(ports, config, args, callerState, bundle, warnings, [])
}

/**
 * Deterministic segmentation: split [0..anchorSeq] into chapter ranges WITHOUT
 * any model call — the fork-button backend (a button cannot wait for proposed
 * ranges, and auto mode must never paraphrase: invariant 4 holds, only
 * positions are computed here; titles/summaries derive from content lines).
 * Cuts land ONLY on `turn/end` boundaries; a segment closes at the first
 * boundary reaching ~90% of chapterTokenTarget, so overshoot is bounded.
 */
export function deriveRanges(
  events: readonly SessionEventLike[],
  anchorSeq: number,
  chapterTokenTarget: number,
  fromSeq = 0,
): { chapters: ChapterRange[]; notes: string[] } {
  const upto = events.filter((e) => e.seq <= anchorSeq)
  const boundaries = upto.filter((e) => e.type === 'turn/end' && e.seq >= fromSeq).map((e) => e.seq)
  if (boundaries.length === 0) {
    throw new Refusal({ ok: false, reason: fromSeq > 0
      ? `nothing new to archive: every completed turn at or before seq ${anchorSeq} is already in the archive (watermark ${fromSeq - 1})`
      : `no completed turn at or before seq ${anchorSeq} — nothing to branch from yet` })
  }
  const last = boundaries[boundaries.length - 1]!
  const notes: string[] = []
  if (last !== anchorSeq) {
    notes.push(`anchor ${anchorSeq} is not a turn boundary: segmentation ran to ${last}; later events belong to an unfinished turn (describe them in the handoff note)`)
  }
  const tokensBetween = (lo: number, hi: number): number => upto
    .filter((e) => e.seq >= lo && e.seq <= hi)
    .reduce((n, e) => n + Math.ceil(JSON.stringify(e.data ?? {}).length / 4), 0)

  // A plan submission ENDS the chapter that carries it (docs/plans-carriage.md § 6);
  // cuts still land only on turn/end boundaries, so the chapter closes at the FIRST
  // boundary at or after the submission.
  const planSeqs = detectPlans(upto.filter((e) => e.seq >= fromSeq)).plans.map((p) => p.seq)
  const planIn = (lo: number, hi: number): number | undefined => planSeqs.find((sq) => sq >= lo && sq <= hi)

  const chapters: ChapterRange[] = []
  const cut = Math.max(1, Math.floor(chapterTokenTarget * 0.9))
  let start = fromSeq
  for (const b of boundaries) {
    const isLast = b === last
    const planHere = planIn(start, b)
    if (isLast || planHere !== undefined || tokensBetween(start, b) >= cut) {
      const seg = upto.filter((e) => e.seq >= start && e.seq <= b)
      const msgs: EngineMessageView[] = seg
        .filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
        .map((e) => {
          const d = e.data as { content?: { type: string; text?: string }[] } | undefined
          return { role: e.type === 'assistant/message' ? 'assistant' : 'user', content: d?.content ?? [] }
        })
      const identity = deriveIdentity(
        msgs,
        seg.some((e) => JSON.stringify(e.data ?? '').includes('<compacted-summary>')),
        // The plan's own H1 titles the chapter it concludes.
        planHere !== undefined
          ? (detectPlans(seg).plans.find((p) => p.seq === planHere)?.title ?? undefined)
          : undefined,
      )
      chapters.push({
        title: `${identity.title} (${chapters.length + 1})`,
        summary: `events ${start}-${b}; ${identity.summary}`,
        startSeq: start,
        endSeq: b,
      })
      start = b + 1
    }
  }
  return { chapters, notes }
}

/** Structural view of the provider Message for deriveIdentity reuse. */
interface EngineMessageView {
  readonly role: string
  readonly content: readonly { type: string; text?: string }[]
}


/** The adapter surfaces refusals as tool output, never as crashes. */
export function refusalResult(error: unknown): ContinueResult | null {
  return error instanceof Refusal ? error.result : null
}
