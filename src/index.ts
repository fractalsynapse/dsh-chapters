/**
 * dsh-chapters — cordis entry point (host plane). The ONLY host-facing function
 * plugin; engine logic lives in engine.ts (mounted per preset realm), every
 * decision in the pure modules (docs/development.md § L0).
 *
 * Responsibilities:
 *  1. Make the `chapters` preset EXIST in the host's preset roster, and say loudly
 *     when it does not. Hosts before 0.2.0 are NOT supported: a preset is an
 *     `@deepseek-ai/dsh-agent-preset` declaration row, and this plugin registers
 *     that row at activation through the host's own `agentPresets.register()`
 *     (`src/preset.ts`). The old `$DSH_HOME/.agent-presets/` directory copy is
 *     gone — no 0.2.x host reads it, and shipping the row as a patch layer instead
 *     breaks the boot of every pre-0.1.7 host (measured; docs/contract.md).
 *  2. Open the dsh_chapters storage domain and register chapters_segment /
 *     chapters_continue (src/tools.ts adapts them to the pure core).
 *  3. Witness/dev diagnostics.
 *
 * Protocol notes (each measured, docs/contract.md):
 *  - function plugin: named exports `name` / `inject` / `Config` / `apply`;
 *    NO default export (mixing forms makes the Loader discard the namespace).
 *  - Config uses schemastery (default import) — plain specs are for tool
 *    parameters, zod for domain records; never mix.
 */
import { writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { appendChapters, reserve } from './registry.ts'
import { acquireChapterStore, makeDomainStore } from './store.ts'
import type { ChapterRecord } from './archive.ts'
import { registerChaptersTools } from './tools.ts'
import { CHAPTERS_PRESET_ID, inventoryEntry, unusableRows, type PresetRegistryLike } from './preset.ts'
import { registerHostCommands } from './commands.ts'
import { wireSubagentAutoSave } from './auto-save.ts'
import { createEnrichWiring } from './enrich-wire.ts'
import { ENRICH_MAX_TOKENS_DEFAULT } from './enrich.ts'
import { createPromptSurface, promptChaptersOf } from './prompt.ts'
import { rulesCommand, type RulesIo } from './rules-commands.ts'
import { ancestorSessionIds, captureMinedRules, makeHeaderParentReader, ruleAncestorSet } from './session-rules.ts'
import { configureDiagnostics, diagnosticStatusLine } from './diag.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createSyncScheduler, makeCollectionsReader, projectForCwd, readToken, DEFAULT_CLONE_DIR, type SyncScheduler } from './sync.ts'
import { parseKnowledgeRemote, projectKeyForTarget, resolveProject } from './repo.ts'
import { providerKindFor, registerProvider } from './provider.ts'
import { createTreedxProvider } from './treedx/provider.ts'

/** The cordis surface this entry touches; widened in later stages. */
interface HostCtx {
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  get?: (name: string) => unknown
  /** Cordis event subscription — door 5 registers the subagent-end listener here. */
  on?: (name: string, fn: (info: never) => void) => unknown
  effect?: (fn: () => void, label?: string) => void
  agents?: unknown
  tools?: { register(def: unknown): () => void }
  sessionProjections?: { stateOf(session: unknown, key: string): unknown }
  llm?: {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ context?: { contextWindow?: number } } | undefined>
    stream?: (opts: unknown) => AsyncIterable<unknown>
  }
}

export interface Config {
  /** @deprecated the preset is a declaration row now (`preset-chapters` in
   *  cordis.patch.yml); `disabled: true` on that row is the switch, and the engine
   *  threshold is `thresholdRatio` on its realm row. Accepted so an old profile patch
   *  keeps parsing — nothing reads it. */
  installChaptersPreset: boolean
  /** @deprecated see above; row config, not host config. */
  compactionThresholdRatio: number
  artifactStoreRoot: string
  chapterTokenTarget: number
  toolResultDeferFloorTokens: number
  continuationBudgetRatio: number
  fallbackPreset: string
  mergeThreshold: number
  /**
   * Door 5 (issue #47): archive a chapters-preset subagent's completed turns when
   * its run settles (`subagent/end`). Save-only — no session, no compaction,
   * enrichment queued never run. false = the listener never registers.
   */
  subagentAutoSave: boolean
  chapterLimit: number
  /** Past `chapterTokenTarget × this` a door refuses the archive (#59). ≥1; 2 by default. */
  chapterOversizeFactor: number
  /**
   * #61 loudness. How many warning TEXTS a door prints before switching to `…and M more`. The field
   * failure was delivery, not detection: 86 warnings — naming a hollow chapter and an unarchived
   * 0-4082 hole — reached a human as `(86 warning(s))`.
   */
  warningsDisplayCap: number
  /**
   * #61: token ceiling on the oversized-result candidate list `chapters_segment` returns. Measured at
   * 49,932 chars emitted while ALSO reporting `Omitted 275266 bytes`, ≈81K est tokens into a 32K-class
   * window — the model was asked to judge a list it never received.
   */
  segmentCandidateCapTokens: number
  /**
   * #61: where door/child failures are appended. Empty (the default) resolves to
   * `<store-root>/diagnostics.log`; the literal `off` disables the file sink, and
   * `DSH_CHAPTERS_ENGINE_ERRORS` overrides everything. Before this, unset meant NO TRACE ON DISK.
   */
  diagnosticsLog: string
  /** Plans (docs/plans-carriage.md § 7): verbatim plan chars shown in a chapter,
   * the tool-call-argument artifact floor (0 = off), and whether the notice
   * carries the `## Plans on this path` block. */
  planInlineChars: number
  callArgArtifactTokens: number
  plansInNotice: boolean
  /** Teach the child its lookup verbs (read / chapters_artifact / chapters_search). */
  retrievalHints: boolean
  /** Seed plan mode into continuation children (plans-carriage § 10). */
  planSeedMode: boolean
  /** Carry the operative plan into every in-place checkpoint (§ 9). */
  plansInCheckpoint: boolean
  planCheckpointChars: number
  harnessId: string
  /** §12: the project's knowledge repo URL ('' = rely on /chapters-link). */
  knowledgeRemote: string
  /** §12: wins over the §2.3 derivation. */
  projectKeyOverride: string
  /** §12: coalesce window for post-archive pushes. */
  syncDebounceMs: number
  /** §12: default pack size for chapters_search. */
  searchDefaultMaxTokens: number
  /** P2 §12: enrichment kill switch (auto triggers live on the realm plane;
   * the host plane's queue is manual-only so nothing ever double-runs). */
  enrichmentEnabled: boolean
  /** 'provider/model' or '' = conversation/stored route (record §6). */
  enrichmentModel: string
  enrichmentIdleMs: number
  /** One auxiliary completion budget: annotation+mining and the conflicts report.
   * Must cover reasoning tokens, not just the visible JSON (record §6.1, #50). */
  enrichmentMaxTokens: number
  enrichmentBatchCap: number
  /** P2 §6.3 vocabulary pass (shadow by default). */
  vocabApply: boolean
  vocabCoMin: number
  vocabOverlapMin: number
  /** P3 §7.3: budget for the notice's core-rules section (refuse, never clip). */
  coreRulesBudgetTokens: number
  /** P3 §8: search bonus for effective-core rules (per-machine status). */
  rulesCoreBonus: number
  /** #50 §7.5: deterministic `ADD RULE:` capture into the local session tier. */
  sessionRulesEnabled: boolean
  /** #50 §7.5: the capture marker, matched at line start of human messages. */
  rulesMarkerPrefix: string
  /** #50 §7.4: per-tier count caps on rules rendered into a rebuilt head. */
  projectRulesDisplayCap: number
  /** #50 §7.4: session-tier display cap. */
  sessionRulesDisplayCap: number
  /** #50 §7.4: topic-overlap selection on; off ⇒ deterministic category→id order. */
  rulesRelevance: boolean
  /** #50 §7.5: mine standing orders during enrichment. Default ON — background
   * capture is the whole point; the verbatim-quote gate (not a click) is what
   * keeps a guess from steering a session. */
  rulesEnrichment: boolean
  /** #50 §7.5: per-chapter cap on mined rules. */
  rulesMinedPerChapter: number
  /** #50 §7.5: mined rules govern on arrival (default true); false holds them for review. */
  rulesAutoActivate: boolean
  /** #50 §7.5: 'provider/model' for a dedicated mining call; '' ⇒ the annotation pass. */
  rulesModel: string
  /** #71 site §28: the model that DEFINES the next work. '' ⇒ the feature does
   * not exist; setting one (here or `/chapters-prompt model …`) IS the enable —
   * one knob, no second boolean that could drift against it. */
  promptModel: string
  /** #71: hard total budget on the assembled suggest input. */
  promptContextChars: number
  /** #71: cap on the recommendation itself; over-cap ⇒ retry once ⇒ refuse (never truncate). */
  promptMaxChars: number
  /** §15 amendment: transport policy — 'auto' dispatches on the remote
   * scheme (treedx+ → TreeDX, anything else → git); an explicit value must
   * match the scheme or the link refuses (never a silent fallback). */
  knowledgeProvider: 'auto' | 'git' | 'treedx'
  /** TreeDX transport tunables (record §12 register: no hardcoded numbers). */
  treedxFetchTimeoutMs: number
  treedxWorkspaceTtlSeconds: number
  treedxLeaseRetries: number
  treedxLeaseRetryDelayMs: number
  /** Optional CodeGraph integration: auto-detect the CLI on PATH and enrich
   *  signatures, search scoring, and enrichment input with structural code
   *  intelligence. The integration is invisible to the model — it makes
   *  chapters_search return better results, not a competing tool surface.
   *  false = hard off. */
  codegraphEnabled: boolean
  /** Add CodeGraph structural context to enrichment slices. */
  codegraphEnrich: boolean
  /** Per-symbol search score bonus for chapters with matching codegraphSymbols. */
  codegraphSearchBonus: number
}

export const Config = Schema.object({
  // The preset is how the engine reaches real sessions (preset realm mount);
  // turning this off means opting into manual preset authoring instead.
  // Accepted-then-ignored, deliberately: removing a key would make an old profile patch
  // fail to PARSE, and a bundle that will not mount is worse than a key that does nothing.
  installChaptersPreset: Schema.boolean().default(true),
  // The engine row of the registered preset (docs/host-compaction-seam.md). This is the
  // one row config that used to live in a preset YAML a human edited in the home; with
  // the row registered from code it belongs to THIS config, so a profile patch retunes it.
  compactionThresholdRatio: Schema.number().default(0.9),
  artifactStoreRoot: Schema.string().default('.dsh-chapters'),
  // #85: pool-mirror root for rules/knowledge reads that produce model-visible text.
  knowledgeMirrorDir: Schema.string().default('.dsh-knowledge'),
  // #87: the newest human turn carried verbatim into a relief summary, capped.
  openRequestCarryMaxChars: Schema.number().step(1).min(200).default(4000),
  // #78 A: survivability switch, default on (docs/host-compaction-seam.md).
  lastResortArtifact: Schema.boolean().default(true),
  chapterTokenTarget: Schema.number().default(8000),
  toolResultDeferFloorTokens: Schema.number().default(200),
  // Share of the window REMAINING after the header bound — never of the
  // whole window (docs/architecture.md § Budgets).
  continuationBudgetRatio: Schema.number().default(0.25),
  fallbackPreset: Schema.string().default('chapters'),
  // Topic-sequential composition (record §4.2) for the model-free fork path.
  mergeThreshold: Schema.number().default(0.3),
  subagentAutoSave: Schema.boolean().default(true),
  chapterLimit: Schema.number().default(8000),
  chapterOversizeFactor: Schema.number().default(2),
  warningsDisplayCap: Schema.number().default(6),
  segmentCandidateCapTokens: Schema.number().default(4000),
  diagnosticsLog: Schema.string().default(''),
  // Plans (docs/plans-carriage.md § 7). A plan's full text is ALWAYS
  // artifact-backed, so planInlineChars is display economy and never a data
  // decision. callArgArtifactTokens defaults to 0 = OFF: turning it on changes
  // chapter bytes for sessions with large tool-call arguments (a `write` call
  // carries a whole file), which means model tapes must be re-recorded — so a
  // deployment opts in deliberately rather than by accident.
  planInlineChars: Schema.number().default(900),
  callArgArtifactTokens: Schema.number().default(0),
  // Renders zero bytes when the path holds no plans, so the default-on cost for
  // sessions that never enter plan mode is exactly nothing.
  plansInNotice: Schema.boolean().default(true),
  retrievalHints: Schema.boolean().default(true),
  // Seeding is measured-safe (kernel accepts the two-event seed and the host's own
  // plan projection folds it to active) and it is what keeps the agent anchored to
  // the task across a continuation — so it ships ON, for continuations only.
  planSeedMode: Schema.boolean().default(true),
  plansInCheckpoint: Schema.boolean().default(true),
  planCheckpointChars: Schema.number().default(1600),
  // Per-machine identity for the knowledge repo (commit author + per-harness
  // token scoping, record §2.1). The hostname is the honest default; override
  // per machine when two sessions on one box must be told apart.
  harnessId: Schema.string().default(hostname()),
  // Knowledge repo (record §12): '' leaves linking to /chapters-link; a URL
  // auto-links every workspace on its first archive event.
  knowledgeRemote: Schema.string().default(''),
  projectKeyOverride: Schema.string().default(''),
  syncDebounceMs: Schema.number().default(30000),
  searchDefaultMaxTokens: Schema.number().default(400),
  enrichmentEnabled: Schema.boolean().default(true),
  enrichmentModel: Schema.string().default(''),
  enrichmentIdleMs: Schema.number().default(60000),
  enrichmentMaxTokens: Schema.number().default(ENRICH_MAX_TOKENS_DEFAULT),
  enrichmentBatchCap: Schema.number().default(5),
  vocabApply: Schema.boolean().default(false),
  vocabCoMin: Schema.number().default(3),
  vocabOverlapMin: Schema.number().default(0.5),
  coreRulesBudgetTokens: Schema.number().default(1200),
  rulesCoreBonus: Schema.number().default(0.15),
  // #50 §7.3–§7.5: the session tier + per-tier display caps. The three the
  // checkpoint also needs are mirrored into the engine row (docs/configuration).
  sessionRulesEnabled: Schema.boolean().default(true),
  rulesMarkerPrefix: Schema.string().default('ADD RULE:'),
  projectRulesDisplayCap: Schema.number().default(12),
  sessionRulesDisplayCap: Schema.number().default(12),
  rulesRelevance: Schema.boolean().default(true),
  rulesEnrichment: Schema.boolean().default(true),
  rulesMinedPerChapter: Schema.number().default(3),
  rulesAutoActivate: Schema.boolean().default(true),
  rulesModel: Schema.string().default(''),
  // #71 prompt recommendations: the model IS the switch (empty ⇒ off); the two
  // caps bound the auxiliary call's input slice and its answer. The completion
  // rides the existing enrichmentMaxTokens budget — one auxiliary budget, now
  // three consumers (annotation, mined rules, recommendations).
  promptModel: Schema.string().default(''),
  promptContextChars: Schema.number().default(4000),
  promptMaxChars: Schema.number().default(240),
  // enum-style string (same register as `fallbackPreset`): 'auto' | 'git' |
  // 'treedx', validated at use — schemastery has no literal schema.
  knowledgeProvider: Schema.string().default('auto'),
  treedxFetchTimeoutMs: Schema.number().default(15000),
  treedxWorkspaceTtlSeconds: Schema.number().default(900),
  treedxLeaseRetries: Schema.number().default(3),
  treedxLeaseRetryDelayMs: Schema.number().default(1000),
  // CodeGraph integration: auto-detect by default. The CLI is probed lazily
  // at first use; if absent, every integration point is a silent no-op.
  codegraphEnabled: Schema.boolean().default(true),
  codegraphEnrich: Schema.boolean().default(true),
  codegraphSearchBonus: Schema.number().default(0.2),
}) as Schema<Config>

export const name = '@treeseed/dsh-chapters'

export const inject = ['storageDomain', 'tools', 'agents', 'llm', 'sessionProjections']

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')

/** Registrations this module owns for the life of the process. The registry hands back an
 *  unregister disposer, and holding it — never calling it — is the point: a disposer wired
 *  through `ctx.effect` runs when the apply fiber's activation completes, which un-registered
 *  the preset the instant it had been registered (measured: `register()` reported success
 *  while the roster came back without `chapters`). The same apply-fiber trap bit the storage
 *  domain in r35. */
const heldDisposers: Array<() => Promise<void>> = []

export async function apply(ctx: HostCtx, config: Config): Promise<void> {
  // #61: the diagnostics sink defaults ON. An operator who set `diagnosticsLog` in the profile gets
  // that path; `DSH_CHAPTERS_ENGINE_ERRORS` beats it; the literal `off` is the only silence. With
  // neither set, the FIRST door that touches a project resolves `<store-root>/diagnostics.log`
  // (ensureDiagnosticsDefault in tools/engine), which is why nothing is configured here yet — the
  // three SAIP compaction finalization failures left no trace precisely because the sink had to be
  // turned on before it could help.
  if (config.diagnosticsLog !== '') configureDiagnostics(config.diagnosticsLog)

  // § Preset delivery lives in `src/preset.ts` — the `preset-chapters` declaration row in
  // this bundle's patch, NOT here. A row is visible (`dsh --dump-default-config`, the config
  // editor, `list_plugins`), overridable and disable-able from a profile patch, and its
  // registration's lifetime belongs to Cordis rather than to our `apply()` fiber. What stays
  // here is only the VERIFICATION: whether the roster ends up holding the preset at all
  // (below), because declaring it and having it usable are different facts.

  let domain: import('./store.ts').DomainLike | undefined
  try {
    const storageDomain = ctx.get?.('storageDomain') as
      { open: (s: unknown) => Promise<import('./store.ts').DomainLike>; get?: (n: string) => import('./store.ts').DomainLike | undefined } | undefined
    if (storageDomain === undefined) throw new Error('storageDomain absent')
    const handle = await acquireChapterStore(storageDomain)
    domain = handle.domain
    const store = handle.store
    // No close effect here: the facility's own disposer closes domains still
    // open at facility unmount (its documented teardown), and a close effect
    // on the apply fiber fires when THAT fiber is disposed — mid-run, which
    // closed the domain under later commands (r35 caught it). One opener, and
    // the closer is the facility's unmount, not our fiber.
    void handle.owner
    // §15 amendment: the TreeDX transport, configured and registered in THIS
    // module instance (host plane). The realm engine registers its own copy
    // (separate module instances under isolation) — same code, per-plane.
    registerProvider(createTreedxProvider({
      fetchTimeoutMs: config.treedxFetchTimeoutMs,
      workspaceTtlSeconds: config.treedxWorkspaceTtlSeconds,
      leaseRetries: config.treedxLeaseRetries,
      leaseRetryDelayMs: config.treedxLeaseRetryDelayMs,
    }))
    // P2: host-plane enrichment wiring — command surface + status only
    // (trigger forced manual; the realm engine owns auto drains).
    // The routed model of the last real tool-carrying session on this plane:
    // the host has no live agent, so without this a fork-only flow (never any
    // in-place compaction => realm never captures lastRoute) leaves
    // /chapters-enrich run with no route to call. Persisted immediately so
    // the realm's resolver sees it via the shared settings table too.
    let hostRoute: { provider: string, model: string } | null = null
    const enrich = createEnrichWiring({
      store,
      cwd: () => undefined,
      config: {
        enabled: config.enrichmentEnabled,
        model: config.enrichmentModel,
        trigger: 'manual',
        idleMs: config.enrichmentIdleMs,
        maxTokens: config.enrichmentMaxTokens,
        batchCap: config.enrichmentBatchCap,
        mineRules: config.rulesEnrichment,
        mineCap: config.rulesMinedPerChapter,
        rulesAutoActivate: config.rulesAutoActivate,
        rulesModel: config.rulesModel,
      },
      // §7.5 host-plane sink: `/chapters-enrich run` drains here, so a manual run
      // mines exactly like the realm's auto pass. Local files only — nothing is
      // armed on the scheduler, because session rules never travel (§7.5).
      onMinedRules: async ({ cwd, sessionId, chapterNumber, humanText, rules, max, autoActivate }) => {
        const res = captureMinedRules({
          storeDir: join(cwd, config.artifactStoreRoot),
          harnessId: config.harnessId,
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
      fetch: async (prompt, route) => {
        if (route === null) throw new Error('no enrichment route resolvable (set /chapters-enrich model … or run a turn first)')
        const llm = ctx.llm
        if (llm?.stream === undefined) throw new Error('llm.stream absent')
        const assembler = new BlockAssembler()
        for await (const chunk of llm.stream({
          provider: route.provider, model: route.model,
          messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-chapters' } })],
          maxTokens: config.enrichmentMaxTokens,
          purpose: 'compaction',
        })) assembler.push(chunk as never)
        return (assembler.blocks() as { type?: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      },
      conversationRoute: () => hostRoute,
      log: (m) => ctx.logger?.info?.(`dsh-chapters: ${m}`),
      warn: (m) => ctx.logger?.warn?.(`dsh-chapters: ${m}`),
    })
    // #71: prompt recommendations, host plane only (the web composer pulls;
    // headless sessions have no ghost and never pay the call). The route for a
    // bare model name rides the same last-seen route enrichment uses, with the
    // persisted route as fallback — a fork-only flow that never compacted in
    // place still has a provider to route through after one tool call.
    const prompt = createPromptSurface({
      getSetting: (k) => store.getSetting(k),
      putSetting: (k, v) => store.putSetting(k, v),
      deleteSetting: (k) => store.deleteSetting(k),
      chaptersOf: async (sessionId) => promptChaptersOf(await store.get(sessionId)),
      config: {
        model: config.promptModel,
        contextChars: config.promptContextChars,
        maxChars: config.promptMaxChars,
      },
      conversationRoute: () => {
        if (hostRoute !== null) return hostRoute
        const persisted = store.getSetting('enrichment.route') ?? ''
        const i = persisted.indexOf('/')
        return i > 0 ? { provider: persisted.slice(0, i), model: persisted.slice(i + 1) } : null
      },
      fetch: async (input, route) => {
        const llm = ctx.llm
        if (llm?.stream === undefined) throw new Error('llm.stream absent')
        const assembler = new BlockAssembler()
        for await (const chunk of llm.stream({
          provider: route.provider, model: route.model,
          messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'plugin', plugin: 'dsh-chapters' } })],
          maxTokens: config.enrichmentMaxTokens,
          purpose: 'compaction',
        })) assembler.push(chunk as never)
        return (assembler.blocks() as { type?: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      },
      warn: (m) => ctx.logger?.warn?.(`dsh-chapters: ${m}`),
    })
    const scheduler = createScheduler(store, domain, config, undefined, (cwd, ok) => {
      enrich.rememberCwd(cwd)
      if (ok) enrich.queue.onSyncDone('afterPush')
    }, (m) => ctx.logger?.warn?.(m))
    registerChaptersTools(ctx as never, store, {
      artifactStoreRoot: config.artifactStoreRoot,
      chapterTokenTarget: config.chapterTokenTarget,
      toolResultDeferFloorTokens: config.toolResultDeferFloorTokens,
      continuationBudgetRatio: config.continuationBudgetRatio,
      fallbackPreset: config.fallbackPreset,
      mergeThreshold: config.mergeThreshold,
      chapterLimit: config.chapterLimit,
      chapterOversizeFactor: config.chapterOversizeFactor,
      warningsDisplayCap: config.warningsDisplayCap,
      segmentCandidateCapTokens: config.segmentCandidateCapTokens,
      planInlineChars: config.planInlineChars,
      callArgArtifactTokens: config.callArgArtifactTokens,
      plansInNotice: config.plansInNotice,
      retrievalHints: config.retrievalHints,
      planSeedMode: config.planSeedMode,
      searchMaxTokens: config.searchDefaultMaxTokens,
      harnessId: config.harnessId,
      coreRulesBudgetTokens: config.coreRulesBudgetTokens,
      rulesCoreBonus: config.rulesCoreBonus,
      // #50 §7.4 — the doors read the HOST plane; the compaction checkpoint reads
      // the realm row (same names, same defaults). There is no cross-plane channel
      // to inject host config into a preset row, so a profile that overrides a cap
      // sets it in both places; leaving one unset keeps the documented default.
      projectRulesDisplayCap: config.projectRulesDisplayCap,
      sessionRulesDisplayCap: config.sessionRulesDisplayCap,
      rulesRelevance: config.rulesRelevance,
      scheduler,
      noteRoute: (r) => {
        hostRoute = r
        void store.putSetting('enrichment.route', `${r.provider}/${r.model}`).catch(() => undefined)
      },
      enrich,
    })
    registerHostCommands(ctx as never, domain, {
      artifactStoreRoot: config.artifactStoreRoot,
      subagentAutoSave: config.subagentAutoSave,
      harnessId: config.harnessId,
      projectKeyOverride: config.projectKeyOverride,
      scheduler,
      enrich,
      prompt,
      rules: (cwd, args, sessionId) => rulesCommand({
        cwd: () => cwd,
        storeRoot: config.artifactStoreRoot,
        harnessId: config.harnessId,
        store,
        projectFor: (c) => projectForCwd(store.projects(), c),
        mirrorDir: (c) => join(c, DEFAULT_CLONE_DIR),
        syncNow: async (c) => { try { await scheduler.run(c, 'rules') } catch { /* status file records it */ } },
        now: () => new Date(),
        // #50 §7.5: the session tier activates by ancestry, so the surface needs
        // the tree the caller is sitting on. No sessionId ⇒ `active` reports the
        // session tier UNRESOLVED rather than guessing an empty path.
        // #52: the SAME walk every door renders with — registry links plus the host
        // header's delegation edge — so `active` can never describe a view the head
        // will not show. One walk, memoized: two answers about one ancestry is how
        // a surface starts disagreeing with itself.
        ...(sessionId !== undefined ? (() => {
          const parentOf = makeHeaderParentReader((name) => { try { return ctx.get?.(name) } catch { return undefined } })
          let once: Promise<{ ancestors: Set<string>; truncated: boolean }> | null = null
          const walk = async () => {
            if (once === null) {
              once = ruleAncestorSet({
                seeds: [sessionId],
                registryAncestors: async (id) => await ancestorSessionIds(async (s) => await store.get(s), id),
                ...(parentOf !== undefined ? { parentOf } : {}),
              })
            }
            return await once
          }
          return {
            ancestors: async () => (await walk()).ancestors,
            ancestryTruncated: async () => (await walk()).truncated,
          }
        })() : {}),
        // §7.3/§7.4: the SAME numbers the doors render with, so `active` can never
        // describe a view the head will not show.
        budgetTokens: config.coreRulesBudgetTokens,
        projectCap: config.projectRulesDisplayCap,
        sessionCap: config.sessionRulesDisplayCap,
        // §7.5: the review surface reads the same activation posture the ladder uses
        // (so `active` can say whether mined rules govern on arrival), and `model`
        // sets a dedicated mining model through the shared settings table.
        autoActivate: config.rulesAutoActivate,
        settings: {
          get: (k) => store.getSetting(k),
          put: async (k, v) => { await store.putSetting(k, v) },
        },
        // §7.7: ONE bounded call, report-only, reusing the conversation route (and
        // therefore the conversation's own cached prefix). An explicit exception to
        // zero-inference in the elicitedPlot family — never a mutation.
        ask: async (prompt) => {
          const route = hostRoute
          if (route === null) throw new Error('no conversation route yet — run a turn first')
          const llm = ctx.llm
          if (llm?.stream === undefined) throw new Error('llm.stream absent')
          const assembler = new BlockAssembler()
          for await (const chunk of llm.stream({
            provider: route.provider, model: route.model,
            messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-chapters' } })],
            maxTokens: config.enrichmentMaxTokens,
            purpose: 'compaction',
          })) assembler.push(chunk as never)
          return (assembler.blocks() as { type?: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
        },
      } satisfies RulesIo, args),
    })

    // Door 5 (issue #47): the fifth archive moment — subagent settlement. The
    // host publishes `subagent/end` for every settled child run (one-shot AND
    // each residency epoch of a continuable child); the wiring reads the live
    // child synchronously (end strictly precedes disposal — measured, spike #47)
    // with a durable sessionQuery fallback, gates on the header the HOST stamps
    // (`origin: subagent`, `agentPreset`), and archives through the SAME
    // saveSession core as /chapters-save. Enrichment is never run per child.
    // Save-only: creates no session, so the "no continuation-creating actions
    // mid-step" rule is not engaged; a settled child's turns are all completed
    // by construction, and the anchor is its last `turn/end`.
    if (config.subagentAutoSave) {
      const autoSaveListener = wireSubagentAutoSave(ctx as never, store, {
        presetId: CHAPTERS_PRESET_ID,
        artifactStoreRoot: config.artifactStoreRoot,
        chapterTokenTarget: config.chapterTokenTarget,
        toolResultDeferFloorTokens: config.toolResultDeferFloorTokens,
        mergeThreshold: config.mergeThreshold,
        chapterLimit: config.chapterLimit,
        chapterOversizeFactor: config.chapterOversizeFactor,
        planInlineChars: config.planInlineChars,
        callArgArtifactTokens: config.callArgArtifactTokens,
        scheduler,
      })
      try {
        ctx.on?.('subagent/end', autoSaveListener as (info: never) => void)
        ctx.logger?.info?.('dsh-chapters: subagent auto-save armed — chapters-preset children archive at settlement (reported by /chapters-status)')
      } catch (error) {
        const message = `dsh-chapters: subagent auto-save registration REFUSED — settling subagents will NOT archive (${String((error as Error)?.message ?? error)})`
        ctx.logger?.warn?.(message)
        console.error(message)
      }
    }
  } catch (error) {
    // Tools are the whole user-facing surface short of the engine: a failure
    // here is loud, never a silently missing tool. Loud means the operator
    // actually sees it — the realm logger routes to boot stdout (r19/r35 twice
    // burned by a warn nobody could read; the DSH_CHAPTERS_ERRORS sink env is
    // the engine's precedent).
    const message = `dsh-chapters: tool/command registration FAILED (${String(error)})`
    ctx.logger?.warn?.(message)
    console.error(message)
  }

  // Honest status, because the settings surface reads "enabled and running" either way, and
  // "mounted" never meant "the preset exists". The row logs its own delivery line; this one
  // says what THIS plugin did, and the deferred roster check below says what the host has.
  const mountMsg = 'dsh-chapters: mounted (tools + commands registered; preset is the `preset-chapters` row)'
  ctx.logger?.info?.(mountMsg)

  // Optional CodeGraph integration: lazy probe at activation. The subprocess
  // service may not be mounted yet; resolveCodegraph caches the result so
  // subsequent calls are free. Failure → silent no-op at every integration point.
  if (config.codegraphEnabled !== false) {
    const subprocess = ctx.get?.('subprocess') as import('./codegraph.ts').SubprocessLike | undefined
    void import('./codegraph.ts').then(async (cg) => {
      const exe = await cg.resolveCodegraph(subprocess)
      ctx.logger?.info?.(`dsh-chapters: codegraph ${exe !== null ? 'found on PATH' : 'not found (integration inactive until installed)'}`)
    }).catch(() => { /* module load failure — integration stays off */ })
  }

  // File presence is NOT preset existence (§ Preset delivery): the roster is the only
  // evidence. It must be asked AFTER activation — the registry re-audits a mount by
  // awaiting the settled loader tree, and a caller "must not run inside a Host row's
  // own activation, which the settlement would wait on" — hence this deferred check,
  // which also catches a registration that mounted but could not activate. One check
  // per boot, reused by the dev witness.
  const marker = process.env.DSH_CHAPTERS_WITNESS
  let roster: Promise<RosterVerdict> | undefined
  const rosterCheck = (): Promise<RosterVerdict> =>
    roster ??= reportPresetRoster(ctx, config.fallbackPreset)
  setTimeout(() => {
    void rosterCheck().then((verdict) => {
      if (marker !== undefined) void witness(ctx, marker, domain, verdict)
    })
  }, 500).unref?.()
}

/**
 * The §5 sync loop for the host plane. Auto-link (when `knowledgeRemote` is
 * configured) happens lazily inside resolveProject: a workspace's first
 * archive event finds a project record, so nothing network-shaped runs
 * before anything archives.
 */
export function createScheduler(
  store: import('./store.ts').RegistryStore,
  domain: import('./store.ts').DomainLike,
  config: Config,
  debounceOverride?: number,
  onSyncDone?: (cwd: string, ok: boolean) => void,
  warn?: (m: string) => void,
): SyncScheduler {
  return createSyncScheduler({
    storeRoot: config.artifactStoreRoot,
    cloneDir: DEFAULT_CLONE_DIR,
    debounceMs: debounceOverride ?? config.syncDebounceMs,
    vocab: { apply: config.vocabApply, coMin: config.vocabCoMin, overlapMin: config.vocabOverlapMin },
    ...(onSyncDone !== undefined ? { onSyncDone } : {}),
    resolveProject: (cwd) => {
      const found = projectForCwd(store.projects(), cwd)
      if (found !== undefined) return found
      if (config.knowledgeRemote === '') return undefined
      try {
        const target = parseKnowledgeRemote(config.knowledgeRemote)
        const kind = providerKindFor(target.kind, config.knowledgeProvider)
        const resolved = resolveProject(cwd,
          config.projectKeyOverride !== '' ? config.projectKeyOverride : undefined,
          config.knowledgeRemote)
        const rec = {
          // Identity via projectKeyForTarget: §2.3 canonicalization, plus the
          // treedx/ namespace for TreeDX targets (keyed per-machine-stable by
          // construction — that is the whole point of §2.3). The override wins
          // exactly as before.
          projectKey: config.projectKeyOverride !== '' ? resolved.projectKey : projectKeyForTarget(target),
          slug: target.treedx?.repoName ?? (resolved.remote ?? config.knowledgeRemote).split('/').pop()!.replace(/\.git$/, ''),
          remote: config.knowledgeRemote,
          kind,
          harnessId: config.harnessId,
          linkedAt: new Date().toISOString(),
          cwd,
        }
        domain.table('projects').put(rec.projectKey, rec)
        return rec
      } catch (error) {
        // A policy contradiction (knowledgeProvider vs the remote scheme) is
        // LOUD in the log but never throws into the archive path (§5.3 shape).
        warn?.(`dsh-chapters: knowledgeRemote auto-link refused: ${String((error as Error)?.message ?? error)}`)
        return undefined
      }
    },
    tokenFor: (cwd, projectKey) => readToken(cwd, config.artifactStoreRoot, projectKey), // joins via resolveStoreRoot internally (#33)
    collectionsFor: makeCollectionsReader(store.sessions.bind(store), config.artifactStoreRoot),
  })
}

// ---------------------------------------------------------------- preset delivery

/**
 * Why delivery is a `register()` call and not a file, in one incident: hosts from
 * 0.1.7-alpha.1 stopped reading `$DSH_HOME/.agent-presets/` — a preset is an
 * `@deepseek-ai/dsh-agent-preset` declaration row — while the plugin kept copying,
 * kept logging that it had mounted, and the preset was simply GONE. That is worse
 * than a crash, because `resume` resolves the preset id recorded in the session's
 * own log and throws `agent-preset/not-found`, so every chapters session became
 * unopenable while its durable log sat there intact and uncorrupted.
 *
 * Shipping the row as a patch layer instead is what a reader will reach for, and it
 * is a boot-breaking choice on the hosts this plugin used to support: `dsh.bundle.patch`
 * as an array throws `ERR_INVALID_ARG_TYPE` at legacy `dsh-app-boot/lib/index.js:853`,
 * an unresolvable row aborts a legacy plugin tree, and `disabled: !!js` cannot gate the
 * row because the Loader evaluates `disabled` before any service is mounted (all three
 * measured). Support floor is 0.2.0 now, so the row is registered here through the
 * host's own `agentPresets.register()` — the same call its declaration-row plugin makes.
 */

/** What the host roster says about our preset. */
export type RosterVerdict =
  | { state: 'present'; broken?: string }
  | { state: 'absent'; rows: string[] }
  | { state: 'unknown'; error: string }

/** Ask the host which presets exist. Tolerates both shapes the service has
 *  offered: the bare row array (`list()`) and the remote envelope (`{presets}`). */
export async function readRosterVerdict(
  presets: { list?: () => Promise<unknown> } | undefined,
  presetId: string,
): Promise<RosterVerdict> {
  if (presets?.list === undefined) return { state: 'unknown', error: 'agentPresets service absent' }
  try {
    const raw = await presets.list()
    const rows = ((Array.isArray(raw) ? raw : (raw as { presets?: unknown[] } | undefined)?.presets) ?? []) as
      { id?: unknown; broken?: unknown }[]
    const mine = rows.find((r) => r?.id === presetId)
    if (mine === undefined) return { state: 'absent', rows: rows.map((r) => String(r?.id ?? '?')).sort() }
    const broken = mine.broken
    return typeof broken === 'string' && broken !== '' ? { state: 'present', broken } : { state: 'present' }
  } catch (error) {
    return { state: 'unknown', error: String((error as Error)?.message ?? error) }
  }
}

/**
 * The remedy for an absent preset. It is a configuration fact about someone else's tree —
 * a patch layer can be overridden or disabled by a profile we do not own — so the job is to
 * name where to look, never to retry behind the operator's back.
 */
export function rosterRemediation(presetId: string): string {
  return `the plugin ships "${presetId}" as the "preset-chapters" declaration row in its bundle patch `
    + '(cordis.patch.yml), which is a visible Loader entry: check that row in the plugin list, whether a '
    + 'profile patch disables or overrides it, and whether @treeseed/dsh-chapters is in this profile\u2019s '
    + 'dsh.profile.bundles at all. If the row is present but this line says absent, the host is below the '
    + '0.2.0 support floor and cannot register preset rows.'
}

/** Deferred boot check: one truthful line about the preset, plus the verdict for the witness.
 * Exported so the four arms of that line are tested without booting a host — the line IS the
 * health signal a user reads, and an untested health signal is how the silent case survived. */
export async function reportPresetRoster(
  ctx: HostCtx,
  presetId: string,
): Promise<RosterVerdict> {
  const presets = ctx.get?.('agentPresets') as PresetRegistryLike | undefined
  const verdict = await readRosterVerdict(presets, presetId)
  // The roster says a preset is DECLARED; the inventory says whether its rows are ACTIVE.
  // A row can resolve and still never start, and that is invisible on the roster — so the
  // one line the operator reads carries both facts.
  const mounted = verdict.state === 'present' ? ' — ' + await describeMountedRows(presets, presetId) : ''
  const line = (message: string, warn: boolean): void => {
    if (warn) {
      ctx.logger?.warn?.(message)
      console.error(message)
    } else ctx.logger?.info?.(message)
  }
  if (verdict.state === 'present' && verdict.broken === undefined) {
    line(`dsh-chapters: preset "${presetId}" is in the host roster${mounted} — chapter-form compaction and continuations will compose`, false)
  } else if (verdict.state === 'present') {
    line(`dsh-chapters: preset "${presetId}" is DECLARED BUT BROKEN — ${verdict.broken} — sessions choosing it will not compose. `
      + 'A preset row whose child plugin no longer resolves fails here; the plugin drops rows this host cannot import, '
      + `so this line means a package that resolves but will not activate — re-anchor the preset-chapters row against this host. Details: ${verdict.broken}`, true)
  } else if (verdict.state === 'absent') {
    line(`dsh-chapters: UNHEALTHY — preset "${presetId}" is NOT in the host roster (roster: ${verdict.rows.join(', ') || 'empty'}). `
      + `Every session whose log records it will refuse to open with agent-preset/not-found — the logs are intact; the composition is missing. `
      + `Remedy: ${rosterRemediation(presetId)}`, true)
  } else {
    line(`dsh-chapters: could not verify the preset roster (${verdict.error}) — treat chapter-form compaction as unconfirmed`, true)
  }
  return verdict
}

/** One phrase describing what the host's inventory says about the preset's own rows.
 *  Never throws: an unavailable inventory must degrade the line, not the boot check. */
export async function describeMountedRows(presets: PresetRegistryLike | undefined, presetId: string): Promise<string> {
  try {
    const raw = await presets?.compositionInventory?.()
    const entry = inventoryEntry(raw, presetId)
    if (entry === undefined) return 'rows not reported by this host'
    const bad = unusableRows(entry)
    const total = (entry.rows ?? []).length
    return bad.length === 0
      ? `${total} mounted rows all active`
      : `${bad.length} of ${total} rows NOT active (${bad.join('; ')})`
  } catch (error) {
    return `rows unreadable (${String((error as Error)?.message ?? error)})`
  }
}

// ---------------------------------------------------------------- dev witness

async function witness(
  ctx: HostCtx,
  marker: string,
  preopened?: import('./store.ts').DomainLike,
  roster?: RosterVerdict,
): Promise<void> {
  const WITNESS_SESSION = 'dsh-chapters-witness'
  const out: Record<string, unknown> = { at: new Date().toISOString() }
  try {
    out.storageDomainPresent = ctx.get?.('storageDomain') !== undefined
    out.diagnostics = diagnosticStatusLine()
    // What this host's preset mechanism IS, and what the roster says about the
    // chapters preset. These two lines are the difference between "the preset files
    // are installed" (true, and meaningless on a declaration-row host) and "the
    // preset exists" — the only thing a session cares about.
    out.registryRegisters = typeof (ctx.get?.('agentPresets') as PresetRegistryLike | undefined)?.register === 'function'
    out.presetRoster = roster?.state ?? 'not-checked'
    out.presetRosterLine = await describeMountedRows(ctx.get?.('agentPresets') as PresetRegistryLike | undefined, CHAPTERS_PRESET_ID)
    // The roster says a preset is declared; the inventory says whether its rows are
    // actually active. A row that resolves but will not activate leaves the preset on
    // the menu and unusable, and only this distinction names it.
    const invRaw = await (ctx.get?.('agentPresets') as PresetRegistryLike | undefined)?.compositionInventory?.()?.catch?.(() => undefined)
    const inv = inventoryEntry(invRaw, CHAPTERS_PRESET_ID)
    if (inv !== undefined) {
      out.presetInventoryRows = (inv.rows ?? []).length
      out.presetUnusableRows = unusableRows(inv)
      if (inv.broken !== undefined) out.presetInventoryBroken = inv.broken
    }
    if (roster?.state === 'absent') out.presetRosterRows = roster.rows
    if (roster?.state === 'present' && roster.broken !== undefined) out.presetRosterBroken = roster.broken
    if (roster?.state === 'unknown') out.presetRosterError = roster.error
    const storageDomain = ctx.get?.('storageDomain') as { open: (s: unknown) => Promise<import('./store.ts').DomainLike>; get?: (n: string) => import('./store.ts').DomainLike | undefined }
    const store = preopened !== undefined ? makeDomainStore(preopened) : (await acquireChapterStore(storageDomain!)).store
    const prior = await store.get(WITNESS_SESSION)
    out.priorChapters = prior.chapters.length
    if (prior.chapters.length === 0) {
      const reserved = reserve(prior, 'witness@1', 1)
      const record: ChapterRecord = {
        number: reserved.numbers[0] ?? 1,
        path: `.dsh-chapters/${WITNESS_SESSION}/chapters/001-witness.md`,
        title: 'witness', summary: `first boot ${new Date().toISOString()}`,
        startSeq: 0, endSeq: 0, topics: [], messages: 0, sha256: '0'.repeat(64), estimatedTokens: 0, artifacts: [],
      }
      await store.put(WITNESS_SESSION, appendChapters(reserved.state, [record]))
    } else {
      await store.put(WITNESS_SESSION, prior)
    }
    out.storedChapters = (await store.get(WITNESS_SESSION)).chapters.length
  } catch (error) {
    out.error = String(error)
  }
  writeFileSync(marker, JSON.stringify(out, null, 2))
}
