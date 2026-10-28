/**
 * ChaptersCompactionEngine — the cordis-facing adapter over the pure
 * engine-core logic. Mounted INSIDE a preset realm's compaction group (never
 * the host plane beside `basic`: two engines double-fire across planes,
 * FINDINGS § Phase 0b), it overrides exactly the sanctioned hook plus the two
 * entry points whose results the finalizer needs.
 *
 * Everything decision-shaped lives in engine-core.ts, where it is
 * harness-free testable. This file is glue: service resolution, durable
 * reads/writes, and the never-break-the-caller containment the base's own
 * listeners already model.
 */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { extractSignature, enrichSignatureWithCodegraph, turnSpanOf } from './signature.ts'
import { appendCollection } from './registry.ts'
import type { SessionEventLike } from './types.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { Context } from '@deepseek-ai/cordis'
import { configureDiagnosticsCap, diagnosticNote, diagnosticWarn, ensureDiagnosticsDefault } from './diag.ts'
import { makeChildArchiveListener } from './auto-save.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import z from '@deepseek-ai/schemastery'
import {
  assertReservationMatchesPlan,
  CHAPTERS_PROVIDER, DETERMINISTIC_MODEL, buildFinalizedChapter, buildFinalizedChapters,
  findOpenCompactionId, planSummarize, reconstructShadowedSeqs, scanChaptersSummaries,
  scanAndFinalize,
  type EngineConfig, type EngineSession, type SummarizeInputLike, type SummarizeResultLike,
} from './engine-core.ts'
import { composeChapters } from './compose.ts'
import { carryActivePlan, detectPlans } from './plans.ts'
import { isInjectedProse, stripReminderSpans } from './injections.ts'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { auxPromptMessage } from './aux-message.ts'
import { applyArrivalStubs, type ArrivalSessionShim } from './arrival.ts'
import { lastResortCeilingTokens } from './last-resort.ts'
import { extractPlot } from './engine-core.ts'
import type { ChapterRange } from './types.ts'
import { appendChapters, isFinalized, markFinalized, rememberPlan, reserve } from './registry.ts'
import type { SessionState } from './registry.ts'
import { acquireChapterStore, makeAllocator, makeArchiveFs, type ChapterStoreHandle, resolveStoreRoot } from './store.ts'
import { createSyncScheduler, makeCollectionsReader, projectForCwd, readToken, DEFAULT_CLONE_DIR } from './sync.ts'
import { registerProvider } from './provider.ts'
import { createTreedxProvider } from './treedx/provider.ts'
import { createEnrichWiring, type EnrichWiring } from './enrich-wire.ts'
import { writeArchive } from './archive.ts'
import { ENRICH_MAX_TOKENS_DEFAULT } from './enrich.ts'
import { hostname } from 'node:os'
import path from 'node:path'
import { captureMinedRules, makeHeaderParentReader, makeRuleCaptureListener, renderRulesBlock } from './session-rules.ts'
import type { RegistryStore } from './store.ts'

/** Row config: the base's keys (so realm rows validate) plus the archive's own. */
export interface ChaptersRowConfig extends BasicCompactionConfig {
  /** Lines of the chapter index a continuation notice lists (0 = all). A fixed-size notice is what lets a
   * boundary-sitting leg be captured and replayed at all (#56). */
  noticeIndexCap?: number | undefined
  artifactStoreRoot?: string
  /** #85: pool-mirror root for rules/knowledge reads that produce model-visible text. */
  knowledgeMirrorDir?: string
  /** #87: verbatim carry of the newest human turn, capped; the cap is stated, never silent. */
  openRequestCarryMaxChars?: number
  /** #78 A: defer a node relief cannot coexist with, after a measured decline. */
  lastResortArtifact?: boolean
  /** #95 follow-up: sink size cap; 0 = uncapped. */
  diagnosticsMaxBytes?: number
  chapterTokenTarget?: number
  toolResultDeferFloorTokens?: number
  mergeThreshold?: number
  /** #61 Amendment A: the seventh archive moment, and its re-arm lag. */
  childAutoArchive?: boolean | undefined
  childAutoArchiveMinTurns?: number | undefined
  chapterLimit?: number
  syncDebounceMs?: number
  toolResultArtifactTokens?: number
  /** Plans (docs/plans-carriage.md § 7): verbatim plan chars in a chapter's Plans
   * block, and the tool-call-argument artifact floor (0 = off). */
  planInlineChars?: number
  callArgArtifactTokens?: number
  /** Carry the operative plan into every checkpoint (plans-carriage § 9). */
  plansInCheckpoint?: boolean
  planCheckpointChars?: number
  elicitedPlot?: boolean
  // #50 §7/§7.5 rules. Declared on the HOST plane (src/index.ts) and mirrored
  // into this row exactly the way `elicitedPlot`/`enrichmentEnabled` already
  // are, so a head rebuilt by the notice path and one rebuilt by the compaction
  // path select the same rules from the same numbers.
  harnessId?: string
  sessionRulesEnabled?: boolean
  rulesMarkerPrefix?: string
  coreRulesBudgetTokens?: number
  projectRulesDisplayCap?: number
  sessionRulesDisplayCap?: number
  rulesRelevance?: boolean
  /** §7.5 model-mined rules; default ON. */
  rulesEnrichment?: boolean
  /** §7.5 per-chapter cap on mined rules */
  rulesMinedPerChapter?: number
  /** One auxiliary completion budget (annotation+mining, conflicts): must cover
   * reasoning tokens as well as the visible answer — see enrich.ts. */
  enrichmentMaxTokens?: number
  /** §7.5: mined rules govern on arrival unless false (then they wait for review).
   * Default true — inferring what nobody spelled out is the whole point. */
  rulesAutoActivate?: boolean
  /** §7.5: 'provider/model' for a dedicated mining call; '' ⇒ the annotation pass */
  rulesModel?: string
  // P2 enrichment (record §6): the realm plane owns the AUTO triggers.
  enrichmentEnabled?: boolean
  enrichmentModel?: string
  enrichmentTrigger?: 'afterPush' | 'idle' | 'both' | 'manual'
  enrichmentIdleMs?: number
  enrichmentBatchCap?: number
  // P2 §6.3 vocabulary pass (shadow by default: report, never write).
  vocabApply?: boolean
  vocabCoMin?: number
  vocabOverlapMin?: number
  // §15 amendment: TreeDX transport tunables (spikes/treedx/FINDINGS.md).
  treedxFetchTimeoutMs?: number
  treedxWorkspaceTtlSeconds?: number
  treedxLeaseRetries?: number
  treedxLeaseRetryDelayMs?: number
}

/**
 * Per-turn deterministic signature listener (knowledge-repo.md §4.1), as a
 * plain factory so the LOGIC is unit-testable against the real host Session
 * shape without a full cordis Service context. Never-break containment: the
 * handler reports through `warn`, it never throws into the session.
 *
 * r28 found the load-bearing fact: the host Session is a CLASS exposing
 * snapshotEvents() — a `.events` property does not exist, and the first cut
 * read `.events`, no-op'd silently in every real boot, and passed its L0
 * test because the test stubbed the shape that does not exist.
 */
export function makeSignatureListener(deps: {
  store: () => Promise<{ store: import('./store.ts').RegistryStore }>
  warn: (error: unknown) => void
  onCollected?: (id: string, sig: { seqs: number[]; paths: string[]; terms: string[]; size: number }) => void
  /** Optional subprocess service for CodeGraph symbol verification. */
  subprocess?: import('./codegraph.ts').SubprocessLike | undefined
  /** #61: `<store-root>` so the diagnostics sink can default to a file without any env setup. */
  storeRoot?: string | undefined
}): (session: unknown, event: unknown) => void {
  // Per-session promise chain: the store write is a read-modify-append, so
  // two turn-ends landing the same tick must serialize or the second put
  // clobbers the first's collection (real sessions are minutes apart, but
  // burst steer/resume exists; the queue makes the listener honest anyway).
  const chains = new Map<string, Promise<void>>()
  return (session, event) => {
    try {
      if ((event as { type?: string })?.type !== 'turn/end') return
      const id = (session as { id?: string } | undefined)?.id
      const events = (session as { snapshotEvents?: () => readonly SessionEventLike[] } | undefined)?.snapshotEvents?.()
      if (id === undefined || events === undefined) return
      const endSeq = (event as { seq?: number }).seq
      if (endSeq === undefined) return
      const span = turnSpanOf(events, endSeq)
      if (span.length === 0) return
      const sig = extractSignature(span)
      deps.onCollected?.(id, sig)
      // CodeGraph symbol verification is async and fire-and-forget. The cwd
      // comes from the session header; missing cwd or missing CLI → silent no-op.
      const cwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd
      // #61: the compaction realm is where the SAIP finalization failures happened, and all three left
      // zero trace because the sink had to be configured before it existed. Resolve it from the session
      // that is compacting, first one wins.
      if (cwd !== undefined && deps.storeRoot !== undefined) {
        // Absolute stays absolute. `path.join(cwd, artifactStoreRoot)` silently nested an ABSOLUTE store root
        // under the workspace (`/wsp/var/e2e-home-41739/chapters/…`), so on the rig — where #61 pins
        // `artifactStoreRoot` to an absolute per-port path to keep test chapters out of the repo's store — the
        // diagnostics file was written to a path nobody looked at. The failure this repo exists to end: a
        // mechanism that detects and then loses the evidence. Same dialect rule as `toStoredPath` (#69).
        ensureDiagnosticsDefault(path.join(path.isAbsolute(deps.storeRoot) ? deps.storeRoot : path.join(cwd, deps.storeRoot), 'diagnostics.log'))
      }
      const enrichPromise = cwd !== undefined
        ? enrichSignatureWithCodegraph(sig, span, deps.subprocess, cwd).catch(() => {})
        : Promise.resolve()
      // One serialized section (#59): the signature listener used to get→append→put with the whole
      // row snapshot, so a turn that landed during another door's await could erase that door's
      // committed state. The lost signature is what dropped a COMPLETED turn out of the archive.
      const job = (): Promise<void> => enrichPromise.then(() => deps.store()).then(({ store }) =>
        store.mutate(id, (st) => appendCollection(st, sig)),
      ).then(() => undefined).catch(deps.warn)
      const prev = chains.get(id)
      const next = prev === undefined ? job() : prev.then(job)
      chains.set(id, next)
      void next.finally(() => { if (chains.get(id) === next) chains.delete(id) })
    } catch (error) {
      deps.warn(error)
    }
  }
}

/**
 * Pull-on-first-turn (§5.1) as a plain factory, same testability discipline
 * as the signature listener. Process-scoped "first turn seen" — a resumed
 * old session pulling once more is harmless and bounded.
 */
export function makeFirstTurnPullListener(deps: { pull: (cwd: string) => Promise<unknown> }): (session: unknown, event: unknown) => void {
  const pulled = new Set<string>()
  return (session, event) => {
    try {
      if ((event as { type?: string })?.type !== 'turn/start') return
      const id = (session as { id?: string } | undefined)?.id
      const cwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd
      if (id === undefined || cwd === undefined || pulled.has(id)) return
      pulled.add(id)
      void deps.pull(cwd).catch(() => undefined)
    } catch {
      // never break the session path (§5.3)
    }
  }
}

/**
 * #87 — carry the instruction that relief is about to shadow.
 *
 * Measured in the field: a `heavy` session whose thirteen compactions shadowed ten of the eleven
 * copies of the human's follow-up question. What survives in the surface is the summary — a plot, not
 * a request — so the model is never shown the thing it is being asked to do. Nothing errors; the user
 * sees an agent that stopped answering.
 *
 * The fix stays inside our own seams and honors invariant 1 (nothing recorded is rewritten): WE author
 * the summary text, so the newest human instruction travels INTO it, verbatim. Truncation is never
 * silent — the cap is stated in the block. Injected scaffolding (workspace reminders, the host's own
 * checkpoint preamble, our notices) is skipped: those are represented elsewhere, and carrying them
 * would re-inject machine state as if it were a request.
 */
type SummaryPart = { type: 'text', text: string }

export function carryOpenRequest(
  parts: readonly SummaryPart[],
  messages: readonly unknown[],
  capChars: number,
): SummaryPart[] {
  // ONE predicate for "is this injected machine prose" — `src/injections.ts`, the same screen the
  // archive body and the title chooser use. A second list here is the #59 bug re-made: it would lag
  // the first, and a drift row exists precisely to catch that (it caught this, minutes after I wrote it).
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: string, content?: unknown }
    if (m?.role !== 'user') continue
    const c = m.content
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? (c as Array<{ type?: string, text?: string }>).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : ''
    const t = text.trim()
    if (t === '' || isInjectedProse(t)) continue
    const clipped = t.length > capChars
    const body = clipped
      ? `${t.slice(0, capChars)}\n[carried in part: ${String(t.length)} characters total, ${String(capChars)} included — the whole turn stays in the durable log]`
      : t
    return [...parts, { type: 'text', text: `OPEN REQUEST (verbatim; this relief shadows the turn that asked it):\n"""\n${body}\n"""` }]
  }
  return [...parts]
}

/**
 * Is this the base engine refusing to run for a CONFIG reason rather than a provider failing? (#140)
 *
 * `dsh-compaction-basic@0.2.0-rc.2` validates per routed target:
 * `pressureBudgetTokens = contextWindow − reservedCompletionTokens − policy.headroomTokens`, and throws its
 * `TargetPressureConfigError` when that is ≤ 0. Its default `headroomTokens` is 65,536 — a reservation for a routed
 * summarize call, which THIS engine never makes: `summarize()` is overridden and deterministic (src/engine.ts:664).
 * On any model whose window is under that default (32K is this plugin's target hardware) the exception otherwise
 * escapes `compactIfNeeded` forever, so relief is indistinguishable from a crash.
 *
 * The class is not re-exported by the bundle's types, so the identity is structural: the error carries the target key
 * it validated and a message prefixed with the package's own labels. Provider failures match neither and still
 * propagate, which is the asymmetry the row pins.
 */
function isPressureConfigRejection(error: unknown): boolean {
  const e = error as { name?: string; message?: string; targetKey?: unknown } | null | undefined
  if (e === null || e === undefined) return false
  const named = typeof e.name === 'string' && e.name.includes('TargetPressureConfigError')
  const keyed = typeof e.targetKey === 'string' && e.targetKey.length > 0
  const labelled = typeof e.message === 'string' && /compaction-basic:|BasicCompactionConfig/.test(e.message)
  return (keyed && labelled) || (named && labelled)
}

export class ChaptersCompactionEngine extends BasicCompactionEngine {
  // Base inject is ['llm','tokenMeter','sessions']; subclassing INHERITS statics,
  // so re-declare with what the chapter flow adds (r12's crash, FINDINGS).
  static inject = ['llm', 'tokenMeter', 'sessions', 'storageDomain']

  static override Config = z.object({
    thresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    // #140: the base's own default is 65,536 (`headroomTokens = config.headroomTokens ?? 65536`), which is a
    // reservation for a routed summarize call. This engine overrides summarize() and routes nothing, so that
    // default makes the pressure budget negative on any window under it — every 32K model, no relief at all.
    // Declared here so the key survives the Loader and reaches super's resolveConfig.
    headroomTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    // Mirrors the base's modelPolicy shape (compaction-basic/src/index.ts:79-90)
    // exactly: a narrower schema here could strip per-model ratios before
    // super's resolveConfig sees them. Stage 3 probe asserts survival.
    modelPolicies: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      thresholdRatio: z.number(),
      retainRatio: z.number(),
      retainTokens: z.number().step(1).min(0),
      headroomTokens: z.number().step(1).min(0), // #140: mirror the base's modelPolicy exactly (see above)
      summarizationProvider: z.string(),
      summarizationModel: z.string(),
      maxTokens: z.number().step(1).min(1),
      compactionRetries: z.number().step(1).min(0),
      maxOverflowRetries: z.number().step(1).min(0),
    })),
    auto: z.boolean(),
    artifactStoreRoot: z.string(),
    knowledgeMirrorDir: z.string().default('.dsh-knowledge'),
    openRequestCarryMaxChars: z.number().step(1).min(200).default(4000),
    /** #78 A: the last-resort deferral switch. Operator-visible, default on. */
    lastResortArtifact: z.boolean().default(true),
    /** #95 follow-up: diagnostics sink cap, bytes. 0 = uncapped. */
    diagnosticsMaxBytes: z.number().step(1).min(0).default(8388608),
    chapterTokenTarget: z.number().step(1).min(1),
    toolResultDeferFloorTokens: z.number().step(1).min(0),
    // The composition knobs ride the same row so the engine path and the fork
    // path honor one configuration (found undeclared 2026-09-18: destructured
    // by the constructor, stripped by the schema).
    mergeThreshold: z.number().default(0.3),
    chapterLimit: z.number().step(1).min(1).default(8000),
    syncDebounceMs: z.number().step(1).min(0).default(30000),
    toolResultArtifactTokens: z.number().step(1).min(256).default(8000),
    // #61 Amendment A — the seventh archive moment. A `ch-*` continuation child has origin `user`, so
    // door 5 never sees it: the field case archived NOTHING across 2,363 events because no moment was
    // watching. Save-only, fires at turn/end, thresholds are config and never literals.
    childAutoArchive: z.boolean().default(true),
    childAutoArchiveMinTurns: z.number().step(1).min(1).default(4),
    elicitedPlot: z.boolean().default(true),
    harnessId: z.string().default(''),
    sessionRulesEnabled: z.boolean().default(true),
    rulesMarkerPrefix: z.string().default('ADD RULE:'),
    coreRulesBudgetTokens: z.number().step(1).min(1).default(1200),
    projectRulesDisplayCap: z.number().step(1).min(0).default(12),
    sessionRulesDisplayCap: z.number().step(1).min(0).default(12),
    rulesRelevance: z.boolean().default(true),
    rulesEnrichment: z.boolean().default(true),
    rulesMinedPerChapter: z.number().step(1).min(0).default(3),
    rulesAutoActivate: z.boolean().default(true),
    rulesModel: z.string().default(''),
    enrichmentEnabled: z.boolean().default(true),
    enrichmentModel: z.string().default(''),
    enrichmentTrigger: z.string().default('both'),
    enrichmentIdleMs: z.number().step(1).min(0).default(60000),
    enrichmentBatchCap: z.number().step(1).min(1).default(5),
    enrichmentMaxTokens: z.number().step(1).min(400).default(ENRICH_MAX_TOKENS_DEFAULT),
    vocabApply: z.boolean().default(false),
    vocabCoMin: z.number().step(1).min(2).default(3),
    vocabOverlapMin: z.number().default(0.5),
    // §15 amendment: TreeDX transport tunables ride the same row so both
    // planes sync through identically-configured providers.
    treedxFetchTimeoutMs: z.number().step(1).min(1000).default(15000),
    treedxWorkspaceTtlSeconds: z.number().step(1).min(30).default(900),
    treedxLeaseRetries: z.number().step(1).min(0).default(3),
    treedxLeaseRetryDelayMs: z.number().step(1).min(0).default(1000),
  })

  private readonly chaptersConfig: EngineConfig
  /** #50 §7.5/§7.3: capture + rendering numbers, host plane mirrored in. */
  private ruleCfg: {
    harnessId: string
    captureEnabled: boolean
    markerPrefix: string
    budgetTokens: number
    projectCap: number
    sessionCap: number
    relevance: boolean
    /** §7.5 model-mined rules (the background half); default true from the row */
    mine?: boolean | undefined
    mineCap?: number | undefined
    /** §7.5: do mined rules govern on arrival? Default true — that is the tier's premise */
    autoActivate?: boolean | undefined
    /** §7.5: dedicated mining model; '' ⇒ mine inside the annotation call */
    model?: string | undefined
  } = { harnessId: '', captureEnabled: false, markerPrefix: 'ADD RULE:', budgetTokens: 1200, projectCap: 12, sessionCap: 12, relevance: true, mine: true, mineCap: 3, autoActivate: true, model: '' }
  private storePromise: Promise<ChapterStoreHandle> | null = null

  /** #52: the delegation-edge reader, built lazily because a field initializer
   * cannot see the constructor parameter and the realm may hold neither service.
   * null = not built yet; undefined = built and unavailable (registry edges only). */
  private parentOfReader: ((id: string) => Promise<string | null | undefined>) | undefined | null = null

  /** The reader the rule-ancestry walk uses. Absent ⇒ delegation contributes no edge. */
  private ruleParentOf(): ((id: string) => Promise<string | null | undefined>) | undefined {
    if (this.parentOfReader === null) {
      this.parentOfReader = makeHeaderParentReader((name: string) => {
        try { return this.ctx.get?.(name) } catch { return undefined }
      })
    }
    return this.parentOfReader ?? undefined
  }

  constructor(ctx: Context, config: ChaptersRowConfig = {}) {
    // The base's resolveConfig rejects unknown keys at runtime (measured r18:
    // `BasicCompactionConfig: unknown key "artifactStoreRoot"`) — the archive's
    // own keys are peeled off and held here; the base receives exactly its
    // documented shape. (The loader does not strip them for us either.)
    const {
      artifactStoreRoot, knowledgeMirrorDir, noticeIndexCap, openRequestCarryMaxChars, lastResortArtifact, diagnosticsMaxBytes, chapterTokenTarget, toolResultDeferFloorTokens,
      mergeThreshold, chapterLimit, syncDebounceMs, toolResultArtifactTokens, elicitedPlot,
      childAutoArchive, childAutoArchiveMinTurns,
      planInlineChars, callArgArtifactTokens, plansInCheckpoint, planCheckpointChars,
      harnessId, sessionRulesEnabled, rulesMarkerPrefix, coreRulesBudgetTokens,
      projectRulesDisplayCap, sessionRulesDisplayCap, rulesRelevance,
      rulesEnrichment, rulesMinedPerChapter, rulesAutoActivate, rulesModel,
      enrichmentEnabled, enrichmentModel, enrichmentTrigger, enrichmentIdleMs, enrichmentBatchCap,
      vocabApply, vocabCoMin, vocabOverlapMin, enrichmentMaxTokens,
      treedxFetchTimeoutMs, treedxWorkspaceTtlSeconds, treedxLeaseRetries, treedxLeaseRetryDelayMs,
      ...baseConfig
    } = config
    super(ctx, baseConfig)
    // The realm's module copy owns its own provider registry (cordis isolation
    // between planes): register the configured TreeDX transport HERE, exactly
    // as the host plane does in its apply(). Row defaults keep this correct
    // even when a preset omits every treedx key.
    registerProvider(createTreedxProvider({
      fetchTimeoutMs: treedxFetchTimeoutMs ?? 15000,
      workspaceTtlSeconds: treedxWorkspaceTtlSeconds ?? 900,
      leaseRetries: treedxLeaseRetries ?? 3,
      leaseRetryDelayMs: treedxLeaseRetryDelayMs ?? 1000,
    }))
    this.chaptersConfig = {
      artifactStoreRoot: artifactStoreRoot ?? '.dsh-chapters',
      knowledgeMirrorDir: knowledgeMirrorDir ?? DEFAULT_CLONE_DIR,
      // Capped notice index (#56): a fixed-size notice is what makes a boundary-sitting leg capturable at all.
      noticeIndexCap: noticeIndexCap ?? 6,
      openRequestCarryMaxChars: openRequestCarryMaxChars ?? 4000,
      lastResortArtifact: lastResortArtifact ?? true,
      diagnosticsMaxBytes: diagnosticsMaxBytes ?? 8388608,
      chapterTokenTarget: chapterTokenTarget ?? 8000,
      toolResultDeferFloorTokens: toolResultDeferFloorTokens ?? 200,
      mergeThreshold: mergeThreshold ?? 0.3,
      chapterLimit: chapterLimit ?? 8000,
      toolResultArtifactTokens: toolResultArtifactTokens ?? 8000,
      childAutoArchive: childAutoArchive ?? true,
      childAutoArchiveMinTurns: childAutoArchiveMinTurns ?? 4,
      planInlineChars: planInlineChars ?? 900,
      callArgArtifactTokens: callArgArtifactTokens ?? 0,
      plansInCheckpoint: plansInCheckpoint ?? true,
      planCheckpointChars: planCheckpointChars ?? 1600,
      elicitedPlot: elicitedPlot ?? true,
    }
    // The realm row is a second place the cap can legitimately come from (a plugin plane may boot before
    // any session exists). Applying it here means the first door writes with the row's value.
    configureDiagnosticsCap(this.chaptersConfig.diagnosticsMaxBytes)
    this.syncDebounceMs = syncDebounceMs ?? 30000
    this.vocabCfg = { apply: vocabApply ?? false, coMin: vocabCoMin ?? 3, overlapMin: vocabOverlapMin ?? 0.5 }
    this.enrichCfg = {
      enabled: enrichmentEnabled ?? true,
      model: enrichmentModel ?? '',
      mineRules: rulesEnrichment ?? true,
      mineCap: rulesMinedPerChapter ?? 3,
      rulesAutoActivate: rulesAutoActivate ?? true,
      rulesModel: rulesModel ?? '',
      maxTokens: enrichmentMaxTokens ?? ENRICH_MAX_TOKENS_DEFAULT,
      trigger: (enrichmentTrigger ?? 'both') as 'afterPush' | 'idle' | 'both' | 'manual',
      idleMs: enrichmentIdleMs ?? 60000,
      batchCap: enrichmentBatchCap ?? 5,
    }
    this.ruleCfg = {
      harnessId: harnessId ?? '',
      captureEnabled: sessionRulesEnabled ?? true,
      markerPrefix: rulesMarkerPrefix ?? 'ADD RULE:',
      budgetTokens: coreRulesBudgetTokens ?? 1200,
      projectCap: projectRulesDisplayCap ?? 12,
      sessionCap: sessionRulesDisplayCap ?? 12,
      relevance: rulesRelevance ?? true,
      mine: rulesEnrichment ?? true,
      mineCap: rulesMinedPerChapter ?? 3,
      autoActivate: rulesAutoActivate ?? true,
      model: rulesModel ?? '',
    }
    this.#listenForSignatures()
    this.#listenForRuleCapture()
    this.#listenForFirstTurnPull()
    ctx.logger?.info?.('dsh-chapters: engine constructed for a mount (signature listener live)')
  }

  /**
   * Per-turn deterministic signatures at turn/end (knowledge-repo §4.1):
   * synchronous extraction, async store append, and never-break containment —
   * a signature failure must never touch the compaction path (AGENTS hard
   * rule: the listener reports, it never throws into the session). The base
   * engine's own listeners model the same shape.
   */
  /** The realm's own scheduler (§5): same code as the host plane's; the file
   * lock and debounce keep the two honest against each other. */
  private syncDebounceMs = 30000
  private vocabCfg: { apply: boolean; coMin: number; overlapMin: number } = { apply: false, coMin: 3, overlapMin: 0.5 }
  private enrichCfg: { enabled: boolean; model: string; trigger: 'afterPush' | 'idle' | 'both' | 'manual'; idleMs: number; batchCap: number; maxTokens?: number; mineRules?: boolean | undefined; mineCap?: number | undefined; rulesAutoActivate?: boolean | undefined; rulesModel?: string | undefined } =
    { enabled: false, model: '', trigger: 'both', idleMs: 60000, batchCap: 5, mineRules: true, mineCap: 3 }
  private enrichPromise: Promise<EnrichWiring> | null = null
  private lastCwd: string | null = null
  private lastRoute: { provider: string; model: string } | null = null
  private schedulerPromise: Promise<import('./sync.ts').SyncScheduler> | null = null
  #scheduler(): Promise<import('./sync.ts').SyncScheduler> {
    this.schedulerPromise ??= this.store().then(({ store }) => createSyncScheduler({
      storeRoot: this.chaptersConfig.artifactStoreRoot,
      cloneDir: DEFAULT_CLONE_DIR,
      debounceMs: this.syncDebounceMs,
      // The realm never AUTO-links (linking is the host command's job); it
      // reads what the project table knows.
      resolveProject: (cwd) => projectForCwd(store.projects(), cwd),
      tokenFor: (cwd, projectKey) => readToken(cwd, this.chaptersConfig.artifactStoreRoot, projectKey),
      collectionsFor: makeCollectionsReader(store.sessions.bind(store), this.chaptersConfig.artifactStoreRoot),
      vocab: this.vocabCfg,
      // P2: a completed sync pass is the enrichment afterPush idle point.
      onSyncDone: (cwd, ok) => {
        void this.#enrich().then((w) => { w.rememberCwd(cwd); if (ok) w.queue.onSyncDone('afterPush') }).catch(() => undefined)
      },
    }))
    return this.schedulerPromise
  }

  /** P2 enrichment wiring (realm plane owns auto triggers; route + heartbeat
   * persist through the shared settings table, so the host command surface
   * and /chapters-status read one truth). Lazy; failures degrade silently —
   * the corpus simply stays signatures-only (kill-switch parity). */
  #enrich(): Promise<EnrichWiring> {
    this.enrichPromise ??= this.store().then(({ store }) => createEnrichWiring({
      store,
      cwd: () => this.lastCwd ?? undefined,
      config: this.enrichCfg,
      fetch: async (prompt, route) => {
        const r = route ?? this.lastRoute
        if (r === null || r.provider === '' || r.model === '') throw new Error('no auxiliary route yet')
        return await this.#auxComplete(prompt, r, this.enrichCfg.maxTokens ?? ENRICH_MAX_TOKENS_DEFAULT)
      },
      conversationRoute: () => this.lastRoute,
      // §7.5 the sink: the realm plane owns disk, identity and the registry, so it
      // writes what the pass mined. Session rules are LOCAL — nothing is armed on
      // the scheduler here, because the pool never carries them.
      onMinedRules: async ({ sessionId, chapterNumber, humanText, rules, max, autoActivate }) => {
        const cwd = this.lastCwd ?? undefined
        if (cwd === undefined) return { written: 0, stated: 0, inferred: 0, pending: 0 }
        const { store } = await this.store()
        const res = captureMinedRules({
          storeDir: resolveStoreRoot(cwd, this.chaptersConfig.artifactStoreRoot),
          harnessId: (this.ruleCfg.harnessId !== '' ? this.ruleCfg.harnessId : hostname()),
          sessionId,
          records: store.rules(),
          humanText,
          rules,
          maxPerChapter: max,
          chapterNumber,
          autoActivate,
        })
        return { written: res.ids.length, stated: res.stated, inferred: res.inferred, pending: res.pending }
      },
      scheduler: { schedule: (cwd, why) => { void this.#scheduler().then((s) => s.schedule(cwd, why)).catch(() => undefined) } },
      log: (m) => this.ctx.logger?.info?.(`dsh-chapters: ${m}`),
      warn: (m) => this.ctx.logger?.warn?.(`dsh-chapters: ${m}`),
    }))
    return this.enrichPromise
  }

  /** one tools-free completion (shared plumbing: enrichment + plot). */
  async #auxComplete(prompt: string, route: { provider: string; model: string }, maxTokens: number, signal?: AbortSignal, sessionId?: string): Promise<string> {
    const llm = (this.ctx as unknown as { llm?: { stream: (o: unknown) => AsyncIterable<unknown> } }).llm
    if (llm === undefined) throw new Error('llm absent')
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider: route.provider, model: route.model,
      messages: [auxPromptMessage(prompt)],
      maxTokens,
      ...(sessionId !== undefined ? { sessionId } : {}),
      purpose: 'compaction',
      ...(signal !== undefined ? { signal } : {}),
    })) assembler.push(chunk as never)
    return (assembler.blocks() as { type?: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  }

  /** Capture workspace cwd + routed model at every compaction entry; arm the
   * idle timer (turn activity). Advisory only — never disturbs compaction. */
  #observeRoute(agent: unknown): void {
    try {
      const session = (agent as { session?: EngineSession & { id: string } }).session
      if (session === undefined) return
      const cwd = (session as unknown as { header?: { cwd?: string } }).header?.cwd
      if (cwd !== undefined) this.lastCwd = cwd
      const cfg = (session as unknown as { requestHeader?: () => { config?: { provider?: string; model?: string } } }).requestHeader?.()?.config
      if (cfg?.provider !== undefined && cfg?.model !== undefined) this.lastRoute = { provider: cfg.provider, model: cfg.model }
      void this.#enrich().then((w) => w.queue.noteActivity()).catch(() => undefined)
    } catch { /* observation is advisory */ }
  }

  /** §5.1: a new session pulls before its first turn — the corpus is fresh. */
  #listenForFirstTurnPull(): void {
    try {
      this.ctx.on('session/event', makeFirstTurnPullListener({
        pull: (cwd) => this.#scheduler().then((s) => s.pullFor(cwd)),
      }))
    } catch {
      // L0 ctx without an event bus: same containment rule as signatures.
    }
  }

  #listenForSignatures(): void {
    try {
      // Lazy subprocess resolution for CodeGraph integration — same pattern as
      // dsh-codegraph. The service may mount after this engine; ctx.get returns
      // undefined when absent, which enrichSignatureWithCodegraph handles as a no-op.
      const subprocess = this.ctx.get?.('subprocess') as import('./codegraph.ts').SubprocessLike | undefined
      this.ctx.on('session/event', makeSignatureListener({
        store: () => this.store(),
        warn: (error) => { this.ctx.logger?.warn?.(`dsh-chapters: signature capture failed (${String(error)})`) },
        subprocess,
        storeRoot: this.chaptersConfig.artifactStoreRoot,
        onCollected: (id, sig) => {
          this.ctx.logger?.info?.(`dsh-chapters: signature collected for ${id} (${sig.seqs.length} events, ${sig.paths.length} paths, ${sig.size} est tokens)`)
        },
      }))
      // #61: the seventh moment, registered where the other turn/end doors already live. Its own
      // watermark makes a re-run a no-op, and it creates NO session — the mid-step rule stays intact.
      this.ctx.on('session/event', makeChildArchiveListener({
        ctx: { logger: this.ctx.logger },
        // the store opens lazily and once — same accessor the signature listener uses; a row that
        // resolved it per turn would reopen the domain on every turn/end.
        store: () => this.store().then(({ store }) => store),
        wiring: {
          presetId: 'chapters',
          artifactStoreRoot: this.chaptersConfig.artifactStoreRoot,
          chapterTokenTarget: this.chaptersConfig.chapterTokenTarget,
          toolResultDeferFloorTokens: this.chaptersConfig.toolResultDeferFloorTokens,
          mergeThreshold: this.chaptersConfig.mergeThreshold,
          chapterLimit: this.chaptersConfig.chapterLimit,
          scheduler: { schedule: (cwd: string, reason: string) => { void this.#scheduler().then((sc) => sc.schedule(cwd, reason)) } },
        },
        enabled: this.chaptersConfig.childAutoArchive ?? true,
        minTurns: this.chaptersConfig.childAutoArchiveMinTurns ?? 4,
      }))
    } catch {
      // A non-cordis ctx (L0 construction) has no event bus — signatures are
      // optional there by design; the compaction path is unaffected.
    }
  }

  /**
   * #50 §7.5: capture `ADD RULE:` markers at the SAME `turn/end` boundary the
   * topic signatures use — this extends an existing door, it is not a sixth
   * archive moment. Deterministic and model-free (invariant 1): no marker in the
   * turn costs one string scan and nothing else. Gated off when `harnessId` is
   * absent, because a rule with no author partition is a rule nothing can
   * revoke.
   */
  #listenForRuleCapture(): void {
    try {
      this.ctx.on('session/event', makeRuleCaptureListener({
        enabled: () => this.ruleCfg.captureEnabled,
        prefix: () => this.ruleCfg.markerPrefix,
        // The realm row's harnessId, or the same default the host plane's config
        // uses (`hostname()`). A custom host-plane override does NOT strand the
        // rule: the directory is only an author partition, and rendering walks
        // every dir under `rules/` and activates by scope+ancestry (§7.5) — the
        // id prefix differs, nothing else.
        harnessId: () => (this.ruleCfg.harnessId !== '' ? this.ruleCfg.harnessId : hostname()),
        storeRoot: (cwd) => resolveStoreRoot(cwd, this.chaptersConfig.artifactStoreRoot),
        store: async () => ({ store: (await this.store()).store as RegistryStore }),
        warn: (error) => { this.ctx.logger?.warn?.(`dsh-chapters: session-rule capture failed (${String(error)})`) },
        onCaptured: (sessionId, ids) => {
          this.ctx.logger?.info?.(`dsh-chapters: ${ids.length} session rule(s) captured for ${sessionId} (${ids.join(', ')})`)
        },
      }))
    } catch {
      // same containment as signatures: a non-cordis ctx has no event bus
    }
  }

  /** Lazy, once. `storageDomain` is a host-plane singleton the realm resolves;
   * acquire (never bare-open): a mounted tools-plugin may already own the reservation. */
  private store(): Promise<ChapterStoreHandle> {
    this.storePromise ??= (async () => {
      const sd = (this.ctx as unknown as { get?: (n: string) =>
        { open: (s: unknown) => Promise<unknown>; get?: (name: string) => unknown } | undefined }).get?.('storageDomain')
      if (sd === undefined) throw new Error('chapters: storageDomain service absent — cannot archive')
      return acquireChapterStore(sd as never)
    })()
    return this.storePromise
  }

  // ------------------------------------------------------------ the sanctioned hook

  protected override async summarize(
    input: SummarizeInputLike,
    agent: unknown,
    _signal?: AbortSignal,
  ): Promise<SummarizeResultLike> {
    const session = (agent as { session: EngineSession }).session
    const cwd = (session as unknown as { header?: { cwd?: string } }).header?.cwd ?? null
    const cid = findOpenCompactionId(session)

    if (cid === null || cwd === null || input.messages.length === 0) {
      // Degraded but honest: compaction proceeds with a plain deterministic
      // digest; NO chapter path is cited, so nothing can dangle. A distinct
      // provider tag keeps the finalizer's scan from claiming this record.
      return {
        summary: carryOpenRequest([{ type: 'text', text: `Compacted ${input.messages.length} messages (deterministic digest; no chapter: ${cwd === null ? 'no workspace cwd' : cid === null ? 'no open transaction' : 'empty region'}).` }], input.messages, this.chaptersConfig.openRequestCarryMaxChars),
        provider: `${CHAPTERS_PROVIDER}-degraded`,
        model: DETERMINISTIC_MODEL,
      }
    }

    const { store } = await this.store()
    const state = await store.get(session.id)

    // Topic-sequential composition inside AUTO compaction (r29 — the record's
    // §4.2 applied where sessions actually meet pressure, not only at the
    // fork). Reconstruction maps the prepared region back to log seqs; any
    // uncertainty (no Session mapping API, no collections, ambiguous match,
    // thrown anywhere) falls to the legacy single-chapter plan, which is the
    // behavior that has always been correct.
    let composition: readonly ChapterRange[] | null = null
    try {
      const seqs = reconstructShadowedSeqs(session, input)
      if (seqs !== null && state.collections.length > 0) {
        const spanStart = seqs[0]!
        const spanEnd = seqs[seqs.length - 1]!
        const spanEvents = seqs
          .map((seq) => session.eventAt(seq))
          .filter((e): e is NonNullable<typeof e> => e !== undefined) as unknown as SessionEventLike[]
        const composed = composeChapters(spanEvents, spanStart, spanEnd, state.collections, {
          mergeThreshold: this.chaptersConfig.mergeThreshold,
          chapterLimit: this.chaptersConfig.chapterLimit,
        })
        if (composed.chapters.length > 0) {
          const chs: ChapterRange[] = [...composed.chapters]
          // Compaction SHADOWS the whole selected span — unlike the fork, its
          // span need not end on a turn boundary. Absorb head/tail strays so
          // nothing is ever shadowed unarchived.
          if (chs[0]!.startSeq > spanStart) chs[0] = { ...chs[0]!, startSeq: spanStart }
          const lastIdx = chs.length - 1
          if (chs[lastIdx]!.endSeq < spanEnd) chs[lastIdx] = { ...chs[lastIdx]!, endSeq: spanEnd }
          composition = chs
        }
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-chapters: compaction composition fell back to legacy (${String(error)})`)
    }

    // Plot carriage (architecture.md amendment): the model's own forward-
    // maintained note survives the shadowing; when the agent never wrote one,
    // one BOUNDED elicited call over the region being condensed (tail-heavy,
    // ~8K chars in, ≤150 words out) — approved exception to zero-inference,
    // gated by config. Any failure degrades to no plot; it never breaks the
    // compaction path.
    let plot = extractPlot(input.messages)
    if (plot === null && this.chaptersConfig.elicitedPlot) plot = await this.#elicitPlot(agent, input, _signal)

    // The operative plan travels INTO the checkpoint, session-wide and newest-first:
    // "what am I building" is not a property of the region being shadowed, so the
    // carry reads the whole log rather than the span (docs/plans-carriage.md § 9).
    let planCarry: string | null = null
    if (this.chaptersConfig.plansInCheckpoint) {
      try {
        const all = (session as { snapshotEvents?: () => readonly SessionEventLike[] } | undefined)?.snapshotEvents?.() ?? []
        planCarry = carryActivePlan(detectPlans(all).plans, { maxChars: this.chaptersConfig.planCheckpointChars })
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-chapters: plan carriage skipped (${String(error)}) — the archive still holds the plan`)
      }
    }

    // #50 §7.6: the rules ride the checkpoint the way the plot and the plan do.
    // Anything that goes wrong here DEGRADES TO NOTHING and is reported on the
    // operator channel — the compaction critical path stays zero-model-token and
    // never fails because of a rules read (§1 invariant 1, §7.3's non-blocking rule).
    let rulesCarry: string | null = null
    try {
      rulesCarry = await this.#rulesForCheckpoint(session)
    } catch (error) {
      this.#diagnostic(`dsh-chapters: rule carriage skipped (${String(error)}) — the archive still holds every rule`)
    }

    // #59: everything ABOVE this line (composition, plot elicitation, rules, plan carry) is
    // expensive and may cross a model call; the WRITE re-runs on a fresh row inside one section, so
    // the reservation and manifest can no longer be rewound by a stale whole-row put — and the TOC
    // text we are about to hand the host cites numbers that are durable at this point.
    let tocText = ''
    await store.mutate(session.id, (fresh) => {
      // #69: the realm resolves an ABSOLUTE store root; hand planSummarize the session cwd so the record it
      // mints is workspace-relative like every door's.
      const wcwd = (session as { header?: { cwd?: string } }).header?.cwd
      const { plan, state: next } = planSummarize(session, fresh, input, { ...this.chaptersConfig, workspaceCwd: wcwd }, reserve, cid, composition, plot, planCarry, rulesCarry)
      const stored = rememberPlan(next, cid, {
        number: plan.numbers[0]!, path: plan.chapter.path, title: plan.chapter.title, summary: plan.chapter.summary,
        ...(plan.chapters !== undefined ? { chapters: plan.chapters } : {}),
      })
      // The drift check that has existed with zero callers: a manifest whose reservation is not
      // durable (or not the same numbers) means the TOC we are about to emit cites the unreachable.
      assertReservationMatchesPlan(stored, cid, plan)
      tocText = plan.tocText
      return stored
    })
    return { summary: carryOpenRequest([{ type: 'text', text: tocText }], input.messages, this.chaptersConfig.openRequestCarryMaxChars), provider: CHAPTERS_PROVIDER, model: DETERMINISTIC_MODEL }
  }

  // ------------------------------------------------------------ entry points (finalize after commit)

  /**
   * Arrival-time artifacting (architecture.md amendment): heads EVERY
   * compaction entry — pre-step pressure, overflow retries, manual compact —
   * so oversized tool results are stubbed at the tail node before the next
   * request composes (the base listener awaits this call before next(),
   * compaction-basic/lib/index.js:799-812). Never throws; degradation is
   * logged and the blob simply stays inline (today's behavior).
   */
  async #elicitPlot(agent: unknown, input: SummarizeInputLike, signal?: AbortSignal): Promise<string | null> {
    try {
      const session = (agent as { session: EngineSession & { id: string } }).session
      // tail-heavy flattening: the plan lives in what the model said RECENTLY.
      // Host-injected spans are screened OUT of the excerpt (stripReminderSpans
      // — the same 'project state, not conversation' screen the chapter
      // renderer uses). The excerpt is the only model-visible text on this
      // path, so injections left in would make the elicited-plot request
      // machine-dependent: measured on hosted CI 2026-09-26, where the
      // runner's live excerpt carried a workspace-instructions span my
      // recording region had not, the recorded exchanges 503'd, and heavy
      // died mid-chain.
      let flat = ''
      for (let i = input.messages.length - 1; i >= 0 && flat.length < 8000; i--) {
        const m = input.messages[i] as { role?: string; content?: { type?: string; text?: string }[] }
        const raw = (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ')
        const text = stripReminderSpans(raw).text.slice(0, 1200)
        if (text.length > 0) flat = `${m.role ?? '?'}: ${text}\n${flat}`
      }
      const instruction = 'You maintain a plot note for a conversation about to be compacted. From the excerpt below, state in at most 60 words, on one line beginning exactly with "PLOT:", what the agent is mid-way through: objective, current hypothesis, immediate next step. No tools, no prose around the line.\n\nEXCERPT:\n' + flat.slice(-8000)
      // Unified auxiliary route (P2 decision): the enrichment resolver (override
      // > config > persisted heartbeat > live conversation route) serves plot
      // too; the summarization row fields remain a legacy prefix override.
      const w = await this.#enrich().catch(() => null)
      const shared = w?.auxRoute() ?? null
      const cfg = (this as unknown as { config?: { summarizationProvider?: string; summarizationModel?: string } }).config ?? {}
      const legacy = (typeof cfg.summarizationProvider === 'string' && cfg.summarizationProvider !== ''
        && typeof cfg.summarizationModel === 'string' && cfg.summarizationModel !== '')
        ? { provider: cfg.summarizationProvider, model: cfg.summarizationModel } : null
      const route = legacy ?? (shared !== null && shared.provider !== '' && shared.model !== '' ? shared : this.lastRoute)
      if (route === null) {
        // Loud, not silent: an empty plot section is a legitimate outcome, but
        // SILENTLY skipping is how the treeseed run's early child checkpoints
        // lost their plots without a trace (2026-09-27 audit).
        this.#diagnostic('dsh-chapters: plot elicitation skipped — no route resolved (lastRoute unset, no aux route)')
        return null
      }
      // 600, not 220: reasoning tokens count against the budget on reasoning
      // models (measured: the elicit prompt alone used 155 of 220 with a SHORT
      // excerpt — real 8K-char excerpts invite more thinking and starved the
      // content to nothing). Malformed replies are now logged with a snippet.
      const text = await this.#auxComplete(instruction, route, 600, signal, session.id)
      const at = text.indexOf('PLOT:')
      if (at === -1) {
        this.#diagnostic(`dsh-chapters: plot elicitation reply carried no PLOT line (${text.length} chars): ${JSON.stringify(text.slice(0, 80))}`)
        return null
      }
      const para = text.slice(at + 5).split(/\n\s*\n/)[0]!.trim()
      if (para.length === 0) {
        this.#diagnostic('dsh-chapters: plot elicitation reply had an empty PLOT line')
        return null
      }
      return para.slice(0, 900)
    } catch (error) {
      this.#diagnostic(`dsh-chapters: plot elicitation failed (${String((error as Error)?.message ?? error).slice(0, 120)}) — continuing without a plot`)
      return null
    }
  }

  async #arrive(agent: Agent): Promise<void> {
    // #129: this path decides whether an oversized tool result becomes an artifact, and three separate
    // investigations today (arrival's stub-pair failure pinned and unpinned, fanout's lost synthesis, the CI
    // misses at the first assistant turn) all needed the same fact and none of them could get it: whether
    // #arrive RAN AT ALL for a given turn. It logged only its two skip branches, so silence was ambiguous
    // between "not called" and "called, deferred nothing" — the #61 rule applies: entry is a fact worth
    // delivering, with the numbers that decide the outcome.
    {
      const session = agent.session as unknown as ArrivalSessionShim & { header?: { cwd?: string } }
      diagnosticNote(this.ctx.logger, 'realm:engine:arrive',
        `entered: nodes=${String(session.surface?.nodes?.length ?? -1)}`
        + ` cwd=${session.header?.cwd === undefined || session.header.cwd === '' ? 'NONE' : 'set'}`
        + ` floor=${String(this.chaptersConfig.toolResultArtifactTokens)}`
        + ` lastResort=${String(this.chaptersConfig.lastResortArtifact === true)}`)
    }
    const session = agent.session as unknown as ArrivalSessionShim & { header?: { cwd?: string } }
    const cwd = session.header?.cwd
    if (cwd === undefined || cwd === '') {
      // #78: two bare returns made arrival artifacting vanish COMPLETELY, silently — the very
      // silence that lets a leg fail while nobody can say whether the code path ran. And the
      // reason is printed as the SHAPE it found, because `session.header?.cwd` is precisely the
      // assumption a host format bump retires (the v3→v4 log lesson).
      diagnosticNote(this.ctx.logger, 'realm:engine:arrive',
        `arrival stubbing skipped: no session cwd (session keys=${Object.keys(session ?? {}).slice(0, 10).join(',')})`)
      return
    }
    const meter = (this.ctx as unknown as { tokenMeter?: { estimateMessage: (m: unknown) => number } }).tokenMeter
    if (meter === undefined) {
      diagnosticNote(this.ctx.logger, 'realm:engine:arrive', 'arrival stubbing skipped: no tokenMeter on the realm context')
      return
    }
    const r = await applyArrivalStubs(session, {
      cwd,
      storeRoot: this.chaptersConfig.artifactStoreRoot,
      floorTokens: this.chaptersConfig.toolResultArtifactTokens,
      estimate: (m: unknown) => meter.estimateMessage(m),
    })
    if (r.detail !== undefined) this.ctx.logger?.warn?.(`dsh-chapters: arrival stubbing degraded (${r.detail})`)
  }

  /**
   * One line per compaction decision — the second half of "is relief actually running?".
   * `realm:engine:*` so the site is attributable, note-level so a routine decision never reads as
   * a failure, and it names which entry point (`compactIfNeeded` on pressure/auto vs `compactNow`
   * on `/compact`) because those two disagreeing is exactly the kind of drift a field report needs
   * to be able to tell apart. (#78)
   */
  /**
   * The last-resort deferral (#78 option A). Returns how many nodes it stubbed, and 0 — never a
   * guess — unless every input to the ceiling is real: `resolveStoreRoot`-style derivation lives in
   * `lastResortCeilingTokens`, so this method only supplies measured values. Runs only from the
   * declined branch; the operator's `toolResultArtifactTokens` still governs every ordinary case.
   */
  async #lastResortRelief(agent: Agent, signal: AbortSignal): Promise<number> {
    try {
      if (this.chaptersConfig.lastResortArtifact !== true) return 0
      const route = this.lastRoute
      const meter = (this.ctx as unknown as {
        tokenMeter?: { measure?: (s: unknown) => { totalTokens?: number }, estimateMessage?: (m: unknown) => number }
      }).tokenMeter
      const llm = (this.ctx as unknown as {
        llm?: { resolveModelInfo?: (p: string, m: string, s: AbortSignal) => Promise<unknown> }
      }).llm
      if (route === null || meter === undefined || typeof llm?.resolveModelInfo !== 'function') return 0
      const info = await llm.resolveModelInfo(route.provider, route.model, signal) as
        { context?: { contextWindow?: number, maxTokens?: number }, defaultMaxTokens?: number } | undefined
      const base = this as unknown as { config?: { retainRatio?: number, retainTokens?: number, maxTokens?: number } }
      // Quiet unless there is a problem to solve. Relief declines on EVERY ordinary pre-step because
      // the surface is below the trigger, and the first two notes this feature ever emitted were that
      // non-event — noise that also hid the case worth naming. Every value here is measured at this
      // point in the method: no invented field and no assumed window (my first attempt reached for a
      // `lastWindowTokens` that does not exist, and `tsc` was the only thing that caught it).
      const surfaceNow = Number(meter.measure?.(agent.session)?.totalTokens ?? NaN)
      const ratioNow = (this as unknown as { config?: { thresholdRatio?: number } }).config?.thresholdRatio
      const windowNow = Number(info?.context?.contextWindow ?? NaN)
      const overTrigger = Number.isFinite(surfaceNow) && Number.isFinite(windowNow)
        && typeof ratioNow === 'number' && surfaceNow > windowNow * ratioNow
      const retainTokens = base.config?.retainTokens
      // The host builds model-info as `{ context: { contextWindow }, ...defaultMaxTokens ? { defaultMaxTokens } : {} }`
      // — read out of the pinned bundle today. `defaultMaxTokens` is a SIBLING of `context`, so the previous line
      // read a field that never exists, fell through to the base config's `maxTokens` (65,536: a routing
      // headroom, `resolveConfig` defaults it from `headroomTokens`), and made the ceiling negative forever. The
      // model's real output budget is 15,000 here, which is what makes `window − retain − reserved` derivable.
      const reserved = Number(info?.defaultMaxTokens ?? info?.context?.maxTokens ?? base.config?.maxTokens ?? NaN)
      const ceiling = lastResortCeilingTokens({
        windowTokens: Number(info?.context?.contextWindow ?? NaN),
        retainRatio: Number(base.config?.retainRatio ?? NaN),
        // optional, not `| undefined`: `exactOptionalPropertyTypes` is on, and a property that can
        // hold undefined is a different promise from one that may be absent.
        ...(retainTokens !== undefined ? { retainTokens } : {}),
        // The completion budget comes from the MODEL, measured: `resolveConfig` defaults
        // `maxTokens` to `headroomTokens` (65,536 — a routing headroom, not a per-request output
        // budget), so `32,000 − 5,120 − 65,536` is negative and the ceiling is permanently
        // underivable. `info.context.maxTokens` (15,000 here) sits in the same object as
        // `contextWindow`; the base config stays only as a fallback so the abstention path still
        // fires and says so when neither is present.
        reservedCompletionTokens: reserved,
      })
      if (ceiling === null) {
        // Measured tonight: relief declined twice with `surface=39983 trigger=16000` and the last
        // resort NEVER fired — and said nothing about why. A feature that abstains silently is
        // indistinguishable from a feature that isn't installed, which is the exact complaint this
        // branch has filed against everything else (#61a). So: name the missing input.
        diagnosticNote(this.ctx.logger, 'realm:engine:last-resort',
          `not applied: coexistence ceiling underivable (window=${String(info?.context?.contextWindow)}, retainRatio=${String(base.config?.retainRatio)}, retainTokens=${String(base.config?.retainTokens)}, maxTokens=${String(base.config?.maxTokens)}) — check the realm row's compaction keys, not this feature`)
        return 0
      }
      const session = agent.session as unknown as ArrivalSessionShim & {
        surface: { nodes: number[] }, header?: { cwd?: string }
      }
      const cwd = session.header?.cwd ?? ''
      if (cwd === '') return 0 // no workspace identity, no deferral — same rule as `#arrive`
      const before = [...session.surface.nodes].length
      const r = await applyArrivalStubs(session, {
        cwd,
        storeRoot: resolveStoreRoot(cwd, this.chaptersConfig.artifactStoreRoot),
        floorTokens: ceiling,
        estimate: (m: unknown) => meter.estimateMessage?.(m) ?? 0,
      })
      if (r.stubbed > 0) {
        diagnosticWarn(this.ctx.logger, 'realm:engine:last-resort',
          `relief declined, so ${String(r.stubbed)} tool/result node(s) larger than the coexistence ceiling (${String(ceiling)} tok) were artifact-deferred regardless of toolResultArtifactTokens — survivability over economy (#78 A); the archive keeps every byte and chapters_artifact answers for them (surface nodes ${String(before)} → ${String(session.surface.nodes.length)})`)
      }
      return r.stubbed
    } catch { /* a last resort must never become the reason relief failed */
      return 0
    }
  }

  /** See the call site: a decline while OVER the trigger is a statement, not a shrug. Never throws. */
  async #reportDecline(agent: Agent, signal: AbortSignal): Promise<void> {
    try {
      const route = this.lastRoute
      const meter = (this.ctx as unknown as {
        tokenMeter?: { measure?: (s: unknown) => { totalTokens?: number }, estimateMessage?: (m: unknown) => number }
      }).tokenMeter
      if (route === null || meter === undefined) return
      const surface = meter.measure?.(agent.session)?.totalTokens
      const llm = (this.ctx as unknown as {
        llm?: { resolveModelInfo?: (p: string, m: string, s: AbortSignal) => Promise<unknown> }
      }).llm
      if (typeof surface !== 'number' || typeof llm?.resolveModelInfo !== 'function') return
      const info = await llm.resolveModelInfo(route.provider, route.model, signal) as
        { context?: { contextWindow?: number } } | undefined
      const window = info?.context?.contextWindow
      const ratio = (this as unknown as { config?: { thresholdRatio?: number } }).config?.thresholdRatio
      if (typeof window !== 'number' || typeof ratio !== 'number') return
      const triggerTokens = Math.floor(window * ratio)
      if (surface <= triggerTokens) return
      const session = agent.session as unknown as ArrivalSessionShim & { surface: { nodes: number[] } }
      let oversized = 0
      let biggest = 0
      for (const seq of session.surface.nodes) {
        const ev = session.eventAt(seq)
        if (ev?.type !== 'tool/result') continue
        const est = meter.estimateMessage?.((ev as { data?: { message?: unknown } }).data?.message) ?? 0
        if (est > biggest) biggest = est
        if (est > triggerTokens) oversized += 1
      }
      diagnosticWarn(this.ctx.logger, 'realm:engine:decline',
        `relief declined while the surface is over the trigger (surface=${String(surface)} trigger=${String(triggerTokens)} window=${String(window)} ratio=${String(ratio)}): no safe range to compact, and ${String(oversized)} inline tool/result node(s) individually exceed the trigger (largest ${String(biggest)} tok). Context relief needs the arrival floor below that node size — toolResultArtifactTokens is the operator switch, and the archive keeps every byte either way.`)
    } catch { /* a report must never become the reason compaction failed */ }
  }

  #noteDecision(where: string, trigger: unknown, result: CompactionResult | null, agent: Agent): void {
    // The INPUTS, not just the verdict: `decided: none` is one word covering two opposite bugs —
    // no routed target (the base returns null on line one) and under-threshold (a real decision).
    // Heavy's leg sat exactly there, so the note now carries route, surface tokens and ratio.
    // All of it wrapped: a diagnostic that can throw is a diagnostic that will eat the step.
    let route = 'unknown'
    let surface = '? tok'
    try {
      route = this.lastRoute === null ? 'none' : `${this.lastRoute.provider}/${this.lastRoute.model}`
      const meter = (this.ctx as unknown as { tokenMeter?: { measure?: (s: unknown) => { totalTokens?: number } } }).tokenMeter
      const measured = meter?.measure?.((agent as { session?: unknown }).session)
      if (typeof measured?.totalTokens === 'number') surface = `${String(measured.totalTokens)} tok`
    } catch { /* never let instrumentation break compaction */ }
    diagnosticNote(this.ctx.logger, `realm:engine:${where}`,
      `${where} decided: ${result === null ? 'none' : `compaction ${String((result as unknown as { compactionId?: string })?.compactionId ?? '?')}`} (trigger=${JSON.stringify(trigger)}, session=${String((agent as { session?: { id?: string } })?.session?.id ?? '?')}, route=${route}, surface=${surface}, ratio=${String((this as unknown as { config?: { thresholdRatio?: number } }).config?.thresholdRatio ?? '?')})`)
  }

  override async compactIfNeeded(
    agent: Agent, trigger: CompactionTrigger, signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    // #78: the entry line that proves the HOST called this. Every row in the lifecycle suite
    // CALLS `compactIfNeeded` directly — the test has always been the caller, which is exactly
    // how a suite stays green while the product relieves nothing. Field evidence on 0.2.0-rc.2:
    // 35,428 tokens against a 16,000 trigger, ZERO `compaction/*` events, and no line anywhere
    // saying whether relief ran. One info line per entry, carrying the trigger the host passed,
    // makes "is context relief wired at all?" answerable from a session log instead of inferred.
    diagnosticNote(this.ctx.logger, 'realm:engine:compact',
      `compactIfNeeded entered (trigger=${JSON.stringify(trigger)}, session=${String((agent as { session?: { id?: string } })?.session?.id ?? '?')})`)
    this.#observeRoute(agent)
    await this.#arrive(agent)
    // Finalization runs whether super resolves OR throws: the pressure retry
    // loop can commit one compaction and then reject on a later attempt (shrink
    // floor — measured r19: 3 reserved plans, 1 finalized, zero errors, because
    // success-path-only finalization skipped the committed record). The scan is
    // session-based and idempotent; the original error is rethrown untouched.
    let result: CompactionResult | null
    try {
      result = await super.compactIfNeeded(agent, trigger, signal)
    } catch (error) {
      await this.#finalizeGuarded(agent)
      // #140: a configuration the user can fix is a NOTE, not an exception out of the relief path. Finalization has
      // already run above, so a durable plan is never left stranded; the base engine's own message carries the window
      // and the headroom that made the budget negative, which is exactly what an operator needs to change.
      if (isPressureConfigRejection(error)) {
        diagnosticWarn(this.ctx.logger, 'realm:engine:pressure-config',
          `relief unavailable for this target (headroom vs context window; the realm's headroomTokens is the switch) — ${String((error as Error)?.message ?? error)}`)
        // Both facts are delivered, not one: a config-impossible realm is still a relief that DECLINED while the
        // surface sat over the trigger, and the over-trigger report is the row (#78) and the operator's numbers.
        // Suppressing it here would trade one silence for another, which is the failure this file keeps refusing.
        await this.#reportDecline(agent, signal)
        this.#noteDecision('compactIfNeeded', trigger, null, agent)
        return null
      }
      // A throw while the surface is OVER the trigger is the same field failure as a null —
      // arguably worse, because the user sees the endpoint's 400 rather than our explanation.
      // Report first, then rethrow untouched; the report itself can never mask the error.
      await this.#reportDecline(agent, signal)
      // no result exists on this path — the base engine threw — so the line says `none` and the
      // reason is the rethrown error, not a value invented for the log
      this.#noteDecision('compactIfNeeded', trigger, null, agent)
      throw error
    }
    if (result !== null) await this.#finalizeGuarded(agent)
    // #78: entry alone is half the question. Three `trigger="pressure"` entries on 0.2.0-rc.2
    // produced no `compaction/*` event at all, and nothing could say whether the base engine
    // declined (a meter/threshold disagreement) or acted and our finalization lost the evidence.
    // The decision now sits beside the entry, in the same artifact.
    // #78: the quiet failure was the worst part. Six compactions, then a raw `400 … exceeds the
    // context window` from the endpoint, and nothing the product said about WHY relief stopped.
    // This reports the numbers it actually had — surface, trigger, window, ratio, and how many
    // inline tool/results are individually larger than the trigger — and changes no behavior:
    // the arrival floor is the operator's switch (AGENTS: a behavior switch, not a knob), and the
    // engine does not get to reinterpret it silently.
    if (result === null) {
      // #78 option A: relief declined, so a node that cannot coexist with the mandatory tail is no
      // longer an economy question — the session is stuck. Defer THAT node as a last resort and give
      // relief one more chance. Ordering is the whole design: this sits inside the declined branch,
      // never in `#arrive`, so `heavy` still proves pressure compaction first. An eager version would
      // arrival-stub the surface and make the leg's claim untestable (AGENTS' named trap), which is
      // what the anti-vacuity rows below guard against.
      const deferred = await this.#lastResortRelief(agent, signal)
      if (deferred > 0) {
        try {
          const retry = await super.compactIfNeeded(agent, trigger, signal)
          if (retry !== null) {
            await this.#finalizeGuarded(agent)
            this.#noteDecision('compactIfNeeded', trigger, retry, agent)
            return retry
          }
        } catch { /* still stuck: fall through to the decline report, then rethrow nothing */ }
      }
      await this.#reportDecline(agent, signal)
    }
    this.#noteDecision('compactIfNeeded', trigger, result, agent)
    return result
  }

  override async compactNow(
    agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    this.#observeRoute(agent)
    await this.#arrive(agent)
    let result: CompactionResult | null
    try {
      result = await super.compactNow(agent, signal, sourceCommandId)
    } catch (error) {
      await this.#finalizeGuarded(agent)
      this.#noteDecision('compactNow', 'manual', null, agent)
      throw error
    }
    if (result !== null) await this.#finalizeGuarded(agent)
    // #78: the same decision line on the manual path. Reporting only the pressure route would
    // leave `/compact` — the door a human actually pulls — as silent as the bug this instrument
    // exists to catch.
    this.#noteDecision('compactNow', 'manual', result, agent)
    return result
  }

  /**
   * Finalization failure must never break a committed compaction (the surface
   * is already correct and the log holds everything needed to retry) — it
   * warns, and the per-session reconciliation scan retries it on next touch.
   */
  async #finalizeGuarded(agent: Agent): Promise<void> {
    const session = agent.session as unknown as EngineSession
    try {
      await this.#finalizeAllOutstanding(session)
    } catch (error) {
      this.#diagnostic(`dsh-chapters: chapter finalization deferred (session ${session.id}): ${String((error as Error)?.stack ?? error)}`)
    }
  }

  /**
   * §7.3/§7.6: the block this session's rebuilt head should carry, from the ONE
   * builder that renders it for the notice too — a second rule-ranking or
   * rule-selecting implementation is forbidden (record §8: two doors, one
   * scorer). Zero bytes when nothing is active.
   *
   * Relevance topics come from the session's OWN stored turn signatures
   * (deterministic, already on disk, no model call), newest last. With
   * `rulesRelevance` off the selection falls back to category→id order, which is
   * the order the tapes were distilled against.
   */
  async #rulesForCheckpoint(session: EngineSession): Promise<string | null> {
    const cwd = (session as { header?: { cwd?: string } }).header?.cwd
    if (cwd === undefined || cwd === '') return null
    const { store } = await this.store()
    const harness = this.ruleCfg.harnessId !== '' ? this.ruleCfg.harnessId : hostname()
    const project = projectForCwd(store.projects(), cwd)
    // the SAME renderer the doors use — one builder for every rebuilt head (§7.3)
    const built = await renderRulesBlock({
      // #85: the configured root, not the constant — an e2e boot pins this per port so a notice
      // cannot pick up rules from whatever the developer's repo happens to contain.
      mirrorDir: resolveStoreRoot(cwd, this.chaptersConfig.knowledgeMirrorDir ?? DEFAULT_CLONE_DIR),
      storeDir: resolveStoreRoot(cwd, this.chaptersConfig.artifactStoreRoot),
      projectKey: project?.projectKey ?? '',
      harnessId: harness,
      budgetTokens: this.ruleCfg.budgetTokens,
      projectCap: this.ruleCfg.projectCap,
      sessionCap: this.ruleCfg.sessionCap,
      relevance: this.ruleCfg.relevance,
      includeSession: true,
      store,
      sessionId: session.id,
      // #52: the delegation edge. A subagent that compacts in place must see the
      // rules of the session that delegated it, or the whole point of the tier is
      // lost exactly where the work actually happens.
      ...(() => { const p = this.ruleParentOf(); return p !== undefined ? { parentOf: p } : {} })(),
    })
    if (built.kind === 'none') return null
    if (built.kind === 'refusal') {
      // announced, never clipped: the head says the rules did not fit rather
      // than silently carrying none of them
      this.#diagnostic(`dsh-chapters: rules over budget at this checkpoint — ${built.reason}`)
      return `Rules NOT carried into this checkpoint (their token budget was exceeded, so nothing was clipped): ${built.reason}`
    }
    return built.text
  }

  /**
   * The operator-visible warn channel (r19: headless profiles route ctx.logger
   * where nobody can see it; measured again 2026-09-27: even the in-process
   * logger surface is unassertable on this node build). Warn + mirror to the
   * DSH_CHAPTERS_ENGINE_ERRORS append file when opted in — diagnostics seam,
   * not a tunable. Any degradation that leaves the user wondering "did the
   * feature run?" belongs here.
   */
  #diagnostic(message: string, error?: unknown): void {
    // #54: ONE writer, in src/diag.ts. This held a private three-line copy of the sink while
    // the two places a user's door can actually fail — the host-plane tool and the shared
    // continuation core — wrote nothing anywhere. Which is how a kernel refusal that ended the
    // whole acceptance chain left no trace readable without a browser.
    diagnosticWarn(this.ctx.logger, 'realm:engine', message, error)
  }

  /** Every provider-tagged summary without a finalized manifest, oldest first. */
  /**
   * Per-item containment (#59). The scan used to await `#finalizeOne` in a bare loop, and
   * `#finalizeOne` THROWS when a manifest is missing — so one erased manifest (exactly what the
   * SAIP lost-update produced) aborted the scan on its first iteration forever: every later
   * compaction in that session could never write its chapters, and their numbers stayed burned.
   * One bad item may never poison the items behind it: report it, name it, continue.
   */
  async #finalizeAllOutstanding(session: EngineSession): Promise<void> {
    const { store } = await this.store()
    const out = await scanAndFinalize(
      await store.get(session.id),
      scanChaptersSummaries(session),
      async (found) => { await this.#finalizeOne(session, store, found.compactionId, found.shadowedSeqs) },
      (reason, error) => this.#diagnostic(
        `dsh-chapters: chapter finalization deferred for compaction ${reason.compactionId} (${reason.reason}: `
        + `${String((error as Error)?.message ?? error)}) — its chapter was never written and the `
        + 'rest of the queue still proceeds. Run /chapters-repair (issue #60) to materialize it.',
      ),
    )
    if (out.done.length > 0) {
      const cwd = (session as unknown as { header?: { cwd?: string } }).header?.cwd
      if (cwd !== undefined) void this.#scheduler().then((s2) => s2.schedule(cwd, 'archive:compaction')).catch(() => undefined)
    }
  }

  async #finalizeOne(
    session: EngineSession,
    store: RegistryStore,
    compactionId: string,
    shadowedSeqs: readonly number[],
  ): Promise<void> {
    const state = await store.get(session.id)
    if (isFinalized(state, compactionId)) return
    const plan = state.plans[compactionId]
    const numbers = state.reservations[`compaction:${compactionId}`]
    if (plan === undefined || numbers === undefined) {
      throw new Error(`chapters: no durable plan/reservation for ${compactionId} (summarize never committed its manifest)`)
    }
    const cwd = (session as unknown as { header?: { cwd?: string } }).header?.cwd
    if (cwd === undefined) throw new Error('chapters: session has no cwd — nowhere reachable to write')

    const renderedList = buildFinalizedChapters(session, shadowedSeqs, {
      tocText: '', numbers, chapter: plan, ...(plan.chapters !== undefined ? { chapters: plan.chapters } : {}),
    }, this.chaptersConfig)

    const fs = makeArchiveFs(cwd)
    const wrote = await writeArchive({
      fs,
      allocator: makeAllocator(store, session.id),
      storeRoot: resolveStoreRoot(cwd, this.chaptersConfig.artifactStoreRoot),
      rootSessionId: state.rootSession,
      chapters: renderedList,
      attemptId: `compaction:${compactionId}`,
    })
    if (wrote.records.length !== renderedList.length) {
      // read-back failed or went missing — leaving this UNFINALIZED is the
      // point: the reconciliation scan will retry; nothing lies in the TOC.
      throw new Error(`chapters: write did not verify for ${compactionId}: ${wrote.warnings.join('; ')}`)
    }
    // Every record of this compaction carries the full shadowed span: they
    // jointly account for what the surface replacement hid (legacy single-
    // chapter behavior generalized).
    const records = wrote.records.map((r) => ({ ...r, shadowedSeqs: [...shadowedSeqs] }))
    // #59: `state` was read BEFORE writeArchive (render + every artifact write). Committing from it
    // would erase anything another door committed meanwhile — which is how the SAIP compaction lost
    // its record while its 960 KB file stayed on disk. The commit re-reads inside one section.
    await store.mutate(session.id, (fresh) => markFinalized(appendChapters(fresh, records), compactionId, numbers))
    // §5.1: compaction finalization is a push point (debounced).
    const cwdNow = (session as unknown as { header?: { cwd?: string } }).header?.cwd
    if (cwdNow !== undefined) void this.#scheduler().then((s) => s.schedule(cwdNow, 'archive:compaction')).catch(() => undefined)
    for (const w of wrote.warnings) this.ctx.logger?.warn?.(`dsh-chapters: ${w}`)
  }
}

export default ChaptersCompactionEngine
