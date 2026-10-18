/**
 * chapters_segment / chapters_continue — tool adapters. Thin by policy: caller
 * resolution, port wiring, refusal mapping. The logic is continue-core.ts and
 * the pure modules; the shapes are the dsh-session-fork idiom (defineTool,
 * jsonOutput, exec.agent, ctx.tools.register), each cited in docs/contract.md.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { estimateTokens, renderChapter, toolResultCandidates } from './render.ts'
import {detectPlans, type PlanIntent} from './plans.ts'
import { buildRulesSection } from './rules.ts'
import { rulesCommand } from './rules-commands.ts'
import { DEFAULT_CLONE_DIR } from './sync.ts'
import type { ChapterRange, SessionEventLike, ToolResultOverride } from './types.ts'
import { composeChapters } from './compose.ts'
import { projectForCwd } from './sync.ts'
import { deriveRanges, refusalResult, runContinue, runFork, type BudgetProbe, type ContinueConfig, type ContinuePorts } from './continue-core.ts'
import { searchKnowledge, searchLocalStore } from './search.ts'
import { resolveArtifactPath, resolveArtifactWithMirror, buildToc, searchArtifact, readLines } from './artifact-query.ts'
import { makeArchiveFs, commitChapters, type DomainLike, type RegistryStore , resolveStoreRoot } from './store.ts'
import { reserve, reservePlan as reservePlanNumber, type SessionState } from './registry.ts'
import { writeArchive, attemptKey } from './archive.ts'
import { chapterTopics } from './signature.ts'

const jsonOutput = <T>(render: (value: T) => string) => ({
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: render(value as T) }],
})

/** The narrow slices of the host services the adapter uses (structural, cordis-free typing). */
export interface ToolsCtx {
  agents: {
    create(opts: Record<string, unknown>): Promise<{ agent: unknown; dispose?: () => Promise<void> | void }>
  }
  get?(name: string): unknown
  sessionProjections?: { stateOf(session: unknown, key: string): unknown }
  llm?: {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ context?: { contextWindow?: number } } | undefined>
  }
  tools: { register(def: unknown): () => void }
  logger?: { info?(m: string): void; warn?(m: string): void }
}

interface CallerAgent {
  session: {
    id: string
    header: { cwd?: string }
    snapshotEvents?(): SessionEventLike[]
    eventAt?(seq: number): SessionEventLike | undefined
  }
  options: { provider?: string; model?: string; reasoningEffort?: string }
}

const CALLER_MISSING = { ok: false as const, reason: 'no calling agent: this tool runs only inside an agent session' }

function callerOf(exec: ToolRunContext): CallerAgent | typeof CALLER_MISSING {
  const agent = (exec as unknown as { agent?: CallerAgent }).agent
  return agent ?? CALLER_MISSING
}

export interface ToolsConfig extends ContinueConfig {
  /** Token budget for chapters_search result packing (record §8). */
  searchMaxTokens?: number
  /** The §5 sync scheduler: pull at fork, debounced push after archives. */
  scheduler?: import('./sync.ts').SyncScheduler
  /** P3: identity + budget for per-machine rule rendering. Absent harnessId
   * => the rules section is never composed (off, no magic default). */
  harnessId?: string
  coreRulesBudgetTokens?: number
  /** P3 §8: search bonus for effective-core rules on this machine. */
  rulesCoreBonus?: number
  /** The caller's routed model on every tool use — feeds the enrichment
   * resolver. The host plane has no live agent of its own; without this a
   * fork-only flow (no in-place compaction ever) never captures a route and
   * /chapters-enrich run has nothing to call. */
  noteRoute?: (route: { provider: string, model: string }) => void
  /** P2 enrichment surface for /chapters-save: trigger an immediate drain
   * after archiving so saved chapters are enriched promptly. */
  enrich?: { runNow(cwd?: string): Promise<{ processed: number; remaining: number }> }
}

/** Build the two tool definitions (registration is the caller's lifecycle). */
/** The shape the host's command service takes — two doors share it. */
export interface HostCommand {
  name: string
  description: string
  input: { hint: string }
  handler: (invocation: { agent: unknown; rawInput?: string; signal?: AbortSignal }) => Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
}

export function buildChaptersTools(
  ctx: ToolsCtx,
  store: RegistryStore,
  config: ToolsConfig,
): { segment: ReturnType<typeof defineTool>; chaptersContinue: ReturnType<typeof defineTool>; chaptersFork: ReturnType<typeof defineTool>; chaptersSearch: ReturnType<typeof defineTool>; chaptersArtifact: ReturnType<typeof defineTool>; chaptersRulePropose: ReturnType<typeof defineTool>; forkCommand: HostCommand; continueCommand: HostCommand; saveCommand: HostCommand } {

  const portsFor = async (caller: CallerAgent): Promise<ContinuePorts> => {
    const cwd = caller.session.header.cwd ?? ''
    // every real tool use carries the caller's routed model — record it for
    // the enrichment resolver (the only route source the host plane can have)
    if (caller.options.provider !== undefined && caller.options.model !== undefined) {
      config.noteRoute?.({ provider: caller.options.provider, model: caller.options.model })
    }
    const presetId = (ctx.sessionProjections?.stateOf(caller.session, 'agentPreset') as string | undefined) ?? null
    return {
      readCallerEvents: async () => [...(caller.session.snapshotEvents?.() ?? [])] as SessionEventLike[],
      getState: (sessionId) => store.get(sessionId),
      putState: (sessionId, state) => store.put(sessionId, state),
      fs: () => {
        if (cwd === '') throw new Error('caller session has no workspace cwd — nowhere reachable for the read tool')
        return makeArchiveFs(cwd)
      },
      budgetProbe: async (): Promise<BudgetProbe> => {
        const { provider, model } = caller.options
        let windowTokens: number | null = null
        if (provider !== undefined && model !== undefined && ctx.llm?.resolveModelInfo !== undefined) {
          try {
            const info = await ctx.llm.resolveModelInfo(provider, model, new AbortController().signal)
            windowTokens = info?.context?.contextWindow ?? null
          } catch { windowTokens = null }
        }
        // Header bound: the last real request's full prompt (usage) — an
        // UPPER bound on header+surface-at-that-time, so it over-counts the
        // header conservatively; refusals err toward the loud side.
        let headerBoundTokens: number | null = null
        const events = caller.session.snapshotEvents?.() ?? []
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const usage = (events[i]!.data as { usage?: { inputTokens?: number; cacheReadTokens?: number } } | undefined)?.usage
          if (usage !== undefined) {
            headerBoundTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
            break
          }
        }
        return { windowTokens, headerBoundTokens }
      },
      newId: () => randomUUID(),
      createChild: async ({ sessionId, noticeEvent, modeEvents, presetId: mountPreset, title }) => {
        const callerOptions = caller.options
        // The seed is contiguous from seq 0: the notice, then any STATE events this
        // plugin authors for the child (plan mode). Invariant 2 holds — nothing from
        // the parent's log is copied; a seeded `plan/mode` is a synthetic fact about
        // the boundary, and the kernel's own setup events still append after it
        // (measured: notice@0 → plan/mode@1 → end-seed@2 → permission/sandbox/…).
        const handle = await ctx.agents.create({
          sessionId,
          seed: [noticeEvent, ...modeEvents],
          inheritedEventCount: 0,
          meta: { cwd, isSeeded: false, ...(mountPreset !== undefined && mountPreset !== null ? { agentPreset: mountPreset } : {}) },
          ...(callerOptions.provider !== undefined ? { agentOptions: callerOptions } : {}),
          setup: async (agentCtx: unknown) => {
            const presets = ctx.get?.('agentPresets') as { mount?: (c: unknown, id: string) => Promise<unknown> } | undefined
            if (presets?.mount === undefined) throw new Error('agentPresets service absent — the child would be tool-less')
            await presets.mount(agentCtx, mountPreset)
          },
        })
        try {
          const workspaceRegistry = ctx.get?.('workspaceRegistry') as { createCanonical?: (cwd: string) => Promise<{ attachSession?: (id: string) => Promise<void> | void } | undefined> } | undefined
          if (cwd !== '' && workspaceRegistry?.createCanonical !== undefined) {
            const workspace = await workspaceRegistry.createCanonical(cwd)
            await workspace?.attachSession?.(sessionId)
          }
        } catch (error) {
          // An unattached child is durable but may not list — say so, keep going.
          ctx.logger?.warn?.(`dsh-chapters: child workspace attach failed (${String(error)})`)
        }
        // Title while the child is still live: sessionController.rename resolves
        // the agent, routes through the official session-title normalizer, and
        // appends the durable `session/title` event (r6: commands-execute was the
        // wrong registry; the service method is the one that sticks). A refusal
        // here is cosmetic — warn, never roll back a durable continuation.
        try {
          const controller = ctx.get?.('sessionController') as
            { rename?: (r: { sessionId: string; title: string }) => Promise<unknown> } | undefined
          if (controller?.rename !== undefined) await controller.rename({ sessionId, title })
          else ctx.logger?.warn?.('dsh-chapters: sessionController absent — child created without a title')
        } catch (error) {
          ctx.logger?.warn?.(`dsh-chapters: child title refused (${String(error)}); child remains untitled`)
        } finally {
          // The live handle is ours only until the child is handed to the user:
          // holding it blocks their resume ("already owned by an active write
          // handle", measured r3). Dispose after the live-work, keep the session.
          await handle.dispose?.()
        }
      },
      now: () => Date.now(),
    }
  }

  // ---------------------------------------------------------------- segment

  const chaptersSegment = defineTool({
    name: 'chapters_segment',
    description:
      'Facts for planning a chapter archive of THIS session: the completed-turn archive ceiling, '
      + 'every tool result with its real size, and the chapters already in the registry. '
      + 'Returns ranges for you to propose in chapters_continue — you never write chapter text; the plugin renders it from the log.',
    parameters: {},
    output: jsonOutput((value: unknown) => JSON.stringify(value, null, 1)),
    async execute(_args: Record<string, never>, exec: ToolRunContext) {
      const caller = callerOf(exec)
      if ('reason' in caller) return { ...CALLER_MISSING }
      const events = caller.session.snapshotEvents?.() ?? []
      const lastTurnEnd = [...events].reverse().find((e) => e.type === 'turn/end')
      if (lastTurnEnd === undefined) return { ok: false, reason: 'no completed turn to archive yet' }
      const ceiling = lastTurnEnd.seq
      const below = events.filter((e) => e.seq <= ceiling)
      const callerState: SessionState = await store.get(caller.session.id)
      // Plans over the WHOLE log, with the ceiling as the archived/live split: a
      // submission below the ceiling can already hold its verdict above it (the
      // review is answered in the turn still open), and an approved plan must not
      // be re-reported as pending because the range filter hid the result
      // (docs/plans-carriage.md § 1).
      const planScan = detectPlans(events, { ceiling })
      const planRow = (p: (typeof planScan.plans)[number]) => ({
        seq: p.seq,
        title: p.title,
        status: p.status,
        resultSeq: p.resultSeq,
        bytes: p.bytes,
        estimatedTokens: estimateTokens(p.text),
        outline: p.outline,
        verdict: p.verdict === null ? null : p.verdict.slice(0, 200),
      })
      return {
        ok: true,
        archiveCeiling: ceiling,
        eventCount: below.length,
        // Plans this session submitted and their verdicts as the log states them.
        // Facts only — the model still chooses ranges, and the plugin renders the
        // text (invariant 4). A plan's artifact path appears in the chapter after
        // chapters_continue writes it, never promised here.
        plans: planScan.plans.filter((p) => p.archived).map(planRow),
        // Above the ceiling: an unfinished turn, so NOTHING can archive it yet and
        // no artifact exists. Say so plainly rather than let the child guess.
        livePlans: planScan.plans.filter((p) => !p.archived).map(planRow),
        modeActive: planScan.modeActive,
        ...(planScan.plans.length === 0
          ? {}
          : { planHint: 'a submitted plan is a topic boundary: the chapter that carries it ENDS there, and its title becomes the chapter title' }),
        // fresh literals, not the ToolResultCandidate interface: anonymous
        // object types carry the implicit index signature JsonValue needs.
        toolResults: toolResultCandidates(below, { title: '', summary: '', startSeq: 0, endSeq: ceiling })
          .map((c) => ({ seq: c.seq, toolName: c.toolName, bytes: c.bytes, estimatedTokens: c.estimatedTokens, excerpt: c.excerpt })),
        existingChapters: callerState.chapters.map((c) => ({
          number: c.number, path: c.path, title: c.title, startSeq: c.startSeq, endSeq: c.endSeq,
        })),
        budgetHint: { continuationBudgetRatio: config.continuationBudgetRatio, chapterTokenTarget: config.chapterTokenTarget },
      }
    },
  })

  // ---------------------------------------------------------------- continue

  const chaptersContinue = defineTool({
    name: 'chapters_continue',
    description:
      'Archive this conversation as verbatim Markdown chapters and open a NEW session that starts from their '
      + 'table of contents plus your handoff note. Supply event ranges (startSeq/endSeq) — never chapter text; '
      + 'the plugin renders bodies from the session log. This session is left untouched; the child gets its own '
      + 'cache and can reload any chapter with read. Oversized tool results defer to reference files by default; '
      + 'toolResultOverrides marks the exceptions you want kept inline (it still writes the artifact).',
    parameters: {
      title: { type: 'string', required: true, description: 'Name for the continued session.' },
      handoffNote: { type: 'string', required: true, description: 'State of play for the child: what was in progress, decisions held, the next step. Budget-checked as part of the notice, never silently truncated.' },
      chapters: {
        type: 'array',
        required: true,
        description: 'Ascending, non-overlapping ranges covering every event to archive (<= the archiveCeiling from chapters_segment).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'Chapter title (topic-named; it becomes the file slug).' },
            summary: { type: 'string', required: true, description: 'One-line TOC summary of what the chapter holds.' },
            startSeq: { type: 'integer', required: true, description: 'First durable event seq, inclusive.' },
            endSeq: { type: 'integer', required: true, description: 'Last durable event seq, inclusive.' },
          },
        },
      },
      toolResultOverrides: {
        type: 'array',
        description: 'Sparse exceptions to the defer-by-default rule: {seq, inline:true} keeps a large result inline in its chapter (the artifact is still written); {seq, inline:false} trims a small one.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            seq: { type: 'integer', required: true, description: 'The tool result event seq (from chapters_segment toolResults).' },
            inline: { type: 'boolean', required: true, description: 'Keep inline (true) or defer (false), overriding the size default for this one result.' },
          },
        },
      },
    },
    output: jsonOutput((value: unknown) => JSON.stringify(value, null, 1)),
    async execute(
      args: {
        title: string
        handoffNote: string
        chapters: ChapterRange[]
        toolResultOverrides?: ToolResultOverride[]
      },
      exec: ToolRunContext,
    ) {
      const caller = callerOf(exec)
      if ('reason' in caller) return { ...CALLER_MISSING }
      try {
        const ports = await portsFor(caller)
        const cwd = (caller.session as { header?: { cwd?: string } }).header?.cwd ?? ''
        if (cwd !== '' && config.scheduler !== undefined) {
          await config.scheduler.pullFor(cwd).catch(() => undefined) // §5.1: pull → archive → push
        }
        const line = projectLineFor(caller)
        const rs = rulesSectionFor(caller)
        if (rs.refusal !== undefined) return { ok: false as const, reason: rs.refusal }
        const result = await runContinue(ports, {
          callerSessionId: caller.session.id,
          callerPreset: (ctx.sessionProjections?.stateOf(caller.session, 'agentPreset') as string | null | undefined) ?? null,
          title: args.title,
          handoffNote: args.handoffNote,
          chapters: args.chapters,
          toolResultOverrides: args.toolResultOverrides ?? [],
          ...(line !== undefined ? { projectLine: line } : {}),
          ...(rs.section !== undefined ? { rulesSection: rs.section } : {}),
        }, config)
        if (result.ok && cwd !== '') config.scheduler?.schedule(cwd, 'archive:continue')
        // conditional spreads: absent optionals must not surface as `undefined`
        // (not a JsonValue); the output schema validates the successful body.
        return {
          ok: true as const,
          ...(result.childSessionId !== undefined ? { childSessionId: result.childSessionId } : {}),
          ...(result.presetUsed !== undefined ? { presetUsed: result.presetUsed } : {}),
          ...(result.chapters !== undefined ? { chapters: result.chapters } : {}),
          ...(result.warnings !== undefined && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
          ...(result.budget !== undefined ? { budget: result.budget } : {}),
        }
      } catch (error) {
        const refusal = refusalResult(error)
        if (refusal !== null) {
          return {
            ok: false as const,
            reason: refusal.reason ?? 'refused',
            ...(refusal.budget !== undefined ? { budget: refusal.budget } : {}),
            ...(refusal.warnings !== undefined && refusal.warnings.length > 0 ? { warnings: refusal.warnings } : {}),
          }
        }
        return { ok: false, reason: `chapters_continue failed: ${(error as Error)?.stack ?? String(error)}`.slice(0, 800) }
      }
    },
  })

  // ---------------------------------------------------------------- fork

  const chaptersFork = defineTool({
    name: 'chapters_fork',
    description:
      'Open a SIBLING session citing the same chapter archive this one already has — nothing new is '
      + 'archived, no files written, no numbers spent. Use for trying a genuinely different approach '
      + 'while the current session keeps working. Your handoff note says what the sibling should do.',
    parameters: {
      title: { type: 'string', required: true, description: 'Name for the forked session.' },
      handoffNote: { type: 'string', required: true, description: 'What the sibling is for — its whole context is the archive TOC plus this note.' },
    },
    output: jsonOutput((value: unknown) => JSON.stringify(value, null, 1)),
    async execute(args: { title: string; handoffNote: string }, exec: ToolRunContext) {
      const caller = callerOf(exec)
      if ('reason' in caller) return { ...CALLER_MISSING }
      try {
        const ports = await portsFor(caller)
        const cwd = (caller.session as { header?: { cwd?: string } }).header?.cwd ?? ''
        if (cwd !== '' && config.scheduler !== undefined) {
          await config.scheduler.pullFor(cwd).catch(() => undefined)
        }
        const line = projectLineFor(caller)
        const rs = rulesSectionFor(caller)
        if (rs.refusal !== undefined) return { ok: false as const, reason: rs.refusal }
        const result = await runFork(ports, {
          callerSessionId: caller.session.id,
          callerPreset: (ctx.sessionProjections?.stateOf(caller.session, 'agentPreset') as string | null | undefined) ?? null,
          title: args.title,
          handoffNote: args.handoffNote,
          // A branch splits a NEW direction off the history: plans are cited, not
          // re-asserted, and plan mode is not inherited (decision 2026-10-10).
          intent: 'branch',
          ...(line !== undefined ? { projectLine: line } : {}),
          ...(rs.section !== undefined ? { rulesSection: rs.section } : {}),
        }, config)
        if (result.ok && cwd !== '') config.scheduler?.schedule(cwd, 'archive:fork')
        return {
          ok: true as const,
          ...(result.childSessionId !== undefined ? { childSessionId: result.childSessionId } : {}),
          ...(result.presetUsed !== undefined ? { presetUsed: result.presetUsed } : {}),
          ...(result.budget !== undefined ? { budget: result.budget } : {}),
        }
      } catch (error) {
        const refusal = refusalResult(error)
        if (refusal !== null) {
          return { ok: false as const, reason: refusal.reason ?? 'refused', ...(refusal.budget !== undefined ? { budget: refusal.budget } : {}) }
        }
        return { ok: false as const, reason: `chapters_fork failed: ${(error as Error)?.stack ?? String(error)}`.slice(0, 800) }
      }
    },
  })


  // ---------------------------------------------------------------- command

  // The palette/URL path for the fork BUTTON: same ports as the tools, ZERO
  // model involvement — deriveRanges is deterministic, so a click needs no
  // agent turn and no proposed ranges. `/chapters-fork [title]`: everything
  // up to the last completed turn is archived verbatim and a titled child
  // opens whose entire history is the cumulative TOC.
  /**
   * THE DETERMINISTIC DOOR (docs/plans-carriage.md § 15). A child can be created two
   * ways: the model calls `chapters_continue` (which needs it to chain segment→continue
   * and to author ranges — measured non-reliable on a small local model, attempt 5), or a
   * HUMAN pulls this lever and the plugin derives everything itself. `deriveRanges` and
   * `composeChapters` are deterministic, so a command needs no agent turn and no proposed
   * ranges — and crucially it freezes no machine-specific numbers into a tape, which is
   * what made the browser plane unable to cover continuations at all.
   *
   * One builder, two specs: `/chapters-fork` SPLITS the work (`intent: 'branch'` ⇒ the
   * child gets zero plan bytes) and `/chapters-continue` EXTENDS it (`intent: 'continue'`
   * ⇒ `## Active plan` and, while the session is still planning, the seeded `plan/mode`).
   * Archive semantics are identical by user decision: everything since the watermark.
   * Copy-pasting this body would be how the two doors drift apart; they cannot now.
   */
  interface DeterministicDoor {
    name: string
    intent: PlanIntent
    /** Words for the default title, the handoff note and the success text. */
    noun: string
    verb: string
    /** The task the child is handed when no plan carries one. */
    noDirective: string
  }

  const deterministicCommand = (door: DeterministicDoor) => ({
    name: door.name,
    description: door.intent === 'branch'
      ? 'Fork this conversation into a new session: archive everything so far into verbatim chapters and open a child whose history is the table of contents. Optional argument: a title for the branch.'
      : 'Continue this conversation in a new session: archive everything so far into verbatim chapters and open a child that carries the same stream of work — its notice names the operative plan, if one is still standing. Optional argument: a title for the continuation.',
    input: { hint: '[title]' },
    async handler(invocation: { agent: unknown; rawInput?: string; signal?: AbortSignal }): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }> {
      const agent = invocation.agent as CallerAgent
      if (agent?.session === undefined) return { kind: 'error' as const, text: `${door.name}: no session context for this invocation` }
      try {
        const ports = await portsFor(agent)
        const cwd0 = (agent.session as { header?: { cwd?: string } }).header?.cwd ?? ''
        if (cwd0 !== '' && config.scheduler !== undefined) {
          await config.scheduler.pullFor(cwd0).catch(() => undefined)
        }
        const events = await ports.readCallerEvents()
        const anchor = [...events].reverse().find((e) => e.type === 'turn/end')?.seq
        if (anchor === undefined) return { kind: 'error' as const, text: `${door.name}: nothing to archive yet — the conversation has no completed turn` }
        const trimmed = (invocation.rawInput ?? '').trim()
        const parentTitle = [...events].reverse()
          .find((e) => e.type === 'session/title')?.data?.title as string | undefined
        const title = trimmed !== '' ? trimmed : `${parentTitle ?? `Chapters ${door.noun}`} \u2014 ${door.noun}`
        const rsCmd = rulesSectionFor(agent)
        if (rsCmd.refusal !== undefined) return { kind: 'error' as const, text: `${door.name} refused: ${rsCmd.refusal}` }
        const callerArgs = {
          callerSessionId: agent.session.id,
          callerPreset: (ctx.sessionProjections?.stateOf(agent.session, 'agentPreset') as string | null | undefined) ?? null,
          title,
          // THE intent, and the only place it is chosen for a human-pulled door.
          intent: door.intent,
          toolResultOverrides: [],
          ...(projectLineFor(agent) !== undefined ? { projectLine: projectLineFor(agent) as string } : {}),
          ...(rsCmd.section !== undefined ? { rulesSection: rsCmd.section } : {}),
        }
        // Archive watermark: compaction chapters (and prior forks) already carry
        // [.. lastArchived]. This segments ONLY what is newer — the store stays
        // append-only AND duplicate-free, and the child's TOC inherits every earlier
        // chapter through the ancestry walk. When nothing is newer, this degrades to a
        // pure citation fork: child created, archive cited, nothing written.
        const parentState = await ports.getState(agent.session.id)
        const lastArchived = parentState.chapters.reduce((m, c) => Math.max(m, c.endSeq), 0)
        const fromSeq = lastArchived > 0 ? lastArchived + 1 : 0
        if (fromSeq > 0 && anchor <= lastArchived) {
          const forked = await runFork(ports, { ...callerArgs, handoffNote: `Archived through the Chapters ${door.noun}. Nothing had been said since the last archive, so this ${door.noun} cites the existing chapters unchanged. ${door.noDirective}` }, config)
          if (cwd0 !== '') config.scheduler?.schedule(cwd0, 'archive:fork-cite')
          return { kind: 'success' as const, text: `${door.verb} (nothing new to archive): ${door.noun} \u201C${title}\u201D is session ${forked.childSessionId ?? '(created)'} citing ${parentState.chapters.length} existing chapter(s). Switch from the sidebar.` }
        }
        // Topic-sequential composition (record §4.2): merge adjacent same-task
        // collections from the stored per-turn signatures. No signatures yet (a session
        // that predates the feature) → the legacy size-based segmentation, which is
        // exactly what deriveRanges is.
        const composed = composeChapters(events, fromSeq, anchor, parentState.collections, {
          mergeThreshold: config.mergeThreshold,
          chapterLimit: config.chapterLimit,
        })
        const chapters = composed.chapters.length > 0
          ? composed.chapters
          : deriveRanges(events, anchor, config.chapterTokenTarget, fromSeq).chapters
        const notes = composed.chapters.length > 0
          ? composed.notes
          : ['no stored turn signatures — legacy size-based segmentation']
        const handoffNote = `Archived through the Chapters ${door.noun}. The chapters listed above carry every prior word verbatim — reload any with the read tool on its path. ${door.noDirective}`
          + (notes.length > 0 ? `\n(Segmentation notes: ${notes.join('; ')})` : '')
        const result = await runContinue(ports, { ...callerArgs, handoffNote, chapters }, config)
        if (result.ok && cwd0 !== '') config.scheduler?.schedule(cwd0, 'archive:fork')
        const budgetText = result.budget !== undefined ? `; TOC ~${result.budget.usedTokens} tokens, allowance ${result.budget.allowanceTokens}` : ''
        return { kind: 'success' as const, text: `${door.verb}: ${chapters.length} new chapter(s) archived (watermark respected: seqs ${fromSeq}..${anchor}), ${door.noun} \u201C${title}\u201D is session ${result.childSessionId ?? '(created)'}${budgetText}. Switch to it from the sidebar — its first message is the table of contents.` }
      } catch (error) {
        const refusal = refusalResult(error)
        if (refusal !== null) {
          const budget = refusal.budget !== undefined ? ` (notice ~${refusal.budget.usedTokens} > allowance ${refusal.budget.allowanceTokens})` : ''
          return { kind: 'error' as const, text: `${door.name} refused: ${refusal.reason ?? 'refused'}${budget}` }
        }
        return { kind: 'error' as const, text: `${door.name} failed: ${String((error as Error)?.message ?? error)}`.slice(0, 500) }
      }
    },
  })

  const forkCommand = deterministicCommand({
    name: 'chapters-fork',
    intent: 'branch',
    noun: 'branch',
    verb: 'Forked',
    // A branch SPLITS the work (decision 3): it inherits history, not an order.
    noDirective: 'No task was handed over with this fork: ask the user what this branch should work on.',
  })

  const continueCommand = deterministicCommand({
    name: 'chapters-continue',
    intent: 'continue',
    noun: 'continuation',
    verb: 'Continued',
    // A continuation EXTENDS the same stream. When a plan is operative the notice already
    // carries it as a directive, so this line only speaks for the plan-less case.
    noDirective: 'If the notice above names an active plan, that is your directive — read its full text before implementing and do NOT re-plan from recall. Otherwise ask the user what to carry on with.',
  })

  // ------------------------------------------------- /chapters-save (archive without child)

  /**
   * Archive-only door: same pipeline as fork/continue (composeChapters + writeArchive)
   * but stops before agents.create. Writes chapters to disk, commits records to the
   * session state (so search picks them up), and triggers enrichment. No child session,
   * no compaction, no disruption to the active conversation.
   */
  const saveCommand: HostCommand = {
    name: 'chapters-save',
    description: 'Save completed turns as searchable chapters without creating a new session. Archives verbatim, updates the search index, and triggers enrichment. Idempotent — re-running saves only what has not yet been archived.',
    input: { hint: '[title]' },
    async handler(invocation: { agent: unknown; rawInput?: string; signal?: AbortSignal }): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }> {
      const agent = invocation.agent as CallerAgent
      if (agent?.session === undefined) return { kind: 'error' as const, text: 'chapters-save: no session context for this invocation' }
      try {
        const ports = await portsFor(agent)
        const cwd0 = (agent.session as { header?: { cwd?: string } }).header?.cwd ?? ''
        const events = await ports.readCallerEvents()
        const anchor = [...events].reverse().find((e) => e.type === 'turn/end')?.seq
        if (anchor === undefined) return { kind: 'error' as const, text: 'chapters-save: nothing to save yet — the conversation has no completed turn' }

        // Watermark: only archive what is newer than the last saved chapter.
        const parentState = await ports.getState(agent.session.id)
        const lastArchived = parentState.chapters.reduce((m, c) => Math.max(m, c.endSeq), 0)
        const fromSeq = lastArchived > 0 ? lastArchived + 1 : 0
        if (fromSeq > 0 && anchor <= lastArchived) {
          return { kind: 'success' as const, text: `Nothing to save: all ${parentState.chapters.length} chapter(s) already archived through seq ${lastArchived}. Content is searchable via chapters_search.` }
        }

        // Topic-sequential composition — same pipeline as fork/continue.
        const composed = composeChapters(events, fromSeq, anchor, parentState.collections, {
          mergeThreshold: config.mergeThreshold,
          chapterLimit: config.chapterLimit,
        })
        const chapters = composed.chapters.length > 0
          ? composed.chapters
          : deriveRanges(events, anchor, config.chapterTokenTarget, fromSeq).chapters

        // Render + write archive (same as runContinue steps 2-3, minus child creation).
        const below = events.filter((e) => e.seq <= anchor)
        const renderConfig = {
          toolResultDeferFloorTokens: config.toolResultDeferFloorTokens,
          chapterTokenTarget: config.chapterTokenTarget,
          ...(config.planInlineChars !== undefined ? { planInlineChars: config.planInlineChars } : {}),
          ...(config.callArgArtifactTokens !== undefined ? { callArgArtifactTokens: config.callArgArtifactTokens } : {}),
        }
        const rendered = chapters.map((range) => renderChapter(below, range, renderConfig, [], chapterTopics(below, range.startSeq, range.endSeq)))
        const fsPort = ports.fs()
        const wrote = await writeArchive({
          fs: fsPort,
          allocator: {
            async reserve(attemptId, count) {
              const fresh = await ports.getState(agent.session.id)
              const r = reserve(fresh, attemptId, count)
              await ports.putState(agent.session.id, r.state)
              return r.numbers
            },
            async reservePlan(attemptId, count) {
              const fresh = await ports.getState(agent.session.id)
              const r = reservePlanNumber(fresh, attemptId, count)
              await ports.putState(agent.session.id, r.state)
              return r.numbers
            },
          },
          // raw value: makeArchiveFs roots RELATIVE paths at the session cwd and
          // passes absolute ones through — resolving here would double-root relative stores
          storeRoot: config.artifactStoreRoot,
          rootSessionId: parentState.rootSession,
          chapters: rendered,
          attemptId: attemptKey(agent.session.id, anchor),
        })

        // Commit chapter records to session state so search index picks them up.
        await commitChapters(store, agent.session.id, wrote.records)

        // Schedule enrichment asynchronously — do NOT await. Enrichment calls
        // the LLM per chapter and can exceed the command timeout. The idle and
        // afterPush triggers will pick up any remaining work.
        if (config.enrich !== undefined) {
          void config.enrich.runNow(cwd0 || undefined).catch(() => undefined)
        }

        // Schedule sync so saved chapters travel to the pool.
        if (cwd0 !== '') config.scheduler?.schedule(cwd0, 'archive:save')

        const warnings = wrote.warnings.length > 0 ? ` (${wrote.warnings.length} warning(s))` : ''
        return { kind: 'success' as const, text: `Saved: ${wrote.records.length} chapter(s) archived (seqs ${fromSeq}..${anchor})${warnings}. Enrichment queued. Content is searchable via chapters_search from any session in this workspace.` }
      } catch (error) {
        return { kind: 'error' as const, text: `chapters-save failed: ${String((error as Error)?.message ?? error)}`.slice(0, 500) }
      }
    },
  }

  // ------------------------------------------------- knowledge project line

  // The notice carries the knowledge-project line (record §8) when a project
  // is linked for this workspace: the deepest project record whose recorded
  // cwd is a prefix of the caller's cwd.
  const projectLineFor = (agent: CallerAgent): string | undefined => {
    try {
      const cwd: string = (agent.session as { header?: { cwd?: string } }).header?.cwd ?? ''
      const best = projectForCwd(store.projects(), cwd)
      if (best === undefined) return undefined
      return `Project: ${best.slug} \u00B7 ${best.projectKey}\nSearch past work with chapters_search (topic or keyword query; paths open with the read tool).`
    } catch {
      return undefined
    }
  }

  /** P3 §7.3: this machine's rules block for a continuation notice. */
  const rulesSectionFor = (agent: CallerAgent): { section?: string; refusal?: string } => {
    try {
      if (config.harnessId === undefined || config.coreRulesBudgetTokens === undefined) return {}
      const cwd: string = (agent.session as { header?: { cwd?: string } }).header?.cwd ?? ''
      const best = projectForCwd(store.projects(), cwd)
      if (best === undefined) return {}
      const built = buildRulesSection(path.join(cwd, DEFAULT_CLONE_DIR), {
        projectKey: best.projectKey, harnessId: config.harnessId, budgetTokens: config.coreRulesBudgetTokens,
      })
      if (built.kind === 'none') return {}
      if (built.kind === 'refusal') {
        const per = built.perRule.map((r) => `${r.id}=${r.tokens}`).join(', ')
        return { refusal: `core rules overflow their budget (${built.total} tokens > cap ${built.cap}; per rule: ${per}). Revoke or shrink with /chapters-rule — the notice never clips.` }
      }
      return { section: built.text }
    } catch {
      return {} // rules are additive; a broken mirror must not break continuation
    }
  }

  // ------------------------------------------------- knowledge search

  // The mirror (clone) is the corpus: it holds local + pulled files, so
  // searching it is searching the whole knowledge pool for this project.
  const chaptersSearch = defineTool({
    name: 'chapters_search',
    description:
      'Search this project\u2019s chapter knowledge pool (past sessions, indexed by topic/title/summary). '
      + 'Pass a topic or keyword query; raise maxTokens to see more of the ranked list. Results are file paths readable with the read tool.',
    parameters: {
      query: { type: 'string', required: true, description: 'Topic or keyword query.' },
      maxTokens: { type: 'number', description: 'Token budget for the result list (default 400; raise to page deeper).' },
    },
    output: jsonOutput((value: unknown) => JSON.stringify(value, null, 1)),
    async execute(args: { query: string; maxTokens?: number }, exec: ToolRunContext) {
      const caller = callerOf(exec)
      if ('reason' in caller) return { ...CALLER_MISSING }
      const cwd = (caller.session as { header?: { cwd?: string } }).header?.cwd ?? ''
      // Typed once rather than spread from a conditional: the union of `{…} | {}` is
      // not spreadable under this tsconfig, and the alternative was casting blind.
      const localOpts = (): { rulesCoreBonus?: number } =>
        config.rulesCoreBonus !== undefined ? { rulesCoreBonus: config.rulesCoreBonus } : {}
      const cloneDir = path.join(cwd, DEFAULT_CLONE_DIR)
      const budget = args.maxTokens ?? config.searchMaxTokens ?? 400
      // Two doors, one scorer. The pool mirror when a project is linked; the workspace
      // store when it is not — because the chapters, `kind: plan` documents and rules
      // are ALREADY here, and "link a remote first" is not an answer to a question a
      // local archive can reply to. Which door answered is stated in `note`, so a
      // session never mistakes "this machine only" for "the whole project".
      // "not linked" and "linked but not pulled yet" are different situations with
      // different fixes; one note for both would send a session to link a project it
      // already linked (measured: the pinned row for exactly that case). The door is
      // named on EVERY branch, including the empty store — a session cannot tell
      // "nothing here" from "I did not look here" without it.
      const doorTail = (): string => {
        let linked = false
        try { linked = projectForCwd(store.projects(), cwd) !== undefined } catch { linked = false }
        return linked
          ? 'linked project has no pool mirror on disk yet — the sync loop pulls it; /chapters-status shows the last sync'
          : 'no pool mirror — link one with /chapters-link to reach other machines\u2019 work'
      }
      const localNote = (n: number): string => `searched this machine's store (${String(n)} indexed document(s); ${doorTail()})`
      if (!fs.existsSync(cloneDir)) {
        const local = searchLocalStore(resolveStoreRoot(cwd, config.artifactStoreRoot), args.query, budget, localOpts())
        return {
          ok: true as const,
          results: local.results.map((r) => ({ score: r.score, date: r.date, kind: r.kind, title: r.title, path: r.path, topics: r.topics })),
          total: local.total,
          shown: local.shown,
          line: local.line,
          budget: local.budget,
          ...(local.results.length > 0 ? { note: localNote(local.documents) } : { note: `nothing archived in this workspace yet — nothing to search (${String(local.documents)} indexed documents; ${doorTail()})` }),
        }
      }
      const outcome = searchKnowledge(cloneDir, args.query, budget, {
        ...(config.harnessId !== undefined ? { harnessId: config.harnessId } : {}),
        ...(config.rulesCoreBonus !== undefined ? { rulesCoreBonus: config.rulesCoreBonus } : {}),
      })
      if (outcome.results.length === 0) {
        const local = searchLocalStore(resolveStoreRoot(cwd, config.artifactStoreRoot), args.query, budget, localOpts())
        if (local.results.length > 0) {
          return {
            ok: true as const,
            results: local.results.map((r) => ({ score: r.score, date: r.date, kind: r.kind, title: r.title, path: r.path, topics: r.topics })),
            total: local.total,
            shown: local.shown,
            line: local.line,
            budget: local.budget,
            note: `no pool match; found ${String(local.results.length)} in this machine's store`,
          }
        }
      }
      return {
        ok: true as const,
        results: outcome.results.map((r) => ({ score: r.score, date: r.date, kind: r.kind, title: r.title, path: r.path, topics: r.topics })),
        total: outcome.total,
        shown: outcome.shown,
        budget: { requested: outcome.budget.requested, used: outcome.budget.used, remaining: outcome.budget.remaining },
        ...(outcome.total > outcome.shown ? { note: `showing ${outcome.shown} of ${outcome.total} within ${outcome.budget.requested} tokens — raise maxTokens to see the rest` } : {}),
      }
    },
  })


  const chaptersArtifact = defineTool({
    name: 'chapters_artifact',
    description:
      'Query a stored artifact (a tool result too large to sit in context — deferred blobs and arrival-stored documents alike) '
      + 'WITHOUT loading it whole: action "toc" = heading map with line numbers (structured/markdown files), '
      + '"search" = query (regex or phrase) → small matched blocks with line numbers, "read" = exact line range. '
      + 'path accepts the artifacts/… path or the bare sha256 from the stub line.',
    parameters: {
      path: { type: 'string', required: true, description: 'Artifact reference from the stub: artifacts/<xx>/<sha>.txt path or the 64-hex sha.' },
      action: { type: 'string', required: true, description: 'One of: toc | search | read.' },
      query: { type: 'string', description: 'Required for search: regex or literal phrase (case-insensitive).' },
      offset: { type: 'number', description: 'read: first line (1-based). Default 1.' },
      limit: { type: 'number', description: 'read: line count (hard cap 400).' },
      maxTokens: { type: 'number', description: 'search: budget for returned blocks (default 400).' },
    },
    output: jsonOutput((value: unknown) => JSON.stringify(value, null, 1)),
    async execute(args: { path: string; action: string; query?: string; offset?: number; limit?: number; maxTokens?: number }, exec: ToolRunContext) {
      const caller = callerOf(exec)
      if ('reason' in caller) return { ...CALLER_MISSING }
      const cwd = (caller.session as { header?: { cwd?: string } }).header?.cwd ?? ''
      const storeDir = resolveStoreRoot(cwd, config.artifactStoreRoot ?? '.dsh-chapters')
      let abs: string | null
      try { abs = resolveArtifactWithMirror(storeDir, args.path, path.join(cwd, DEFAULT_CLONE_DIR)) }
      catch (error) { return { ok: false as const, error: String((error as Error)?.message ?? error) } }
      if (abs === null) return { ok: false as const, error: `no artifact at ${args.path} — searched the store root, every session tree under it (${storeDir}/*/artifacts/) and the knowledge mirror (${path.join(cwd, DEFAULT_CLONE_DIR)}/artifacts/<projectKey>/); the blob was never written here or its pool has not published/pulled it yet (/chapters-status shows the transport state)` }
      const text = fs.readFileSync(abs, 'utf8')
      const action = args.action.toLowerCase()
      if (action === 'toc') {
        const toc = buildToc(text)
        return { ok: true as const, action, path: args.path, bytes: fs.statSync(abs).size, headings: toc.entries.length, ...(toc.truncated ? { truncated: true } : {}), toc: toc.entries.map((e) => `${'  '.repeat(e.depth - 1)}L${e.line} ${'#'.repeat(e.depth)} ${e.title}`) }
      }
      if (action === 'search') {
        if (args.query === undefined || args.query.trim() === '') return { ok: false as const, error: 'search requires a non-empty query' }
        const pack = searchArtifact(text, args.query, { maxTokens: args.maxTokens ?? config.searchMaxTokens ?? 400 })
        return { ok: true as const, action, path: args.path, query: args.query, totalMatches: pack.total, returnedBlocks: pack.blocks.length, truncated: pack.truncated, ...(pack.remaining > 0 ? { remainingMatches: pack.remaining, note: 'narrow the query or raise maxTokens' } : {}), blocks: pack.blocks.map((b) => b.lines.join('\n')) }
      }
      if (action === 'read') {
        const r = readLines(text, args.offset ?? 1, args.limit ?? 200)
        return { ok: true as const, action, path: args.path, start: r.start, end: r.end, of: r.of, ...(r.end - r.start + 1 < (args.limit ?? 200) ? { note: 'file end reached' } : {}), lines: r.lines }
      }
      return { ok: false as const, error: `unknown action ${args.action} (use toc | search | read)` }
    },
  })


  // ---------------------------------------------------------------- P3 proposal tool

  const chaptersRulePropose = defineTool({
    name: 'chapters_rule_propose',
    description:
      'Propose a PROJECT RULE for shared review (record \u00A77): a durable, generalizable instruction '
      + 'learned from this work (conventions, invariants, pitfalls \u2014 not one-off facts). It enters as '
      + 'proposed: it changes NO session anywhere until a human approves it on their own machine.',
    parameters: {
      category: { type: 'string', required: true, description: 'Short slug, e.g. security, testing, style, deploy.' },
      text: { type: 'string', required: true, description: 'The rule, one imperative paragraph. A human reads exactly this.' },
    },
    output: jsonOutput((value: unknown) => JSON.stringify(value, null, 1)),
    async execute(args: { category: string; text: string }, exec: ToolRunContext) {
      const caller = callerOf(exec)
      if ('reason' in caller) return { ...CALLER_MISSING }
      const cwd = (caller.session as { header?: { cwd?: string } }).header?.cwd ?? ''
      if (config.harnessId === undefined) return { ok: false, text: 'rules surface not configured (harnessId absent)' }
      try {
        const reply = await rulesCommand({
          cwd: () => cwd,
          storeRoot: config.artifactStoreRoot,
          harnessId: config.harnessId,
          store,
          projectFor: (c) => projectForCwd(store.projects(), c),
          mirrorDir: (c) => path.join(c, DEFAULT_CLONE_DIR),
          syncNow: async (c) => { config.scheduler?.schedule(c, 'archive:rules') },
          now: () => new Date(),
          sourceSession: caller.session.id,
        }, `add ${args.category} ${args.text}`)
        return { ok: reply.kind === 'success', text: reply.text }
      } catch (error) {
        return { ok: false, text: `chapters_rule_propose failed: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
      }
    },
  })

  return { segment: chaptersSegment, chaptersContinue, chaptersFork, chaptersSearch, chaptersArtifact, chaptersRulePropose, forkCommand, continueCommand, saveCommand }
}

export function registerChaptersTools(
  ctx: ToolsCtx,
  store: RegistryStore,
  config: ToolsConfig,
): () => void {
  const built = buildChaptersTools(ctx, store, config)
  const disposeSegment = ctx.tools.register(built.segment)
  const disposeContinue = ctx.tools.register(built.chaptersContinue)
  const disposeFork = ctx.tools.register(built.chaptersFork)
  const disposeSearch = ctx.tools.register(built.chaptersSearch)
  const disposeArtifact = ctx.tools.register(built.chaptersArtifact)
  const disposeRulePropose = ctx.tools.register(built.chaptersRulePropose)
  let disposeCommand: (() => void) | null = null
  const commands = ctx.get?.('commands') as { register?: (def: unknown) => (() => void) | unknown } | undefined
  if (commands?.register !== undefined) {
    try {
      // Both deterministic doors register on the same seam. Keep EVERY disposer: a loop
      // that overwrote `disposeCommand` would leak the first registration and unregister
      // only whichever door was added last.
      const commandDisposers: Array<() => void> = []
      for (const def of [built.forkCommand, built.continueCommand, built.saveCommand]) {
        const disposer = commands.register(def)
        if (typeof disposer === 'function') commandDisposers.push(disposer as () => void)
      }
      if (commandDisposers.length > 0) disposeCommand = () => { for (const d of commandDisposers) d() }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-chapters: host command registration failed (${String(error)}); tools unaffected`)
    }
  }
  // Pre-existing comma operator here (`disposeArtifact(), disposeRulePropose()`) ran both,
  // so behaviour was right — but it reads as a typo and would silently break if anyone
  // reordered the line. Semicolons, since this is the unload path a test cannot cover.
  return () => { disposeSegment(); disposeContinue(); disposeFork(); disposeSearch();
    disposeArtifact(); disposeRulePropose(); disposeCommand?.() }
}
