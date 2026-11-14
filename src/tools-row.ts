/**
 * The `chapters-tools` realm row (#330) — the seven `chapters_*` tools and the three
 * continuation door commands, mounted INSIDE the preset composition (the `preset-chapters`
 * row's `plugins:` list in `cordis.patch.yml`), the same seam the host's own `dsh-tool-fs`
 * and `dsh-tool-subagent` rows use.
 *
 * WHY A ROW AND NOT THE HOST PLANE
 * --------------------------------
 * A tool registered on the host plane rides EVERY session's request, whatever preset
 * composes it — measured in the #319 e2e logs, where `standard`-preset headers carried the
 * whole `chapters_*` schema set while the chapters persona suffix was absent. A tool
 * description is prompt text: shipping the archive vocabulary to agents that never chose
 * the archive is the leak #330 closes (AGENTS invariant 3, extended). Rows mounted from a
 * preset composition are scoped to sessions composing that preset — that is what the
 * standard/chapters tool-set differences (e.g. `tool-ralph`) have always proven.
 *
 * WHAT STAYS HOST-PLANE
 * ---------------------
 * The declaration row (`src/preset.ts`), roster verification, storage, the engine realm
 * row, the subagent-settlement listener (header-gated), the prompt bar, and the operator
 * commands — `/chapters-status`, `/chapters-link`, `/chapters-enrich`, `/chapters-remove`,
 * `/chapters-prompt`, and the repair/restore doors registered through
 * `registerChaptersRepairRestore` (a broken chapters child may not compose its realm at
 * all, and `/chapters-restore` (#319) is the documented way in). Command text is not a
 * model surface; tools are.
 *
 * The store is ACQUIRED, never bare-opened (engine.ts's rule: the host plane may own the
 * reservation); the domain closes at facility unmount, not at this fiber's — same shape as
 * `apply()` in src/index.ts (r35). Services not named in an `isolate:` block resolve
 * through the host scope, which is how the realm rows see `tools`, `storageDomain`,
 * `agents` and `sessionProjections` (the host's own realm tool rows are the precedent).
 *
 * @module dsh-chapters/src/tools-row
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { hostname } from 'node:os'
import { acquireChapterStore } from './store.ts'
import { createScheduler } from './index.ts'
import { registerChaptersTools, type ToolsConfig } from './tools.ts'

/** One mounted row of a preset composition reaches these host services; declare only what
 *  is used (docs/contract.md § Services). `commands` comes through `ctx.get` optionally,
 *  exactly as the host plane has always done it. */
interface RowCtx {
  agents: { create(opts: Record<string, unknown>): Promise<{ agent: unknown; dispose?: () => Promise<void> | void }> }
  tools: { register(def: unknown): () => void }
  llm?: {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ context?: { contextWindow?: number } } | undefined>
  }
  sessionProjections?: { stateOf(session: unknown, key: string): unknown }
  get?(name: string): unknown
  logger?: { info?: (m: string) => void; warn?: (m: string) => void }
}

/** The row's config — the doors' and tools' tunables, declared on this plane (#330).
 *  Names and defaults mirror the host plane's `Config` (index.ts): the two planes carry no
 *  cross-channel, so a profile that retunes a shared key sets it in both places, and
 *  leaving either unset keeps the documented default. `searchMaxTokens` is the realm-side
 *  name of the host's `searchDefaultMaxTokens`. */
export interface ToolsRowConfig {
  artifactStoreRoot: string
  knowledgeRemote: string
  /** The host plane declares the union on the interface and validates the scheme at
   *  link time (`providerKindFor`); the same shape here, so one `SchedulerConfig`
   *  contract covers both planes. */
  knowledgeProvider: 'auto' | 'git' | 'treedx'
  projectKeyOverride: string
  syncDebounceMs: number
  vocabApply: boolean
  vocabCoMin: number
  vocabOverlapMin: number
  harnessId: string
  chapterTokenTarget: number
  chapterLimit: number
  chapterOversizeFactor: number
  mergeThreshold: number
  toolResultDeferFloorTokens: number
  continuationBudgetRatio: number
  fallbackPreset: string
  warningsDisplayCap: number
  segmentCandidateCapTokens: number
  repairReportMaxLines: number
  planInlineChars: number
  callArgArtifactTokens: number
  plansInNotice: boolean
  retrievalHints: boolean
  planSeedMode: boolean
  searchMaxTokens: number
  coreRulesBudgetTokens: number
  rulesCoreBonus: number
  projectRulesDisplayCap: number
  sessionRulesDisplayCap: number
  rulesRelevance: boolean
}

export default class ChaptersToolsRow {
  static inject = ['agents', 'tools', 'llm', 'storageDomain', 'sessionProjections'] as const

  static Config = z.object({
    artifactStoreRoot: z.string().default('.dsh-chapters'),
    knowledgeRemote: z.string().default(''),
    knowledgeProvider: z.string().default('auto'),
    projectKeyOverride: z.string().default(''),
    syncDebounceMs: z.number().default(30000),
    vocabApply: z.boolean().default(false),
    vocabCoMin: z.number().default(3),
    vocabOverlapMin: z.number().default(0.5),
    harnessId: z.string().default(hostname()),
    chapterTokenTarget: z.number().default(8000),
    chapterLimit: z.number().default(8000),
    chapterOversizeFactor: z.number().default(2),
    mergeThreshold: z.number().default(0.3),
    toolResultDeferFloorTokens: z.number().default(200),
    continuationBudgetRatio: z.number().default(0.25),
    fallbackPreset: z.string().default('chapters'),
    warningsDisplayCap: z.number().default(6),
    segmentCandidateCapTokens: z.number().default(4000),
    repairReportMaxLines: z.number().default(60),
    planInlineChars: z.number().default(900),
    callArgArtifactTokens: z.number().default(0),
    plansInNotice: z.boolean().default(true),
    retrievalHints: z.boolean().default(true),
    planSeedMode: z.boolean().default(true),
    searchMaxTokens: z.number().default(400),
    coreRulesBudgetTokens: z.number().default(1200),
    rulesCoreBonus: z.number().default(0.15),
    projectRulesDisplayCap: z.number().default(12),
    sessionRulesDisplayCap: z.number().default(12),
    rulesRelevance: z.boolean().default(true),
  })

  ctx: RowCtx
  config: ToolsRowConfig

  constructor(ctx: RowCtx, config: ToolsRowConfig) {
    this.ctx = ctx
    this.config = config
  }

  /** Register, then hand Cordis the disposer — the tool/command registrations live and
   *  die with the mount (the preset row yields its registry disposer for the same
   *  reason; an `ctx.effect` on a fiber that finishes early would unregister the tools
   *  the instant they appeared). */
  async *[Service.init](): AsyncGenerator<() => void, void> {
    const sd = this.ctx.get?.('storageDomain') as
      | { open: (s: unknown) => Promise<unknown>; get?: (n: string) => unknown }
      | undefined
    if (sd === undefined) {
      // A realm without the storage facility cannot build a registry store. Say it
      // LOUDLY and mount nothing rather than half-registering tool definitions whose
      // every call would throw (a tool nobody can call is worse than an absent one).
      this.ctx.logger?.warn?.('dsh-chapters: chapters-tools row — storageDomain service absent, tools NOT mounted')
      return
    }
    const handle = await acquireChapterStore(sd as never)
    const { store, domain } = handle
    // The realm's own scheduler (§5): the same factory the host plane uses (one
    // scheduler shape, two planes), and the same discipline as the engine row's
    // `#scheduler()` — the file lock and debounce keep every instance honest.
    const scheduler = createScheduler(store, domain, this.config, undefined, undefined,
      (m) => this.ctx.logger?.warn?.(m))
    const toolsConfig: ToolsConfig = {
      ...this.config,
      scheduler,
      // The caller's routed model on every tool use, persisted through the SHARED
      // settings table — the realm's equivalent of the host plane's `noteRoute`
      // (#330 moved the doors in-realm; the manual `/chapters-enrich` resolver on the
      // host already falls back to `enrichment.route`, so the note still lands).
      noteRoute: (r: { provider: string, model: string }) => {
        void store.putSetting('enrichment.route', `${r.provider}/${r.model}`).catch(() => undefined)
      },
    }
    const dispose = registerChaptersTools(this.ctx as never, store, toolsConfig)
    this.ctx.logger?.info?.('dsh-chapters: chapters-tools row mounted — seven tools + three continuation doors, this realm only (#330)')
    // The store handle is NOT closed here: the storage facility owns domain teardown
    // (r35 — a close effect on this fiber closed the domain under later commands).
    yield dispose
  }
}
