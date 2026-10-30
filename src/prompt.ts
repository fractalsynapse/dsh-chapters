/**
 * dsh-chapters — prompt recommendations (#71, site §28).
 *
 * One model reads the context and DOES the work; a second model reads the context
 * and DEFINES it: the next prompt the human would send, offered as a ghost layer
 * in the composer. Off by default, and the model IS the switch: the effective spec
 * (stored override ?? config `promptModel`) being non-empty is what enables the
 * feature — one knob, no second boolean that could drift against it.
 *
 * Transport here is the PULL: the client overlay executes
 * `/chapters-prompt suggest` over `remote.commands` (the door-proven wire) and this
 * module answers from a one-per-turn-boundary cache or one bounded auxiliary call.
 * The 0.2.x push upgrade (plugin record + projection) is in docs/backlog.md; the
 * measured host facts are in docs/contract.md § Composer Ghost Layer.
 *
 * Invariants the answer MUST respect: the recommendation is UI state only. It is
 * never archived, never enters a notice or a rule, never steers a model request —
 * it reaches the log only when a human accepts it and sends, as their own message.
 *
 * @module dsh-chapters/src/prompt
 */
import { textOfBlocks } from './log-shape.ts'
import { screenConversation, stripReminderSpans } from './injections.ts'
import { isActiveChapter, type SessionState } from './registry.ts'
import type { SessionEventLike } from './types.ts'

/** The stored override key (durable kv, same table as `enrichment.model`). */
export const PROMPT_SETTING_KEY = 'prompt.model'

export interface PromptRoute { provider: string; model: string }

/**
 * An offer, or a refusal. `quiet: true` marks the refusals that are NOT news — "there is nothing to recommend
 * yet" and "suggestions are off" — so a caller can tell silence from failure (#113: the first thing the
 * feature did on a fresh thread was shout). Genuine failures (no route, assembly, the model call) leave
 * `quiet` falsy so they stay visible.
 *
 * WHY THIS IS NOT WIRED INTO `/chapters-prompt suggest` yet: the composer ghost obtains its suggestion by
 * EXECUTING that same command over the client remote (`src/client/prompt-ghost.ts:61-65`) and treats
 * `kind === 'success'` with non-empty text as AN OFFER. So softening the command's `kind` would render
 * "no suggestion — nothing to recommend yet" as ghost text: a new bug, worse than the one it fixes. The
 * command result carries no payload slot for this distinction, and the ghost's own guard
 * (`shouldShowGhost`) has nothing to key on. Fixing the silence properly needs one of: a structured field on
 * the command result the client may read, the ghost calling the surface through its own seam instead of a
 * human-facing command, or the refusal text being machine-tagged. Decided deliberately, not by prose-prefix
 * matching — see #113.
 */
export interface PromptSuggestionResult { ok: boolean; text: string; /** 'nothing to recommend' when quiet; otherwise what went wrong — the bar shows it (#61). */ quiet?: boolean; reason?: string }

/** What the surface will and won't accept, for a caller that must REPORT it (the command block, #113). */
export interface PromptLimits { maxChars: number; contextChars: number }

export interface PromptConfig {
  /** config default for the model; '' ⇒ off unless a stored override says otherwise. */
  model: string
  /** hard total budget on the assembled input slice. */
  contextChars: number
  /** cap on the accepted recommendation; over-cap is invalid, never truncated. */
  maxChars: number
  /** #188: share of the model's context window the derived input budget takes. */
  contextRatio: number
}

export interface PromptDeps {
  getSetting(key: string): string | undefined
  putSetting(key: string, value: string): Promise<void>
  deleteSetting(key: string): Promise<void>
  /** #188 REVERSES the old economy on the maintainer's direction: the chapter history of the
   *  ANCESTOR PATH (a continuation mid-goal inherits its lineage, not an empty list), each entry
   *  carrying its plots — an index a model cannot research is worthless, so the trajectory rides
   *  inside the assembly instead. */
  chaptersOf(session: SuggestSession): Promise<ChapterHistoryEntry[]>
  /** #188: the selected model's real context window, for the derived budget; null ⇒ no window
   *  known ⇒ the config fallback, loudly sourced. Absent dep ⇒ same fallback. */
  resolveWindow?(route: PromptRoute): Promise<number | null>
  /** #188: the core rules in force for this session (the block a rebuilt head renders from). */
  rulesOf?(session: SuggestSession): Promise<string>
  /** #188: the active plan text, when one governs the session. */
  planOf?(session: SuggestSession): Promise<string>
  config: PromptConfig
  /** The last route the conversation used on this plane, or null. */
  conversationRoute(): PromptRoute | null
  /** One auxiliary completion; may reject — `suggest` catches and refuses honestly. */
  fetch(prompt: string, route: PromptRoute): Promise<string>
  warn?(msg: string): void
}

/** A live session as the command hands it over: id, an optional title, and the
 *  surface events (what the working model sees — the same view the defining model reads). */
export interface SuggestSession { id: string; title?: string | undefined; /** #188: the workspace the chapter paths resolve against (the caller's cwd). */ cwd?: string | undefined; events: SessionEventLike[]; /** #113: when a goal governs the session, the constraint on the next step — see `goalDirectiveOf`. Text, not a goal object: goal semantics stay in one module. */ goalDirective?: string | undefined }

/** The surface the host command and `/chapters-status` speak to. */
export interface PromptSurface {
  /** Effective spec after precedence; '' ⇒ OFF. */
  effective(): { spec: string; source: 'override' | 'config' | 'unset' }
  setModel(spec: string | null): Promise<void>
  suggest(session: SuggestSession): Promise<PromptSuggestionResult>
  /** #113: the Suggested Next Step bar's server-side access — the row plus the process-local loop flags. */
  bar?: import('./prompt-state.ts').PromptBarAccess
  /** #188: the EFFECTIVE caps with their sources, so an output can state the number it validated
   *  against AND where it came from (stored beside the model, derived from its window, or config). */
  limits(route: PromptRoute | null): Promise<PromptLimits & { sources: PromptLimitSources }>
  /** #188: the caps ride beside the model — stored strings ('' deletes), validated by the caller. */
  setCaps?(opts: { maxChars?: string | null; contextChars?: string | null }): Promise<void>
  /** One line for /chapters-status — ON names the model, OFF names the command. */
  statusLine(): string
}

/**
 * Effective spec = stored override ?? config default, trimmed. `undefined`
 * (row absent — cleared) falls back; a STORED '' is the deliberate OFF.
 */
export function effectivePromptSpec(setting: string | undefined, configModel: string): { spec: string; source: 'override' | 'config' | 'unset' } {
  if (setting !== undefined) return { spec: setting.trim(), source: 'override' }
  const c = configModel.trim()
  return { spec: c, source: c === '' ? 'unset' : 'config' }
}

/**
 * 'provider/model' routes as named; a bare model name rides the conversation's
 * provider (the enrich-wire rule); '' is not a route. A bare name with no
 * provider answers with its reason rather than guessing.
 */
export function resolvePromptRoute(spec: string, conversation: PromptRoute | null): { route: PromptRoute | null; reason?: string } {
  if (spec === '') return { route: null, reason: 'prompt suggestions are off' }
  const i = spec.indexOf('/')
  if (i > 0 && i < spec.length - 1) return { route: { provider: spec.slice(0, i), model: spec.slice(i + 1) } }
  if (conversation !== null && conversation.provider !== '') return { route: { provider: conversation.provider, model: spec } }
  return { route: null, reason: `no provider to route "${spec}" — name it as provider/model` }
}

/**
 * The conversation tail from surface events, screened through the ONE injection
 * predicate (docs/contract.md, #59): injected events drop, injected spans strip.
 * Chronological; text-bearing human/assistant messages only.
 */
export function tailFromEvents(events: SessionEventLike[]): { role: 'user' | 'assistant'; text: string }[] {
  const out: { role: 'user' | 'assistant'; text: string }[] = []
  for (const ev of events) {
    const data = (ev.data ?? {}) as Record<string, unknown>
    if (ev.type === 'user/message') {
      const screen = screenConversation(data, textOfBlocks(data.content), 'user')
      if (screen.omittedEvent) continue
      const text = stripReminderSpans(screen.text).text.trim()
      if (text !== '') out.push({ role: 'user', text })
    } else if (ev.type === 'assistant/message') {
      const message = (data.message ?? data) as Record<string, unknown>
      const text = stripReminderSpans(textOfBlocks(message.content)).text.trim()
      if (text !== '') out.push({ role: 'assistant', text })
    }
  }
  return out
}

/** One chapter of the assembled history (#188): the index facts PLUS the trajectory. A model that
 *  cannot research gains nothing from an index it cannot follow — so each chapter carries its plots. */
export interface ChapterHistoryEntry { number: number; title: string; summary: string; plots: string[] }

/** The settings keys the caps ride beside the model in (#188): switch models, switch its caps. */
export const PROMPT_MAXCHARS_KEY = 'prompt.maxChars'
export const PROMPT_CONTEXTCHARS_KEY = 'prompt.contextChars'

/**
 * Extract a chapter's trajectory from its archived bytes, deterministically: every line-start `PLOT:`
 * in order, consecutive duplicates collapsed (a checkpoint carries the plot forward verbatim — a
 * repeat, not a new fact). Zero model tokens, works on chapters archived before this feature existed,
 * and prose that merely mentions the word mid-line is not a plot line.
 */
export function extractPlots(body: string): string[] {
  const out: string[] = []
  for (const raw of body.split('\n')) {
    const m = /^PLOT:[ \t]*(.+)$/.exec(raw.trim())
    if (m === null) continue
    const t = m[1]!.trim()
    if (t === '') continue
    if (out.length > 0 && out[out.length - 1] === t) continue
    out.push(t)
  }
  return out
}

export interface PromptLimitSources { maxChars: 'stored' | 'config'; contextChars: 'stored' | 'derived' | 'config' }

/**
 * The caps resolution chain (#188): stored-beside-the-model → derived from the model's REAL context
 * window (`window × ratio` tokens at the repo's one estimator, 4 chars/token) → config fallback. A
 * 1M-window model and a 32K model get budgets 30× apart from ONE rule; a garbage stored value is
 * ignored rather than parsed into a NaN budget; and the source of each number is reported, because a
 * cap nobody can attribute is a cap nobody can tune.
 */
export function resolvePromptLimits(input: {
  config: { maxChars: number; contextChars: number; contextRatio: number }
  window?: number | null
  stored?: { maxChars?: string; contextChars?: string }
}): { maxChars: number; contextChars: number; sources: PromptLimitSources } {
  const posInt = (v: string | undefined): number | null => {
    if (v === undefined) return null
    const t = v.trim()
    if (!/^\d+$/.test(t)) return null
    const n = Number(t)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const sm = posInt(input.stored?.maxChars)
  const sc = posInt(input.stored?.contextChars)
  const w = input.window
  const derived = w !== undefined && w !== null && Number.isFinite(w) && w > 0
    ? Math.floor(w * input.config.contextRatio * 4)
    : null
  const useDerived = derived !== null && derived > 0
  return {
    maxChars: sm ?? input.config.maxChars,
    contextChars: sc ?? (useDerived ? derived! : input.config.contextChars),
    sources: {
      maxChars: sm !== null ? 'stored' : 'config',
      contextChars: sc !== null ? 'stored' : (useDerived ? 'derived' : 'config'),
    },
  }
}

/**
 * The LAST turn, whole (#188): from the final human request through every assistant text that
 * followed it. Reuses the tail's defusing machinery (host-injected context screened, reminder spans
 * stripped) and then keeps only the closing exchange — the present the director must follow from.
 * Never sliced: a message enters whole or the assembly refuses.
 */
export function lastTurnFromEvents(events: SessionEventLike[]): { role: 'user' | 'assistant'; text: string }[] {
  const tail = tailFromEvents(events)
  let from = -1
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i]!.role === 'user') { from = i; break }
  }
  return from === -1 ? tail : tail.slice(from)
}

export interface SuggestFacts {
  /** #113: the active goal's constraint on the next step, already worded. Absent ⇒ no goal block. */
  goalDirective?: string | undefined
  /** #188: the active plan text, when one governs the session. */
  plan?: string | undefined
  /** #188: the core rules in force — the same block a rebuilt head renders from. */
  rules?: string | undefined
  title?: string | undefined
  /** The ancestor path's chapters, oldest first, each with its plots (#188). */
  chapters: ChapterHistoryEntry[]
  /** The last turn whole: the human's request through the final response (#188 — never sliced). */
  lastTurn: { role: 'user' | 'assistant'; text: string }[]
}

/**
 * Assemble the auxiliary input: deterministic (same facts ⇒ same bytes), hard
 * total ≤ `capChars`. Oldest chapter lines drop first, then oldest tail
 * messages; every drop is ANNOUNCED in the input itself — a silent squeeze
 * would make the answer look derived from bytes that were never sent.
 */
/**
 * Assemble the director's whole world (#188). Deterministic: same facts ⇒ same bytes.
 *
 * Two invariants the old assembly violated and this one exists to keep:
 *  - ZERO TRUNCATION. Nothing the model reads is ever sliced — the old 500-char per-message ellipsis
 *    is a hallucination invite and is gone. Messages and chapters enter whole or not at all.
 *  - The budget is enforced ONLY by the drop ladder: over budget, the OLDEST chapter goes first (the
 *    recent trajectory is what leads), each drop ANNOUNCED in the input itself. The protected set —
 *    skeleton, goal (objective whole; the old 600-char slice was itself a truncation), plan, rules,
 *    last turn — never slices; if it alone cannot fit, the suggestion REFUSES with the numbers.
 *    A refused suggestion costs one turn; a truncated one poisons the next.
 */
export function buildSuggestInput(facts: SuggestFacts, budgetChars: number, maxChars: number): { input: string } | { refusal: string } {
  const head = 'You are the second reader of a DSH session — a model that DEFINES the next step and never executes it.'
  const replyRules = `Write the ONE next prompt the human should send. A single imperative request; plain text; at most ${maxChars} characters; no preamble, no quotes, no markdown; it must follow from the latest state and propose nothing already done. Reply with ONLY that prompt. If it changes the standing objective, prefix it with GOAL: (the human sends those; autorun will not). Do not use the prefix for an ordinary next step.`
  const chapterBlock = (dropOldest: number): string[] => {
    const cs = facts.chapters.slice(dropOldest)
    if (cs.length === 0) return ['## Where it has been (no chapters yet)']
    const out = ['## Where it has been (chapters, oldest first — title, summary, and the plots that carry the trajectory)']
    for (const c of cs) {
      out.push(`${c.number}. ${c.title} — ${c.summary}`)
      if (c.plots.length > 0) {
        out.push('   Plots:')
        for (const pl of c.plots) out.push(`   - ${pl}`)
      }
    }
    return out
  }
  const assemble = (dropOldest: number): string => {
    const parts: string[] = [
      head,
      '',
      `## Session${facts.title !== undefined && facts.title !== '' ? `: ${facts.title}` : ''}`,
      // #113: the goal is stated BEFORE the history — it decides whether a candidate next step counts
      // as progress, so it is never a footnote. #188: the plan and the standing orders ride with it.
      ...(facts.goalDirective !== undefined && facts.goalDirective !== '' ? ['', String(facts.goalDirective)] : []),
      ...(facts.plan !== undefined && facts.plan !== '' ? ['', '## Active plan', String(facts.plan)] : []),
      ...(facts.rules !== undefined && facts.rules !== '' ? ['', '## Standing orders', String(facts.rules)] : []),
      '',
      ...chapterBlock(dropOldest),
      '',
      ...(facts.lastTurn.length > 0
        ? ['## Last turn (request through final response)', ...facts.lastTurn.map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.text}`)]
        : ['## Last turn (empty)']),
    ]
    if (dropOldest > 0) {
      parts.push(`(older chapters dropped to fit the ${budgetChars}-char budget: ${dropOldest} chapter(s) — the recent trajectory leads)`)
    }
    parts.push('', replyRules)
    return parts.join('\n')
  }
  for (let drop = 0; drop <= facts.chapters.length; drop++) {
    const input = assemble(drop)
    if (input.length <= budgetChars) return { input }
  }
  const floor = assemble(facts.chapters.length).length
  return {
    refusal: `the suggestion input cannot fit — the protected context (goal, plan, rules, last turn) assembles to ${floor} chars, exceeding the ${budgetChars}-char budget with all ${facts.chapters.length} chapter(s) already dropped. Refusing rather than truncating (#188): raise the budget or set a larger model with /chapters-prompt model.`,
  }
}


/**
 * Validate one answer. A wrapping code fence or one pair of wrapping quotes is
 * formatting noise and comes off; the rest is the human's next prompt verbatim.
 * Over-cap or empty is INVALID (never truncated) — the caller retries once and
 * then refuses with the measured numbers.
 */
export function validateSuggestion(raw: string, maxChars: number): { ok: true; text: string } | { ok: false; reason: string } {
  let text = raw.trim()
  const fence = text.match(/^`{2,}[^\n]*\n([\s\S]*?)\n`{2,}\s*$/)
  if (fence?.[1] !== undefined) text = fence[1].trim()
  const quoted = text.match(/^"([\s\S]+)"$/) ?? text.match(/^“([\s\S]+)”$/)
  if (quoted?.[1] !== undefined) text = quoted[1].trim()
  if (text === '') return { ok: false, reason: 'the model returned no text' }
  if (text.length > maxChars) return { ok: false, reason: `the answer is ${text.length} characters, over the ${maxChars}-char cap` }
  return { ok: true, text }
}

/**
 * The watermarks this surface caches per session: the seq of the last surface
 * event at generation. A new completed turn moves the seq and retires the
 * suggestion; a restart simply loses the cache (it is a convenience, never truth).
 */
export function createPromptSurface(deps: PromptDeps): PromptSurface {
  const cache = new Map<string, { text: string; seq: number }>()
  const inflight = new Map<string, Promise<PromptSuggestionResult>>()

  const refuse = (reason: string, quiet = false): PromptSuggestionResult => ({ ok: false, text: reason, ...(quiet ? { quiet: true } : {}) })

  const effective = (): { spec: string; source: 'override' | 'config' | 'unset' } =>
    effectivePromptSpec(deps.getSetting(PROMPT_SETTING_KEY), deps.config.model)

  // #188: one resolution for BOTH the run path and `limits()` — stored beside the model, then the
  // model's real window by ratio, then config. Two ladders would drift; one cannot.
  const resolveLimits = async (route: PromptRoute | null): Promise<PromptLimits & { sources: PromptLimitSources }> => {
    const storedMax = deps.getSetting(PROMPT_MAXCHARS_KEY)
    const storedCtx = deps.getSetting(PROMPT_CONTEXTCHARS_KEY)
    let window: number | null = null
    if (route !== null && deps.resolveWindow !== undefined) {
      try { window = await deps.resolveWindow(route) } catch { window = null }
    }
    return resolvePromptLimits({
      config: { maxChars: deps.config.maxChars, contextChars: deps.config.contextChars, contextRatio: deps.config.contextRatio },
      window,
      stored: {
        ...(storedMax !== undefined ? { maxChars: storedMax } : {}),
        ...(storedCtx !== undefined ? { contextChars: storedCtx } : {}),
      },
    })
  }

  const run = async (session: SuggestSession, seq: number): Promise<PromptSuggestionResult> => {
    const { spec } = effective()
    const { route, reason } = resolvePromptRoute(spec, deps.conversationRoute())
    if (route === null) return refuse(`prompt suggestions cannot run: ${reason ?? 'no route'}`)
    let input: string
    let chaptersCount = 0
    // Defaults, so a refusal inside the try still leaves a truthful cap for the retry line.
    let limits: PromptLimits = { maxChars: deps.config.maxChars, contextChars: deps.config.contextChars }
    try {
      const chapters = await deps.chaptersOf(session)
      chaptersCount = chapters.length
      limits = await resolveLimits(route)
      const lastTurn = lastTurnFromEvents(session.events)
      const rules = deps.rulesOf !== undefined ? await deps.rulesOf(session) : ''
      const plan = deps.planOf !== undefined ? await deps.planOf(session) : ''
      const built = buildSuggestInput({
        ...(session.title !== undefined ? { title: session.title } : {}),
        ...(session.goalDirective !== undefined ? { goalDirective: session.goalDirective } : {}),
        ...(plan !== '' ? { plan } : {}),
        ...(rules !== '' ? { rules } : {}),
        chapters,
        lastTurn,
      }, limits.contextChars, limits.maxChars)
      if ('refusal' in built) return refuse(`no recommendation: ${built.refusal}`)
      input = built.input
    } catch (error) {
      return refuse(`could not assemble the context: ${String((error as Error)?.message ?? error).slice(0, 160)}`)
    }
    const cap = `Remember: reply with ONLY the suggested prompt, plain text, at most ${limits.maxChars} characters.`
    try {
      let text = await deps.fetch(input, route)
      let verdict = validateSuggestion(text, limits.maxChars)
      if (!verdict.ok) {
        deps.warn?.(`prompt retry (${verdict.reason}) after ${chaptersCount} chapter(s) + last turn`)
        text = await deps.fetch(`${input}\n${cap}`, route)
        verdict = validateSuggestion(text, limits.maxChars)
      }
      if (!verdict.ok) return refuse(`no recommendation: ${verdict.reason}`)
      cache.set(session.id, { text: verdict.text, seq })
      return { ok: true, text: verdict.text }
    } catch (error) {
      const message = `prompt model call failed: ${String((error as Error)?.message ?? error).slice(0, 160)}`
      deps.warn?.(message)
      return refuse(message)
    }
  }

  return {
    effective,

    async setModel(spec) {
      if (spec === null) await deps.deleteSetting(PROMPT_SETTING_KEY)
      else await deps.putSetting(PROMPT_SETTING_KEY, spec.trim())
      cache.clear()
      inflight.clear()
    },

    async suggest(session) {
      const { spec } = effective()
      if (spec === '') return refuse('prompt suggestions are off — enable with /chapters-prompt model <provider/model>', true)
      const events = session.events
      if (events.length === 0) return refuse('nothing to recommend yet — the session has no surface events', true)
      // #113: the cache key is the COMPLETED TURN, not the last surface event. A turn is many events — every
      // step appends one — so an event-scoped key missed on each step and asked the model again, which is how
      // one turn produced three different suggestions for the maintainer. Inside a turn the human sees one
      // stable offer; a new turn is a new question.
      let turnSeq = -1
      for (const ev of events) { if (ev.type === 'turn/end' && ev.seq > turnSeq) turnSeq = ev.seq }
      const tail = tailFromEvents(events)
      if (!tail.some((m) => m.role === 'assistant')) return refuse('nothing to recommend yet — no completed assistant turn', true)
      const fresh = cache.get(session.id)
      if (fresh !== undefined && fresh.seq === turnSeq) return { ok: true, text: fresh.text }
      const pending = inflight.get(session.id)
      if (pending !== undefined) return await pending
      const job = run(session, turnSeq).finally(() => { inflight.delete(session.id) })
      inflight.set(session.id, job)
      return await job
    },

    limits: (route) => resolveLimits(route),
    setCaps: async (opts) => {
      if (opts.maxChars !== undefined) {
        if (opts.maxChars === null || opts.maxChars === '') await deps.deleteSetting(PROMPT_MAXCHARS_KEY)
        else await deps.putSetting(PROMPT_MAXCHARS_KEY, opts.maxChars)
      }
      if (opts.contextChars !== undefined) {
        if (opts.contextChars === null || opts.contextChars === '') await deps.deleteSetting(PROMPT_CONTEXTCHARS_KEY)
        else await deps.putSetting(PROMPT_CONTEXTCHARS_KEY, opts.contextChars)
      }
    },
    statusLine() {
      const { spec, source } = effective()
      if (spec === '') return `Prompt suggestions: OFF${source === 'override' ? ' (explicitly off — /chapters-prompt model <provider/model> to enable)' : ' — enable with /chapters-prompt model <provider/model>'}`
      return `Prompt suggestions: ON — ${spec} (${source}; the composer ghost offers its answer, accepted only by your keystroke)`
    },
  }
}

/** Narrow slice: what `registerHostCommands` needs from the surface. */
export type PromptCommandSurface = PromptSurface

/** Active chapters of one registry row, mapped to the facts the input uses. */
export function promptChaptersOf(state: SessionState): { number: number; title: string; summary: string }[] {
  return state.chapters.filter(isActiveChapter).map((c) => ({ number: c.number, title: c.title, summary: c.summary }))
}

/**
 * The ancestor path's chapters with their plots (#188), oldest line first. `rows` is the lineage
 * root-first INCLUDING the live session; `readBody` fetches one chapter's archived bytes so the
 * plots come out of the durable archive itself — deterministic, zero model tokens, and it works on
 * chapters archived before this feature existed. A body that cannot be read contributes its index
 * facts with no plots: a missing file degrades the trajectory, never the assembly.
 */
export function promptChaptersForLineage(opts: {
  rows: { chapters: SessionState['chapters'] }[]
  readBody: (path: string) => string | null
}): ChapterHistoryEntry[] {
  const out: ChapterHistoryEntry[] = []
  for (const row of opts.rows) {
    for (const c of row.chapters.filter(isActiveChapter)) {
      const body = opts.readBody(c.path) ?? ''
      out.push({ number: c.number, title: c.title, summary: c.summary, plots: body === '' ? [] : extractPlots(body) })
    }
  }
  return out
}
