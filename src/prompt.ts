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
import { isHumanAuthored, screenConversation, stripReminderSpans } from './injections.ts'
import { isActiveChapter, type SessionState } from './registry.ts'
import type { SessionEventLike } from './types.ts'

/** The stored override key (durable kv, same table as `enrichment.model`). */
export const PROMPT_SETTING_KEY = 'prompt.model'
// #505: the autorun round ceiling rides the SAME settings mechanism as the model overrides
// (putSetting/getSetting; empty = fall through to config). Default UNLIMITED: the maintainer's
// rule — no cap nobody can raise at runtime; the real brakes are structural (one round per
// offer, human displacement, the goal's lifecycle).
export const ROUNDS_SETTING_KEY = 'prompt.maxRounds'

/** #505: effective rounds cap, precedence override > config; cap <= 0 = unlimited.
 *  One pure predicate for the loop, the verb and the status — never three readings. */
export function effectiveRoundsCap(settingVal: string | undefined | null, configVal: number | undefined): { cap: number; source: 'override' | 'config' } {
  const raw = (settingVal ?? '').trim()
  if (raw === 'unlimited') return { cap: 0, source: 'override' }
  if (raw !== '') {
    const n = Number(raw)
    if (Number.isInteger(n) && n > 0) return { cap: n, source: 'override' }
  }
  return Number.isInteger(configVal) && (configVal as number) > 0
    ? { cap: configVal as number, source: 'config' }
    : { cap: 0, source: 'config' }
}

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
  /** #505: config fallback for the rounds cap; 0 or absent = unlimited (the shipped default). */
  maxRounds?: number | undefined
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
  /** #505: the EFFECTIVE autorun rounds cap with its source; cap <= 0 = unlimited. */
  roundsCap(): { cap: number; source: 'override' | 'config' }
  /** #505: stored override ('unlimited' | positive int string | '' = fall to config). */
  setRoundsCap(v: string | null): Promise<void>
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
export function tailFromEvents(events: SessionEventLike[]): TailEntry[] {
  const out: TailEntry[] = []
  for (const ev of events) {
    const data = (ev.data ?? {}) as Record<string, unknown>
    if (ev.type === 'user/message') {
      const screen = screenConversation(data, textOfBlocks(data.content), 'user')
      if (screen.omittedEvent) continue
      const text = stripReminderSpans(screen.text).text.trim()
      // #340: keep provenance. A tail entry can be role 'user' and still NOT be the human speaking —
      // injections.ts deliberately keeps subagent-settled notices, agent-message relays, plan-mode
      // flips and chapters' own offers as conversation. Anything downstream that asks "where did the
      // human's turn begin?" must not mistake one of those for the request.
      if (text !== '') out.push({ role: 'user', text, human: isHumanAuthored(data) })
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
 * One turn of the conversation as the director sees it.
 * `human` is true only for a message the human actually typed. Role 'user' alone does not say that:
 * `injections.ts` deliberately keeps some narration as conversation, and #340 needs the difference.
 */
export interface TailEntry { role: 'user' | 'assistant'; text: string; human?: boolean }

/**
 * The LAST turn, whole (#188): from the final human request through every assistant text that
 * followed it. Reuses the tail's defusing machinery (host-injected context screened, reminder spans
 * stripped) and then keeps only the closing exchange — the present the director must follow from.
 * Never sliced: a message enters whole or the assembly refuses.
 *
 * #340: the cut is at the last HUMAN-AUTHORED entry, not the last role-`user` one. Narration the
 * screen keeps as conversation (a subagent-settled notice, an `agent-message` relay whose whole text
 * is often just "Continue") used to START the block, so the human's own request was cut out of the
 * director's input entirely. Measured over every turn of three real sessions: 22 of 152 on platfolio
 * (14%), 6 of 311 on arcnexus, 1 of 3 here. The kept block still contains that narration — it is
 * conversation — it just can no longer stand in for the request.
 */
export function lastTurnFromEvents(events: SessionEventLike[]): TailEntry[] {
  const tail = tailFromEvents(events)
  let from = -1
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i]!.role === 'user' && tail[i]!.human === true) { from = i; break }
  }
  // No human turn at all (a session driven by relays and goal rounds alone): fall back to the whole
  // tail rather than an empty block. An empty "Last turn" tells the director nothing exists.
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
 * #350 — the smallest `drop` in `[0, chapterCount]` with `lengthOf(drop) <= budget`, or null if none.
 *
 * `lengthOf` is non-increasing except for one wrinkle the caller cannot remove: the announced
 * "older chapters dropped: N" note gains a character when N crosses a digit boundary. A pure binary
 * search could therefore skip a fitting value that is one past the found one, so the candidate is
 * confirmed with a bounded linear step. The result is the SAME value the previous linear scan returned,
 * for ceil(log2(n)) + a couple of evaluations instead of n + 1 — and it is tested that way, against a
 * naive oracle over randomized length functions including deliberate digit-boundary sawtooths.
 */
export function firstFitDrop(
  lengthOf: (drop: number) => number,
  chapterCount: number,
  budget: number,
): number | null {
  let lo = 0
  let hi = chapterCount + 1 // exclusive upper bound: `chapterCount + 1` means "nothing fitted"
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (lengthOf(mid) <= budget) hi = mid
    else lo = mid + 1
  }
  if (lo > chapterCount) return null
  // A binary search is exact for a NON-INCREASING lengthOf and cannot be made exact for an arbitrary
  // one — an earlier fit separated by an unfit value is invisible to it (a walk-back stops at the gap).
  // So the precondition is asserted rather than assumed: see the monotonicity row in
  // tests/unit/prompt-assembly-cost.test.ts, which proves the real assembly length never rises as more
  // chapters drop. One cheap boundary check below guards the assumption at runtime and falls back to the
  // linear scan if a future change ever breaks it, so the worst case is the old behaviour, never a wrong
  // answer.
  if (lengthOf(lo) > budget) return linearFirstFit(lengthOf, chapterCount, budget)
  // The realistic violation is the announced-drop note gaining a character just left of `lo`, which a
  // single neighbour check detects exactly. A separated earlier fit cannot be detected locally, which is
  // why the precondition is tested rather than probed.
  if (lo > 0 && lengthOf(lo - 1) <= budget) return linearFirstFit(lengthOf, chapterCount, budget)
  return lo
}

/** The pre-#350 search, kept as the exact fallback for a length function that is not near-monotone. */
function linearFirstFit(lengthOf: (drop: number) => number, chapterCount: number, budget: number): number | null {
  for (let d = 0; d <= chapterCount; d++) if (lengthOf(d) <= budget) return d
  return null
}

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
/** Fraction of the director's budget the chapter block may occupy when the caller does not say (#379). */
export const DEFAULT_CHAPTERS_SHARE = 0.25

/**
 * #379: absolute ceiling on the director's chapter block, in characters, whatever the budget allows
 * (~50K est tokens). A share of a window-derived budget is unbounded in absolute terms: on a 1M-token
 * route 25% is half a megabyte of old summaries. Sized so a session with hundreds of chapters still
 * shows a real trajectory — measured: 40 chapters of 2 KB summaries still fits, 800 do not.
 */
export const DEFAULT_CHAPTERS_CAP_CHARS = 200_000

export function buildSuggestInput(
  facts: SuggestFacts,
  budgetChars: number,
  maxChars: number,
  /** #379: cap on the chapter block as a fraction of `budgetChars`, independent of whether the total
   *  would fit. Letting the window set the budget alone is what made the block dominate it. */
  chaptersShare: number = DEFAULT_CHAPTERS_SHARE,
): { input: string } | { refusal: string } {
  const head = 'You are the second reader of a DSH session — a model that DEFINES the next step and never executes it.'
  const replyRules = `Write the ONE next prompt the human should paste into the composer. It MUST be a message the WORKER MODEL in this session receives and can act on with its own tools, files, and commands. The test: if this exact text arrived as a user message in the worker's context, could the worker act on it directly? Sentences only the human could perform — typing a slash command the host intercepts, opening a UI, clicking this bar, choosing between options — are wrong; the live failure this forbids was "run /chapters-prompt suggest and report the output". Telling the model to run tests, execute commands, fix a file, or investigate is exactly right ('run the tests', 'fix the flake in X first'); advice to the user ('you should consider', 'I recommend') and echoing the conversation's last instruction are not. It must also be FORWARD: name a next step that has NOT YET BEGUN — never a restatement of the work this session is already doing. A live sample failed exactly this, proposing "Create the #273 echo-adjacency issue and run the pre-change sampler" while the issue was filed and the sampler running; describing the in-flight task is a mirror, not a director. The same trap in the archive's clothing: a live generator offered "Check whether bash-32 has completed the 0.2.26 release chain" only because an archived chapter quoted that work as an OPEN REQUEST — quoted past phrasing is not current state; a step the chapter history describes as dispatched, merged, published, or awaited is PAST, not next. If the session is mid-task, recommend what comes AFTER that task lands — its verification, its follow-up — or a different line of work the latest state plainly calls for. A single imperative request; plain text; at most ${maxChars} characters; no preamble, no quotes, no markdown; it must follow from the latest state and advance the session's actual work — propose nothing already done. Reply with ONLY that prompt. The GOAL: prefix is legal ONLY when the goal block above names an ACTIVE goal and this step re-cuts that objective (only the human can send those; autorun will not). With no active goal named, NEVER use the prefix — not for wording about closing out, completing, or ending a purpose; proposing to "close out this release cycle" stamped GOAL: in a session with no goal is the live mis-stamp this forbids. An ordinary next step takes no prefix even when a goal is active.`
  // #379: the chapter block gets its OWN cap, as a share of the budget, independent of whether the
  // whole assembly would fit. Until now the block could grow to consume everything the window allowed,
  // and on a 1M-token route `contextChars` is ~2,000,000 chars — so the director was handed megabytes of
  // old summaries to write one sentence, with the newest human turn at roughly one character in two
  // million (#7's third mechanism). Recency should be structural, not a hope that the block is small.
  const share = chaptersShare > 0 && chaptersShare <= 1 ? chaptersShare : DEFAULT_CHAPTERS_SHARE
  const chaptersCap = Math.max(0, Math.floor(budgetChars * share))
  const CHAPTERS_HEADER = '## Where it has been (chapters, oldest first — title, summary, and the plots that carry the trajectory)'
  const NO_CHAPTERS_LINE = '## Where it has been (no chapters yet)'
  // #317 — the tense label. The bytes in this section are archived renderings of PAST turns;
  // several of those bytes are phrased as open work ("OPEN REQUEST", TODO, "awaiting X"), and at
  // boundary 8316 the generator faithfully offered one of them as the next step ("Check whether
  // bash-32 has completed the 0.2.26 release chain"). Truthful quoting, wrong tense, and the
  // input itself was the only place the tense could have been marked. One line, inside the
  // section, before any chapter content.
  const TENSE_LINE = 'This section is PAST — an archive quoting what already happened. Blocks phrased as open work (OPEN REQUEST, TODO, "awaiting X") are history, not pending items: never offer work the archive describes as dispatched, merged, published, or awaiting a notification; the next step must be beyond everything shown here.'

  const chapterBlock = (dropOldest: number): string[] => {
    const cs = facts.chapters.slice(dropOldest)
    if (cs.length === 0) return [NO_CHAPTERS_LINE]
    const out = [CHAPTERS_HEADER, TENSE_LINE]
    for (const c of cs) {
      out.push(`${c.number}. ${c.title} — ${c.summary}`)
      if (c.plots.length > 0) {
        out.push('   Plots:')
        for (const pl of c.plots) out.push(`   - ${pl}`)
      }
    }
    return out
  }

  // Everything outside the chapter block, held as the SAME arrays the final string is built from, so the
  // measurement below cannot describe a different document than assemble() emits. Their size is bounded
  // by the reply rules and the human's turn — never by archive volume — so materialising them is cheap.
  const preItems: string[] = [
    head,
    '',
    `## Session${facts.title !== undefined && facts.title !== '' ? `: ${facts.title}` : ''}`,
    ...(facts.goalDirective !== undefined && facts.goalDirective !== '' ? ['', String(facts.goalDirective)] : []),
    ...(facts.plan !== undefined && facts.plan !== '' ? ['', '## Active plan', String(facts.plan)] : []),
    ...(facts.rules !== undefined && facts.rules !== '' ? ['', '## Standing orders', String(facts.rules)] : []),
    '',
  ]
  const lastTurnItems: string[] = facts.lastTurn.length > 0
    ? ['## Last turn (request through final response)',
      ...facts.lastTurn.map((m) => m.role === 'user' ? 'Human: ' + m.text : 'Assistant: ' + m.text)]
    : ['## Last turn (empty)']
  const dropNote = (dropOldest: number): string =>
    `(older chapters dropped to fit the ${budgetChars}-char budget: ${dropOldest} chapter(s) — the recent trajectory leads)`
  const tailItems = (dropOldest: number): string[] => [
    ...lastTurnItems,
    ...(dropOldest > 0 ? [dropNote(dropOldest)] : []),
    '',
    replyRules,
  ]
  const joinedLen = (items: readonly string[]): number =>
    items.length === 0 ? 0 : items.reduce((m, x) => m + x.length, 0) + items.length - 1
  const preLen = joinedLen(preItems)
  const tailLen = (d: number): number => joinedLen(tailItems(d))

  // The chapter block is the only part large enough to be worth measuring WITHOUT building it (#350's
  // residual 136 ms was constructing tens of megabytes once per probe). Chapter k renders as one line,
  // plus a '   Plots:' line and one line per plot when it has plots; the separators between those items
  // belong to the chapter's own length. This arithmetic is checked against assemble() for EVERY drop
  // value in tests/unit/prompt-assembly-cost.test.ts — a shortcut that disagrees with the bytes is worse
  // than the slow version it replaces.
  const chapterLens = facts.chapters.map((c) => {
    const headChars = String(c.number).length + 2 + c.title.length + 3 + c.summary.length
    const plotChars = c.plots.length === 0 ? 0 : 9 + c.plots.reduce((m, pl) => m + 5 + pl.length, 0)
    const items = 1 + (c.plots.length > 0 ? 1 + c.plots.length : 0)
    return { joined: headChars + plotChars + Math.max(0, items - 1), items }
  })
  const nChapters = facts.chapters.length
  const suffixJoined: number[] = new Array<number>(nChapters + 1).fill(0)
  const suffixItems: number[] = new Array<number>(nChapters + 1).fill(0)
  for (let k = nChapters - 1; k >= 0; k--) {
    suffixJoined[k] = suffixJoined[k + 1]! + chapterLens[k]!.joined
    suffixItems[k] = suffixItems[k + 1]! + chapterLens[k]!.items
  }
  const blockLen = (d: number): number => d >= nChapters
    // #317: the assembled block is HEADER \n TENSE_LINE \n rows — the tense label is a block item
    // on BOTH sides of the arithmetic, or the drop ladder budgets bytes that are not there.
    ? NO_CHAPTERS_LINE.length
    : CHAPTERS_HEADER.length + TENSE_LINE.length + 2 + suffixJoined[d]! + (suffixItems[d]! - 1)
  const measure = (d: number): number => preLen + 1 + blockLen(d) + 1 + tailLen(d)

  const assemble = (dropOldest: number): string =>
    [...preItems, ...chapterBlock(dropOldest), ...tailItems(dropOldest)].join('\n')

  // #350/#379: the joint constraint — total within budget AND the chapter block within its own cap.
  // Both terms are non-increasing in `drop`, so their maximum is, and firstFitDrop remains valid. The
  // block term is `block <= cap` restated on the total's scale: `block + (budget - cap) <= budget`.
  // #379, and a correction made from measurement rather than taste. Bounding history at a share of the
  // BUDGET is not enough on its own (a 1M-token route's 2,000,000-char budget makes 25% still half a
  // megabyte beside a few thousand characters of newest turn). My first attempt bounded it RELATIVE TO
  // THE PROTECTED CONTENT instead — and measured the result: the director's whole input collapsed to
  // 2 KB, because the protected set is mostly fixed reply rules, so "25% of everything else" allowed
  // about one chapter line. That satisfies a recency ratio by destroying the context the director
  // exists to weigh, which is the wrong fix arrived at by the right arithmetic.
  //
  // So: share of the budget, AND an absolute ceiling. The ceiling is what actually bounds the
  // large-window case (a ~50K-token history block), it does not shrink when a session's last turn is
  // short, and recency is protected by what genuinely protects it — the last turn enters WHOLE and is
  // never sliced (#188), plus the block being unable to exceed either bound.
  const effectiveCap = Math.min(chaptersCap, DEFAULT_CHAPTERS_CAP_CHARS)
  const required = (d: number): number => Math.max(measure(d), blockLen(d) + (budgetChars - effectiveCap))
  const drop = firstFitDrop(required, nChapters, budgetChars)
  if (drop !== null) return { input: assemble(drop) }
  const floor = assemble(facts.chapters.length).length
  return {
    refusal: `the suggestion input cannot fit — the protected context (goal, plan, rules, last turn) assembles to ${floor} chars, exceeding the ${budgetChars}-char budget with all ${nChapters} chapter(s) already dropped; the chapter block was capped at ${effectiveCap} chars (${Math.round(share * 100)}% of the budget, ceiling ${DEFAULT_CHAPTERS_CAP_CHARS} chars). Refusing rather than truncating (#188): raise the budget or set a larger model with /chapters-prompt model.`,
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
  if (text === '') return { ok: false, reason: 'the call completed with no text blocks' }
  if (text.length > maxChars) return { ok: false, reason: `the answer is ${text.length} characters, over the ${maxChars}-char cap` }
  return { ok: true, text }
}

/**
 * The watermarks this surface caches per session.
 *
 * The doc above this function used to say "the seq of the last surface event at generation". It never
 * was — the key was the last `turn/end` seq, which is what #113 wanted (one offer per completed turn,
 * not one per step) and simultaneously what #340 made stale: a human message arriving after that
 * boundary could not retire the cached offer, so `/chapters-prompt suggest` mid-turn answered with the
 * PREVIOUS turn's text even though the log held a newer request.
 *
 * The key is now the pair (last turn boundary, newest human turn). Both are stable for every step
 * inside a turn — so #113's guarantee, "inside a turn the human sees one stable offer", is unchanged
 * and a turn still cannot generate three suggestions — while anything the human says (including a
 * message spliced into the running turn) advances the second half and retires the offer. A restart
 * simply loses the cache: it is a convenience, never truth.
 */
export interface SuggestCacheEntry { text: string, seq: number, humanSeq: number }

/** The newest seq of a HUMAN-authored `user/message`, or -1. Distinct from `turn/end`: a message the
 *  human sent has no boundary yet. */
export function lastHumanTurnSeq(events: readonly SessionEventLike[]): number {
  let seq = -1
  for (const ev of events) {
    if (ev.type !== 'user/message') continue
    if (!isHumanAuthored((ev.data ?? {}) as Record<string, unknown>)) continue
    if (typeof ev.seq === 'number' && ev.seq > seq) seq = ev.seq
  }
  return seq
}

export function createPromptSurface(deps: PromptDeps): PromptSurface {
  const cache = new Map<string, SuggestCacheEntry>()
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

  const run = async (session: SuggestSession, key: { seq: number, humanSeq: number }): Promise<PromptSuggestionResult> => {
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
      cache.set(session.id, { text: verdict.text, seq: key.seq, humanSeq: key.humanSeq })
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

    roundsCap() {
      // #505: one resolution for the loop, the verb and the status — never three readings.
      return effectiveRoundsCap(deps.getSetting(ROUNDS_SETTING_KEY), deps.config.maxRounds)
    },
    async setRoundsCap(v) {
      await deps.putSetting(ROUNDS_SETTING_KEY, v ?? '')
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
      // #340: BOTH halves must match. The turn boundary alone was stable across a new human message,
      // which is how a mid-turn `/chapters-prompt suggest` returned the previous turn's offer.
      const humanSeq = lastHumanTurnSeq(events)
      const fresh = cache.get(session.id)
      if (fresh !== undefined && fresh.seq === turnSeq && fresh.humanSeq === humanSeq) return { ok: true, text: fresh.text }
      const pending = inflight.get(session.id)
      if (pending !== undefined) return await pending
      const job = run(session, { seq: turnSeq, humanSeq }).finally(() => { inflight.delete(session.id) })
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
/**
 * #225: the STATUS plane may ask for more than the command surface carries — `planeStatus` and
 * `sessionRow` are provided by the wiring (index.ts) when it owns the transport/door facts. Typed
 * as an extension so the commands layer can feature-check them honestly.
 */
export interface PromptStatusExtras {
  planeStatus(): string[]
  sessionRow(sessionId: string): Promise<string>
}

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
  // #350: ONE entry per chapter path. The registry holds rows that carry copies of their parent's
  // entries — measured 391 identical number+path records in this machine's live store, and a call
  // `includeLineage: true` returned 507 rows for 56 distinct paths. Without this, up to 43% of the
  // director's chapter block was the same text repeated, and the same file was read from disk once per
  // duplicate: 419 bodies / 19 MB synchronously per turn boundary.
  //
  // Deduped by PATH, not number — the same rule the TOC accumulation uses (engine-core.ts:214), because
  // numbers repeat across roots while a path names one file. Keeping the two decisions on one key is the
  // point: the archive an operator reads and the input the director is given cannot drift apart.
  const seen = new Set<string>()
  const plotsByPath = new Map<string, string[]>()
  for (const row of opts.rows) {
    for (const c of row.chapters.filter(isActiveChapter)) {
      if (seen.has(c.path)) continue
      seen.add(c.path)
      // One read per distinct body, and a body already seen is never re-parsed.
      let plots = plotsByPath.get(c.path)
      if (plots === undefined) {
        const body = opts.readBody(c.path) ?? ''
        plots = body === '' ? [] : extractPlots(body)
        plotsByPath.set(c.path, plots)
      }
      out.push({ number: c.number, title: c.title, summary: c.summary, plots })
    }
  }
  return out
}
