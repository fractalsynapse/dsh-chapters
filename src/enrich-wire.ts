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
import { buildEnrichInput, buildMineInput, parseEnrichResult, parseMinedRules, applyEnrich, type CurrentValues, type GeneratedProvenance, type GeneratedMark, type MinedRuleOut } from './enrich.ts'
import { parseChapterFile, updateChapterFrontmatter } from './enrich-store.ts'
import { sha256 } from './render.ts'
import { resolveStoredPath } from './archive.ts'
import { isActiveChapter } from './registry.ts'

/** The row shape the ladder may read and re-write — structural, never the registry's own type. */
interface ChapterRowItem {
  number: number
  path?: string | undefined
  title?: string | undefined
  summary?: string | undefined
  topics?: string[] | undefined
  generated?: Record<string, GeneratedMark[]> | undefined
  sha256?: string | undefined
}
interface ChapterRow { chapters: ChapterRowItem[] }

export interface EnrichConfig {
  enabled: boolean
  /** 'provider/model' or '' = follow the conversation (realm) / stored route (host) */
  model: string
  trigger: 'afterPush' | 'idle' | 'both' | 'manual'
  idleMs: number
  batchCap: number
  /** One auxiliary completion budget (see enrich.ts: reasoning tokens are counted) */
  maxTokens?: number | undefined
  /**
   * #50 §7.5: mine standing orders out of each annotated chapter. `undefined`
   * means ON — the point of the tier is that the human does not have to think
   * about it; what a mined rule needs is not a click but a VERBATIM QUOTE of the
   * human's own words, enforced at activation, and a list one command away.
   */
  mineRules?: boolean | undefined
  /** per-chapter cap on mined rules (§7.5: few, short, traceable) */
  mineCap?: number | undefined
  /**
   * §7.5 policy (amended 2026-10-21): may a mined rule govern on arrival? Default
   * TRUE — inferring a standing order nobody spelled out is the point of the tier.
   * False holds every mined rule as `reviewOnly` until a human approves it here.
   */
  rulesAutoActivate?: boolean | undefined
  /**
   * §7.5: a model of its own for rule mining ('provider/model', or a bare model
   * name on the current provider). Empty ⇒ mine inside the SAME annotation call,
   * which costs no extra inference. Set it and mining becomes a second bounded call
   * per chapter — the honest way to say governance deserves a better model than
   * annotation does.
   */
  rulesModel?: string | undefined
}

export interface EnrichWiringDeps {
  store: {
    get(id: string): Promise<{ cwd?: string | undefined; chapters: { number: number; path: string; title: string; summary: string; topics: string[]; sha256: string; generated?: Record<string, GeneratedMark[]> }[] }>
    put(id: string, state: unknown, expectedRev?: number): Promise<void>
    /** #59: the ladder's whole-row write must run as one section over a FRESH read. */
    mutate(id: string, fn: (state: ChapterRow) => ChapterRow | Promise<ChapterRow>): Promise<unknown>
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
  onMinedRules?: ((args: { cwd: string; sessionId: string; chapterNumber: number; humanText: string; rules: readonly MinedRuleOut[]; max: number; autoActivate: boolean }) => Promise<{ written: number; stated: number; inferred: number; pending: number }>) | undefined
  scheduler?: { schedule(cwd: string, why: string): void }
  log(m: string): void
  warn(m: string): void
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
  /** #557: the registry's own project workspaces as bounded, deterministic resolution candidates. */
  projectCwds?: (() => string[]) | undefined
  /** #571: which pump surface this wiring is ('host' | 'realm') — names the lease holder. */
  planeId?: string
  /** #561: the row's own durable session header cwd — the authoritative locator for UNLINKED workspaces. */
  sessionCwdOf?: ((sid: string) => Promise<string | undefined>) | undefined
}

export interface EnrichWiring {
  queue: EnrichQueue
  /** manual drain for the command surface (cwd arms the workspace for files) */
  runNow(cwd?: string, limit?: number): Promise<{ processed: number; remaining: number; draining: boolean; alreadyRunning: boolean; leaseHeldBy?: string }>
  /** the configured per-pass cap (#565: the reply names it; the cap itself never changes at runtime) */
  batchCap(): number
  /** #565: the background drain's live state (surfaces and tests await it). */
  isDraining(): boolean
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

/** #557: the boot witness row is a status probe, not archived conversation — one predicate,
 *  every queue-facing loop obeys it (pending listing AND counting). */
export function isWitnessRow(sessionId: string): boolean { return sessionId === 'dsh-chapters-witness' }

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
      if (m.by === 'model') lines.push(
        `    - by: model`,
        `      model: ${m.model}`,
        `      at: ${m.at ?? ''}`,
        // #61: which build wrote it. Absent on records from before the field existed — rendering
        // `pluginVersion: undefined` would be a lie about a legacy row.
        ...(m.pluginVersion !== undefined && m.pluginVersion !== '' ? [`      pluginVersion: ${m.pluginVersion}`] : []),
      )
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

type ChapterLike = { number: number; title: string; status?: 'superseded' | 'removed'; generated?: Record<string, { by: string; model?: string }[]> }
/**
 * The ONE "does this chapter still need annotating?" test, used by BOTH the queue and `pendingCount`
 * (#61). They were two hand-written loops over `chaptersOf` that had already drifted in shape, and the
 * missing half was the minimum-content gate: five model calls in the field were spent titling husks
 * ("Empty conversation span with unknown events and zero-byte results") — money thrown at nothing to
 * annotate, and worse, the AI rename replaced a `FRAGMENT_TITLE`-shaped title so `indexing.ts` could no
 * longer stitch adjacent legacy fragments (indexing.ts:43). So an empty chapter is not a candidate, and
 * its deterministic title survives to be stitched.
 */
export function isPendingChapter(
  c: { messages?: number; generated?: { title?: { by: string; model?: string }[] } },
  modelKey: string,
): boolean {
  if ((c.messages ?? 1) === 0) return false
  const top = c.generated?.title?.[0]
  return !(top?.by === 'model' && top.model === modelKey)
}

function chaptersOf(state: unknown): ChapterLike[] {
  const c = (state as { chapters?: unknown } | undefined)?.chapters
  // #60, widened #255: the enrichment queue reads registry chapters through the ONE predicate, so a
  // repaired-away husk AND an operator-removed stub are never annotated and never re-enter the corpus
  // through the ladder. The old inline `!== 'superseded'` here was a second predicate (#59 shape) —
  // tests/unit/one-predicate.test.ts keeps comparisons against tombstone statuses inside registry.ts.
  return Array.isArray(c) ? (c as ChapterLike[]).filter(isActiveChapter) : []
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

  const ladder = async (key: string): Promise<{ ok: boolean; skipped?: string; resynced?: boolean }> => {
    const sep = key.lastIndexOf('#')
    const sid = key.slice(0, sep)
    const num = Number(key.slice(sep + 1))
    try {
      // Pre-flight read: cheap, and only used to find the file to annotate. The WRITE below never
      // touches this snapshot (#59).
      const state = await deps.store.get(sid)
      const rec = state.chapters.find((c) => c.number === num)
      if (rec === undefined) return { ok: false, skipped: 'record gone' }
      // #550: the ROW locates the file. The registry is per-HOME (#348's lesson: one
      // dsh_chapters.json holds every project's sessions) and listPending walks all of it, so a
      // queue armed by project A walks project B's chapters too — resolving those against A's cwd
      // printed 'chapter file absent' FOREVER for files that exist. Measured live: SAIP's status
      // skipped dsh-chapters' 978f1856#6 while its 006 chapter sat in its own tree. The process
      // cwd survives only as the fallback for pre-#348 rows, and its absence names the true cause.
      // #557 (completing #550): pre-#348 rows carry no cwd. Present-is-proof: try the known roots
      // in order (row, process/remembered, then the registry's OWN project cwds — bounded, same
      // store), and where the file EXISTS that root IS the row's owner: stamp it, so every later
      // consumer (repair/remove/GC per #348) inherits the attribution. Stamping a guess is
      // forbidden; stamping a resolved read is a fact.
      const roots: (string | undefined)[] = [state.cwd, deps.cwd() ?? rememberedCwd, ...(deps.projectCwds?.() ?? [])]
      let cwd: string | undefined
      let file = ''
      for (const r of roots) {
        if (r === undefined || r === '') continue
        const cand = resolveStoredPath(r, rec.path)
        if (fs.existsSync(cand)) { cwd = r; file = cand; break }
      }
      // #561: the projects table cannot name UNLINKED workspaces — knowledge-local projects (the
      // documented default!) have stores and rows but no project record, which left legacy rows
      // undiscoverable and the queue-head blocked (measured live on 0.2.54: processed 0; the
      // refusal was truthful — the root simply was never offered). The row's own HOST SESSION
      // HEADER is the authoritative locator the product already trusts (restore/repair read the
      // same durable record); consulted last, bounded to the miss path.
      if (cwd === undefined && deps.sessionCwdOf !== undefined) {
        const hdr = await deps.sessionCwdOf(sid).catch(() => undefined)
        if (hdr !== undefined && hdr !== '') {
          roots.push(hdr)
          const cand = resolveStoredPath(hdr, rec.path)
          if (fs.existsSync(cand)) { cwd = hdr; file = cand }
        }
      }
      if (cwd === undefined) {
        return { ok: false, skipped: roots.some((r) => r !== undefined && r !== '')
          ? 'chapter file absent under the row, process, project roots, and session header'
          : 'row carries no owning workspace, no process cwd, no project roots, and no session header offered — re-derive via /chapters-repair' }
      }
      if (state.cwd === undefined || state.cwd === '') {
        try {
          await deps.store.mutate(sid, (st) => {
            const row = st as { cwd?: string }
            return row.cwd === undefined || row.cwd === '' ? ({ ...row, cwd } as unknown) as never : st
          })
        } catch { /* the annotation proceeds; the stamp retries on the next pass */ }
      }
      const doc = parseChapterFile(fs.readFileSync(file, 'utf8'))
      // A plan document is a WORK DIRECTIVE: its body is the approved text, and an
      // annotator rewriting its summary is a paraphrase of an order (invariant 4's
      // discipline applied to the ladder). Directives are indexed, cited and searched
      // as they are; only transcript chapters are ever annotated.
      if (doc.fmLines.some((l) => /^kind:\s*plan\s*$/.test(l))) return { ok: false, skipped: 'plan documents are directives — never annotated' }
      // #571 HEAL (dual-queue split receipts): when the FILE already carries this model key's
      // annotation (the enrichment write landed but the registry commit did not — measured at
      // 354 records), the guarded rewrite would refuse FOREVER and head-block the queue. If the
      // file is body-self-consistent (the declared anchor matches the parsed body — so this is a
      // stale RECEIPT, not corruption) the ladder resyncs the registry record from the file and
      // counts it done, without any model call. Self-consistency failing stays a loud refusal:
      // real damage keeps the alarm that caught it.
      {
        const keyNow = modelKey()
        const genIdx = doc.fmLines.findIndex((l) => /^generated:/.test(l))
        const fileHasModelMark = genIdx >= 0 && doc.fmLines.slice(genIdx).some((l) => l.includes(`model: ${keyNow}`))
        if (fileHasModelMark) {
          const anchor = doc.fmLines.find((l) => /^(?:bodySha256|sha256):/.test(l))?.split(': ')[1]?.trim()
          const bodyText = doc.body
          const selfConsistent = anchor === undefined || anchor === sha256(bodyText) || anchor === sha256(bodyText.replace(/\n$/, ''))
          if (selfConsistent) {
            const fmGet = (k: string): string | undefined => doc.fmLines.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim()
            const unq = (v: string | undefined): string | undefined => {
              if (v === undefined) return undefined
              try { return JSON.parse(v) as string } catch { return v.replace(/^"|"$/g, '') }
            }
            let topics: string[] | undefined
            const rawTopics = fmGet('topics')
            if (rawTopics !== undefined) { try { topics = JSON.parse(rawTopics) as string[] } catch { topics = undefined } }
            const atLine = doc.fmLines.slice(doc.fmLines.findIndex((l) => l.includes(`model: ${keyNow}`)) + 1, doc.fmLines.findIndex((l) => l.includes(`model: ${keyNow}`)) + 3).find((l) => /at:/.test(l))
            const at = atLine?.split(': ')[1]?.trim().replace(/^'|'$/g, '') ?? new Date().toISOString()
            const fileText = fs.readFileSync(file, 'utf8')
            await deps.store.mutate(sid, (fresh) => {
              const cur = fresh.chapters.find((c) => c.number === num)
              if (cur === undefined) return fresh
              return {
                ...fresh,
                chapters: fresh.chapters.map((c) => c.number === num
                  ? { ...c, title: unq(fmGet('title')) ?? c.title, summary: unq(fmGet('summary')) ?? c.summary, topics: topics ?? c.topics, generated: { ...(c.generated ?? {}), title: [{ by: 'model', model: keyNow, at }] }, sha256: sha256(fileText) }
                  : c),
              }
            })
            return { ok: true, resynced: true }
          }
        }
      }
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
      // §7.5 mining, and it happens BEFORE the hash-guarded frontmatter write, so a
      // chapter whose annotation is refused still contributes its standing orders.
      const humanText = humanBytesOf(body)
      let mined: readonly MinedRuleOut[] = result !== null ? result.rules : []
      // A dedicated governance model is opt-in; when set, ITS answer is what gets
      // mined and the annotation pass's rules are ignored — two models minting
      // rules for one chapter would just duplicate under different judgement.
      const mineSpec = (deps.store.getSetting('rules.model') ?? deps.config.rulesModel ?? '').trim()
      if (deps.config.mineRules !== false && mineSpec !== '' && mineSpec !== 'conversation') {
        try {
          const sep = mineSpec.indexOf('/')
          const base = resolveRoute()
          const route = sep > 0
            ? { provider: mineSpec.slice(0, sep), model: mineSpec.slice(sep + 1) }
            : { provider: base?.provider ?? '', model: mineSpec }
          if (route.provider !== '') {
            mined = parseMinedRules(await deps.fetch(buildMineInput(
              { requests: userChunks.map(stripFence) },
              body.slice(0, 6000),
            ), route))
          } else {
            deps.warn(`rules.model "${mineSpec}" names no provider to route through — mining with the annotation result instead`)
          }
        } catch (error) {
          deps.warn(`rule mining pass failed (${String((error as Error)?.message ?? error).slice(0, 120)}) — the annotation is unaffected`)
          mined = []
        }
      }
      if (mined.length > 0) {
        if (deps.config.mineRules === false) {
          deps.log(`rule mining skipped for ${sid}#${num}: ${mined.length} candidate(s) dropped (rulesEnrichment off)`)
        } else if (deps.onMinedRules === undefined) {
          deps.warn(`rule mining UNWIRED on this plane: ${mined.length} candidate(s) for ${sid}#${num} were not recorded — the sink owns disk + identity`)
        } else {
          try {
            const got = await deps.onMinedRules({
              cwd,
              sessionId: sid,
              chapterNumber: num,
              // The human's own bytes, cut at the next role marker. They decide
              // whether a mined rule is LABELLED `stated` or `inferred` — a warrant
              // shown to the human, not permission to govern (§7.5, 2026-10-21).
              humanText,
              rules: mined,
              max: deps.config.mineCap ?? 3,
              autoActivate: deps.config.rulesAutoActivate !== false,
            })
            if (got.written > 0) {
              deps.log(`rule mining ${sid}#${num}: ${got.written} recorded (${got.stated} stated by you, ${got.inferred} inferred${got.pending > 0 ? `, ${got.pending} held for review` : ', all governing now'} — /chapters-rule list --scope session)`)
              // session rules are LOCAL: nothing is armed on the scheduler (§7.5)
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
      // #59: this put was built from a row read BEFORE the model call, so every chapter annotated
      // late enough rewound whatever another door had committed in the meantime — the field
      // instance landed at 04:53:52.841 over a compaction commit from 04:53:50.915. The whole
      // remaining step is now ONE section over a fresh read: re-find the record, write the file,
      // re-anchor the row. Nothing derived from a pre-model snapshot survives into the write.
      await deps.store.mutate(sid, (fresh) => {
        const cur = fresh.chapters.find((c) => c.number === num)
        if (cur === undefined) return fresh // record vanished under us: the file write already happened, the row is its own truth
        return {
          ...fresh,
          chapters: fresh.chapters.map((c): ChapterRowItem => c.number === num
            // re-anchor the registry's whole-file hash after the sanctioned write
            // so the cite-time tamper check stays truthful for every descendant
            ? { ...c, number: c.number, title: v.title, summary: v.summary, topics: v.topics, generated: v.generated, ...(written.changed ? { sha256: written.fileSha256 } : {}) }
            : c),
        }
      })
      // Annotated bytes are new knowledge: arm the push, exactly as before #59 moved the write.
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
        if (isWitnessRow(sid)) continue // #557: the witness names no file — probe row, never enrichment material
        for (const c of chaptersOf(st)) {
          if (!isPendingChapter(c, modelKey2)) continue
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
    getSetting: (k) => deps.store.getSetting(k),
    putSetting: async (k, v) => { await deps.store.putSetting(k, v ?? '') },
    planeId: deps.planeId ?? 'host',
  })

  return {
    queue,
    auxRoute: () => resolveRoute(),
    rememberCwd(c: string) { rememberedCwd = c },
    async pendingCount() {
      let n = 0
      const key2 = modelKey()
      for (const [sid, st] of deps.store.sessions()) {
        if (isWitnessRow(sid)) continue // #557: counted nowhere, queued nowhere — one predicate
        for (const c of chaptersOf(st)) {
          if (isPendingChapter(c, key2)) n += 1
        }
      }
      return n
    },
    async runNow(cwd?: string, limit?: number) {
      if (cwd !== undefined) rememberedCwd = cwd
      // #565: the manual surface DRAINS (all pending, or the caller's limit) in the background —
      // the maintainer's rule replaced the one-batch design: 'We should process all of the
      // unfinished ones or allow the user to specify a limit.' The return names what started,
      // not what finished; `report` follows the count down.
      const d = queue.drainAll(limit)
      const remaining = await this.pendingCount()
      return { processed: 0, remaining, draining: d.started, alreadyRunning: d.alreadyRunning, ...(d.leaseHeldBy !== undefined ? { leaseHeldBy: d.leaseHeldBy } : {}) }
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
      const drainState = queue.isDraining() ? ' · FULL DRAIN RUNNING' : ''
      return `enrichment: ${deps.config.trigger}, model ${model}${mine}${drainState}${last}`
    },
    batchCap: () => deps.config.batchCap,
    isDraining: () => queue.isDraining(),
    dispose() { queue.dispose() },
  }
}
