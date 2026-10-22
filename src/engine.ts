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
import { diagnosticWarn, ensureDiagnosticsDefault } from './diag.ts'
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
import { stripReminderSpans } from './injections.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { applyArrivalStubs, type ArrivalSessionShim } from './arrival.ts'
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
  artifactStoreRoot?: string
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
        ensureDiagnosticsDefault(path.join(cwd, deps.storeRoot, 'diagnostics.log'))
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

export class ChaptersCompactionEngine extends BasicCompactionEngine {
  // Base inject is ['llm','tokenMeter','sessions']; subclassing INHERITS statics,
  // so re-declare with what the chapter flow adds (r12's crash, FINDINGS).
  static inject = ['llm', 'tokenMeter', 'sessions', 'storageDomain']

  static override Config = z.object({
    thresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
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
      summarizationProvider: z.string(),
      summarizationModel: z.string(),
      maxTokens: z.number().step(1).min(1),
      compactionRetries: z.number().step(1).min(0),
      maxOverflowRetries: z.number().step(1).min(0),
    })),
    auto: z.boolean(),
    artifactStoreRoot: z.string(),
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
      artifactStoreRoot, chapterTokenTarget, toolResultDeferFloorTokens,
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
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-chapters' } })],
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
        summary: [{ type: 'text', text: `Compacted ${input.messages.length} messages (deterministic digest; no chapter: ${cwd === null ? 'no workspace cwd' : cid === null ? 'no open transaction' : 'empty region'}).` }],
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
    return { summary: [{ type: 'text', text: tocText }], provider: CHAPTERS_PROVIDER, model: DETERMINISTIC_MODEL }
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
    const session = agent.session as unknown as ArrivalSessionShim & { header?: { cwd?: string } }
    const cwd = session.header?.cwd
    if (cwd === undefined || cwd === '') return
    const meter = (this.ctx as unknown as { tokenMeter?: { estimateMessage: (m: unknown) => number } }).tokenMeter
    if (meter === undefined) return
    const r = await applyArrivalStubs(session, {
      cwd,
      storeRoot: this.chaptersConfig.artifactStoreRoot,
      floorTokens: this.chaptersConfig.toolResultArtifactTokens,
      estimate: (m: unknown) => meter.estimateMessage(m),
    })
    if (r.detail !== undefined) this.ctx.logger?.warn?.(`dsh-chapters: arrival stubbing degraded (${r.detail})`)
  }

  override async compactIfNeeded(
    agent: Agent, trigger: CompactionTrigger, signal: AbortSignal,
  ): Promise<CompactionResult | null> {
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
      throw error
    }
    if (result !== null) await this.#finalizeGuarded(agent)
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
      throw error
    }
    if (result !== null) await this.#finalizeGuarded(agent)
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
      mirrorDir: path.join(cwd, DEFAULT_CLONE_DIR),
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
