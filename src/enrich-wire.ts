/**
 * P2 S6 — enrichment wiring: binds the pure ladder (enrich.ts) and the
 * guarded persistence (enrich-store.ts) to the registry domain and the sync
 * scheduler, per plane.
 *
 * Division of labor (deliberate):
 *   - REALM engine owns the AUTO triggers (afterPush/idle/both): it sees the
 *     conversation's routed model (requestHeader) and fires after its own
 *     pushes/finalizes; it persists the resolved provider/model route and a
 *     state heartbeat into the shared settings table.
 *   - HOST plane runs the command surface (manual drains, model override,
 *     report/status) and reads the same tables; its queue is trigger-manual
 *     so auto work never double-runs.
 *
 * The ladder per chapter: build slice -> fetch -> validate; invalid -> ONE
 * retry with a nudge; still invalid -> keep deterministic values (never
 * blocks, never blanks). Frontmatter write goes through the body-hash guard;
 * the registry record mirrors the new fields; a modified file is republished
 * via the scheduler (debounced).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createEnrichQueue, type EnrichQueue } from './enrich-queue.ts'
import { buildEnrichInput, parseEnrichResult, applyEnrich, type CurrentValues, type GeneratedProvenance, type GeneratedMark, type MinedRuleOut } from './enrich.ts'
import { parseChapterFile, updateChapterFrontmatter } from './enrich-store.ts'

export interface EnrichConfig {
  enabled: boolean
  /** 'provider/model' or '' = follow the conversation (realm) / stored route (host) */
  model: string
  trigger: 'afterPush' | 'idle' | 'both' | 'manual'
  idleMs: number
  batchCap: number
  /**
   * #50 §7.5: mine standing orders out of each annotated chapter. `undefined`
   * means ON — the point of the tier is that the human does not have to think
   * about it; what a mined rule needs is not a click but a VERBATIM QUOTE of the
   * human's own words, enforced at activation, and a list one command away.
   */
  mineRules?: boolean | undefined
  /** per-chapter cap on mined rules (§7.5: few, short, traceable) */
  mineCap?: number | undefined
}

export interface EnrichWiringDeps {
  store: {
    get(id: string): Promise<{ chapters: { number: number; path: string; title: string; summary: string; topics: string[]; sha256: string; generated?: Record<string, GeneratedMark[]> }[] }>
    put(id: string, state: unknown): Promise<void>
    sessions(): IterableIterator<[string, unknown]>
    getSetting(key: string): string | undefined
    putSetting(key: string, value: string): Promise<void>
  }
  cwd(): string | undefined
  config: EnrichConfig
  /** one completion; may reject — the ladder catches */
  fetch(prompt: string, route: { provider: string, model: string } | null): Promise<string>
  /** route resolution when neither override nor config names one (realm: live agent; host: persisted) */
  conversationRoute(): { provider: string, model: string } | null
  /**
   * #50 §7.5 sink: the plane that owns disk + identity + the registry writes the
   * mined candidates. enrich-wire stays model-plumbing only — it hands over the
   * chapter's human bytes and the candidates and reports what happened. Absent ⇒
   * mining is WARNED as unwired, never silently dropped.
   */
  onMinedRules?: ((args: { cwd: string; sessionId: string; chapterNumber: number; humanText: string; rules: readonly MinedRuleOut[]; max: number }) => Promise<{ written: number; activated: number; suggested: number }>) | undefined
  scheduler?: { schedule(cwd: string, why: string): void }
  log(m: string): void
  warn(m: string): void
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
}

export interface EnrichWiring {
  queue: EnrichQueue
  /** manual drain for the command surface (cwd arms the workspace for files) */
  runNow(cwd?: string): Promise<{ processed: number; remaining: number }>
  setModelOverride(v: string | null): Promise<void>
  modelOverride(): string | null
  statusLine(): string
  /** pending chapter count for reports (full scan, un-capped) */
  pendingCount(): Promise<number>
  /** the resolved auxiliary route (enrichment AND plot share it, P2 decision) */
  auxRoute(): { provider: string; model: string } | null
  /** planes remember the workspace seen at sync/command time */
  rememberCwd(cwd: string): void
  dispose(): void
}

const ROUTE_KEY = 'enrichment.route'
const STATE_KEY = 'enrichment.state'

const stripFence = (chunk: string): string => chunk.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```\s*$/, '').trim()

/** YAML block for the generated: frontmatter field (newest-first chains) */
export function renderGeneratedBlock(gen: GeneratedProvenance): string {
  const lines: string[] = []
  for (const key of ['title', 'summary', 'topics'] as const) {
    const chain = gen[key]
    if (chain === undefined || chain.length === 0) continue
    lines.push(`  ${key}:`)
    for (const m of chain) {
      if (m.by === 'model') lines.push(`    - by: model`, `      model: ${m.model}`, `      at: ${m.at ?? ''}`)
      else lines.push(`    - by: deterministic`)
    }
  }
  return '\n' + lines.join('\n')
}

/**
 * The HUMAN bytes of a chapter, and only these. The annotator input splits the
 * body on user-role markers and slices(1) — which leaves every chunk RUNNING ON
 * into the
 * assistant reply that follows it, so it is not a set of user turns. For the
 * verbatim-quote gate (§7.5) that distinction is the whole mechanism: a quote
 * found in assistant prose is the model restating an instruction (the
 * amplification path), never evidence a human gave one. So each chunk is cut at
 * the next role marker before it is offered as evidence.
 */
export function humanBytesOf(body: string): string {
  const out: string[] = []
  // walk: a role label, then its text until the NEXT label
  const re = /\*\*(User|Assistant)[^*\n]*:\*\*/g
  let m: RegExpExecArray | null
  const marks: { role: string; start: number; end: number }[] = []
  while ((m = re.exec(body)) !== null) marks.push({ role: m[1]!, start: m.index, end: m.index + m[0].length })
  for (let i = 0; i < marks.length; i += 1) {
    if (marks[i]!.role !== 'User') continue
    const next = i + 1 < marks.length ? marks[i + 1]!.start : body.length
    const text = body.slice(marks[i]!.end, next)
    if (text.trim() !== '') out.push(text.trim())
  }
  return out.join('\n')
}

type ChapterLike = { number: number; title: string; generated?: Record<string, { by: string; model?: string }[]> }
function chaptersOf(state: unknown): ChapterLike[] {
  const c = (state as { chapters?: unknown } | undefined)?.chapters
  return Array.isArray(c) ? c as ChapterLike[] : []
}

export function createEnrichWiring(deps: EnrichWiringDeps): EnrichWiring {
  const resolveRoute = (): { provider: string, model: string } | null => {
    const override = deps.store.getSetting('enrichment.model') ?? ''
    const spec = (override !== '' ? override : deps.config.model).trim()
    if (spec !== '' && spec !== 'conversation') {
      const i = spec.indexOf('/')
      if (i > 0) return { provider: spec.slice(0, i), model: spec.slice(i + 1) }
      return { provider: deps.conversationRoute()?.provider ?? '', model: spec }
    }
    const persisted = deps.store.getSetting(ROUTE_KEY)
    if (persisted !== undefined) {
      const i = persisted.indexOf('/')
      if (i > 0) return { provider: persisted.slice(0, i), model: persisted.slice(i + 1) }
    }
    return deps.conversationRoute()
  }
  const modelKey = (): string => {
    const r = resolveRoute()
    return r !== null && r.model !== '' ? `${r.provider}/${r.model}` : 'conversation'
  }
  let rememberedCwd: string | undefined

  const ladder = async (key: string): Promise<{ ok: boolean; skipped?: string }> => {
    const sep = key.lastIndexOf('#')
    const sid = key.slice(0, sep)
    const num = Number(key.slice(sep + 1))
    const cwd = deps.cwd() ?? rememberedCwd
    if (cwd === undefined) return { ok: false, skipped: 'no workspace cwd yet (a sync or command arms it)' }
    try {
      const state = await deps.store.get(sid)
      const rec = state.chapters.find((c) => c.number === num)
      if (rec === undefined) return { ok: false, skipped: 'record gone' }
      const file = path.join(cwd, rec.path)
      if (!fs.existsSync(file)) return { ok: false, skipped: 'chapter file absent' }
      const doc = parseChapterFile(fs.readFileSync(file, 'utf8'))
      // A plan document is a WORK DIRECTIVE: its body is the approved text, and an
      // annotator rewriting its summary is a paraphrase of an order (invariant 4's
      // discipline applied to the ladder). Directives are indexed, cited and searched
      // as they are; only transcript chapters are ever annotated.
      if (doc.fmLines.some((l) => /^kind:\s*plan\s*$/.test(l))) return { ok: false, skipped: 'plan documents are directives — never annotated' }
      const body = doc.body
      const userChunks = body.split(/\*\*User[^*\n]*:\*\*/g).slice(1)
      const asstChunks = body.split(/\*\*Assistant[^*\n]*:\*\*/g).slice(1)
      // Optional CodeGraph structural context: extract code-shaped tokens from
      // the chapter body and explore them against the project index. Fire-and-forget;
      // failure → undefined (buildEnrichInput treats it as zero bytes).
      let codegraphContext: string | undefined
      try {
        const cg = await import('./codegraph.ts')
        const root = cg.findCodegraphRoot(cwd)
        if (root !== undefined) {
          const tokens = cg.extractCodeTokens(body, 5)
          if (tokens.length > 0) {
            codegraphContext = await cg.exploreCodegraph(undefined, root, tokens.join(' '), 800, 15000)
            if (codegraphContext === '') codegraphContext = undefined
          }
        }
      } catch { /* CodeGraph unavailable or failed — enrichment proceeds without */ }
      const input = buildEnrichInput(
        { title: rec.title },
        {
          requests: userChunks.slice(-3).map(stripFence),
          ...(asstChunks.length > 0 ? { firstAssistant: stripFence(asstChunks[0]!) } : {}),
          ...(asstChunks.length > 1 ? { lastAssistant: stripFence(asstChunks[asstChunks.length - 1]!) } : asstChunks.length === 1 && userChunks.length === 0 ? { lastAssistant: stripFence(asstChunks[0]!) } : {}),
        },
        body.slice(0, 8000),
        codegraphContext,
      )
      const route = resolveRoute()
      const key2 = modelKey()
      let result = parseEnrichResult(await deps.fetch(input, route))
      if (result === null) {
        // one retry with a nudge; garbage stays non-fatal (record §6.1)
        result = parseEnrichResult(await deps.fetch(input + '\nRemember: reply with ONLY the JSON object, no other text.', route))
      }
      // #50 §7.5 mining runs BEFORE the "already enriched" short-circuit: a chapter
      // that needs no new title may still be full of standing orders, and skipping
      // them because the annotation was a no-op is exactly the kind of silence this
      // round is about. Failures are contained — mining must never cost a chapter
      // its annotation or break the ladder.
      if (result !== null && result.rules.length > 0) {
        if (deps.config.mineRules === false) {
          deps.log(`rule mining skipped for ${sid}#${num}: ${result.rules.length} candidate(s) dropped (rulesEnrichment off)`)
        } else if (deps.onMinedRules === undefined) {
          deps.warn(`rule mining UNWIRED on this plane: ${result.rules.length} candidate(s) for ${sid}#${num} were not recorded — the sink owns disk + identity`)
        } else {
          try {
            const mined = await deps.onMinedRules({
              cwd,
              sessionId: sid,
              chapterNumber: num,
              // ONLY the human's own bytes, cut at the next role marker: the chunks
              // the annotator input uses run ON into the assistant reply, and that
              // leaked assistant prose into the quote gate's evidence (§7.5).
              humanText: humanBytesOf(body),
              rules: result.rules,
              max: deps.config.mineCap ?? 3,
            })
            if (mined.written > 0) {
              deps.log(`rule mining ${sid}#${num}: ${mined.written} recorded (${mined.activated} activated on a verbatim quote, ${mined.suggested} awaiting review — /chapters-rule list --scope session)`)
              // session rules are LOCAL (§7.5): never staged, so no sync is armed
            }
          } catch (error) {
            deps.warn(`rule mining failed for ${sid}#${num}: ${String((error as Error)?.message ?? error).slice(0, 140)} — the annotation itself is unaffected`)
          }
        }
      }
      const current: CurrentValues = { title: rec.title, summary: rec.summary, topics: rec.topics, ...(rec.generated !== undefined ? { generated: rec.generated as Partial<GeneratedProvenance> } : {}) }
      const applied = applyEnrich(current, result, key2, new Date().toISOString())
      if (!applied.changed) return { ok: false, skipped: result === null ? 'model output invalid; deterministic kept' : 'already enriched' }
      const v = applied.values
      const written = updateChapterFrontmatter(file, {
        title: JSON.stringify(v.title),
        summary: JSON.stringify(v.summary),
        topics: `[${v.topics.map((t) => JSON.stringify(t)).join(', ')}]`,
        generated: renderGeneratedBlock(v.generated as GeneratedProvenance),
      }, typeof rec.sha256 === 'string' ? rec.sha256 : undefined)
      await deps.store.put(sid, {
        ...state,
        chapters: (state as { chapters: Record<string, unknown>[] }).chapters.map((c) => c.number === num
          // re-anchor the registry's whole-file hash after the sanctioned write
          // so the cite-time tamper check stays truthful for every descendant
          ? { ...c, title: v.title, summary: v.summary, topics: v.topics, generated: v.generated, ...(written.changed ? { sha256: written.fileSha256 } : {}) }
          : c),
      })
      deps.scheduler?.schedule(cwd, 'archive:enrichment')
      return { ok: true }
    } catch (error) {
      deps.warn(`enrichment failed for ${key}: ${String((error as Error)?.message ?? error).slice(0, 120)}`)
      return { ok: false, skipped: 'error' }
    }
  }

  const queue = createEnrichQueue({
    listPending: async (modelKey2, cap) => {
      const out: { key: string; label: string }[] = []
      for (const [sid, st] of deps.store.sessions()) {
        for (const c of chaptersOf(st)) {
          const top = c.generated?.title?.[0]
          if (top?.by === 'model' && top.model === modelKey2) continue
          out.push({ key: `${sid}#${c.number}`, label: c.title.slice(0, 48) })
          if (out.length >= cap) return out
        }
      }
      return out
    },
    enrichOne: ladder,
    resolveModel: async () => modelKey(),
    enabled: deps.config.enabled,
    trigger: deps.config.trigger,
    idleMs: deps.config.idleMs,
    batchCap: deps.config.batchCap,
    log: (m) => {
      deps.log(m)
      const r = resolveRoute()
      if (r !== null) void deps.store.putSetting(ROUTE_KEY, `${r.provider}/${r.model}`).catch(() => undefined)
      void deps.store.putSetting(STATE_KEY, JSON.stringify({ at: new Date().toISOString(), line: m })).catch(() => undefined)
    },
    ...(deps.setTimer !== undefined ? { setTimer: deps.setTimer } : {}),
  })

  return {
    queue,
    auxRoute: () => resolveRoute(),
    rememberCwd(c: string) { rememberedCwd = c },
    async pendingCount() {
      let n = 0
      const key2 = modelKey()
      for (const [, st] of deps.store.sessions()) {
        for (const c of chaptersOf(st)) {
          const top = c.generated?.title?.[0]
          if (!(top?.by === 'model' && top.model === key2)) n += 1
        }
      }
      return n
    },
    async runNow(cwd?: string) {
      if (cwd !== undefined) rememberedCwd = cwd
      const processed = await queue.drainNow()
      return { processed, remaining: await this.pendingCount() }
    },
    async setModelOverride(v) {
      if (v === null) await deps.store.putSetting('enrichment.model', '')
      else await deps.store.putSetting('enrichment.model', v)
    },
    modelOverride() {
      const o = deps.store.getSetting('enrichment.model') ?? ''
      return o === '' ? null : o
    },
    statusLine() {
      if (!deps.config.enabled) return 'enrichment: disabled (signatures-only corpus, fully functional)'
      const override = this.modelOverride()
      const model = override ?? (deps.config.model !== '' ? deps.config.model : 'conversation model')
      const heartbeat = deps.store.getSetting(STATE_KEY)
      let last = ''
      try { last = ` · last: ${(JSON.parse(heartbeat ?? '{}') as { line?: string }).line ?? 'idle'}` } catch { /* cosmetic */ }
      const mine = deps.config.mineRules === false ? ' · rule mining OFF' : ` · rule mining ON (≤${deps.config.mineCap ?? 3}/chapter, verbatim-quote gated)`
      return `enrichment: ${deps.config.trigger}, model ${model}${mine}${last}`
    },
    dispose() { queue.dispose() },
  }
}
