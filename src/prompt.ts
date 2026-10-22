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

export interface PromptSuggestionResult { ok: boolean; text: string }

export interface PromptConfig {
  /** config default for the model; '' ⇒ off unless a stored override says otherwise. */
  model: string
  /** hard total budget on the assembled input slice. */
  contextChars: number
  /** cap on the accepted recommendation; over-cap is invalid, never truncated. */
  maxChars: number
}

export interface PromptDeps {
  getSetting(key: string): string | undefined
  putSetting(key: string, value: string): Promise<void>
  deleteSetting(key: string): Promise<void>
  /** Active chapter records for the calling session's registry row (never the
   *  ancestor walk — the live tail carries the immediate context; this is the
   *  economy, and the choice is documented at the site that reads it). */
  chaptersOf(sessionId: string): Promise<{ number: number; title: string; summary: string }[]>
  config: PromptConfig
  /** The last route the conversation used on this plane, or null. */
  conversationRoute(): PromptRoute | null
  /** One auxiliary completion; may reject — `suggest` catches and refuses honestly. */
  fetch(prompt: string, route: PromptRoute): Promise<string>
  warn?(msg: string): void
}

/** A live session as the command hands it over: id, an optional title, and the
 *  surface events (what the working model sees — the same view the defining model reads). */
export interface SuggestSession { id: string; title?: string | undefined; events: SessionEventLike[] }

/** The surface the host command and `/chapters-status` speak to. */
export interface PromptSurface {
  /** Effective spec after precedence; '' ⇒ OFF. */
  effective(): { spec: string; source: 'override' | 'config' | 'unset' }
  setModel(spec: string | null): Promise<void>
  suggest(session: SuggestSession): Promise<PromptSuggestionResult>
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

export interface SuggestFacts {
  title?: string | undefined
  chapters: { number: number; title: string; summary: string }[]
  tail: { role: 'user' | 'assistant'; text: string }[]
}

/** One message's inline budget before its own ellipsis — the cap is a cap, the
 *  ellipsis says so (loudness, #61). */
const MESSAGE_INLINE_CHARS = 500

/**
 * Assemble the auxiliary input: deterministic (same facts ⇒ same bytes), hard
 * total ≤ `capChars`. Oldest chapter lines drop first, then oldest tail
 * messages; every drop is ANNOUNCED in the input itself — a silent squeeze
 * would make the answer look derived from bytes that were never sent.
 */
export function buildSuggestInput(facts: SuggestFacts, capChars: number, maxChars: number): string {
  const chapters = [...facts.chapters]
  let tail = [...facts.tail]
  let droppedChapters = 0
  let droppedTail = 0
  let msgCap = MESSAGE_INLINE_CHARS
  const perMessage = (t: string) => (t.length > msgCap ? `${t.slice(0, msgCap - 1)}…` : t)
  const render = (announce: string): string => {
    const head = `You are the second reader of a DSH session — a model that DEFINES the next step and never executes it.`
    const rules = `Write the ONE next prompt the human should send. A single imperative request; plain text; at most ${maxChars} characters; no preamble, no quotes, no markdown; it must follow from the latest state and propose nothing already done. Reply with ONLY that prompt.`
    const parts = [
      head,
      '',
      `## Session${facts.title !== undefined && facts.title !== '' ? `: ${facts.title}` : ''}`,
      '',
      chapters.length > 0 ? '## Where it has been (chapters)' : '## Where it has been (no chapters yet)',
      ...chapters.map((c) => `${c.number}. ${c.title} — ${c.summary}`),
      '',
      tail.length > 0 ? '## Live tail (oldest first)' : '## Live tail (empty)',
      ...tail.map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${perMessage(m.text)}`),
    ]
    if (announce !== '') parts.push(announce)
    parts.push('', rules)
    return parts.join('\n')
  }
  // Trim to budget: chapters are the compressible past; the tail is the present.
  // The ladder has a floor: a `capChars` smaller than the fixed skeleton (persona +
  // section headers + reply rule) cannot be met by dropping — the last arm returns
  // the skeleton as-is. The documented default (4000) is far above it.
  for (;;) {
    const announce = droppedChapters + droppedTail === 0
      ? ''
      : `\n(older context dropped to fit the ${capChars}-char budget: ${droppedChapters} chapter line(s), ${droppedTail} message(s))`
    const input = render(announce)
    if (input.length <= capChars) return input
    if (chapters.length > 0) { chapters.shift(); droppedChapters += 1; continue }
    if (tail.length > 1) { tail.shift(); droppedTail += 1; continue }
    if (msgCap > 40) { msgCap = Math.max(40, Math.floor(msgCap / 2)); continue }
    if (tail.length === 1) { tail = []; droppedTail += 1; continue }
    return input
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

  const refuse = (reason: string): PromptSuggestionResult => ({ ok: false, text: reason })

  const effective = (): { spec: string; source: 'override' | 'config' | 'unset' } =>
    effectivePromptSpec(deps.getSetting(PROMPT_SETTING_KEY), deps.config.model)

  const run = async (session: SuggestSession, seq: number): Promise<PromptSuggestionResult> => {
    const { spec } = effective()
    const { route, reason } = resolvePromptRoute(spec, deps.conversationRoute())
    if (route === null) return refuse(`prompt suggestions cannot run: ${reason ?? 'no route'}`)
    let input: string
    let chaptersCount = 0
    try {
      const chapters = await deps.chaptersOf(session.id)
      chaptersCount = chapters.length
      const tail = tailFromEvents(session.events)
      input = buildSuggestInput({ title: session.title, chapters, tail }, deps.config.contextChars, deps.config.maxChars)
    } catch (error) {
      return refuse(`could not assemble the context: ${String((error as Error)?.message ?? error).slice(0, 160)}`)
    }
    const cap = `Remember: reply with ONLY the suggested prompt, plain text, at most ${deps.config.maxChars} characters.`
    try {
      let text = await deps.fetch(input, route)
      let verdict = validateSuggestion(text, deps.config.maxChars)
      if (!verdict.ok) {
        deps.warn?.(`prompt retry (${verdict.reason}) after ${chaptersCount} chapter line(s) + tail`)
        text = await deps.fetch(`${input}\n${cap}`, route)
        verdict = validateSuggestion(text, deps.config.maxChars)
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
      if (spec === '') return refuse('prompt suggestions are off — enable with /chapters-prompt model <provider/model>')
      const events = session.events
      if (events.length === 0) return refuse('nothing to recommend yet — the session has no surface events')
      const seq = events[events.length - 1]!.seq
      const tail = tailFromEvents(events)
      if (!tail.some((m) => m.role === 'assistant')) return refuse('nothing to recommend yet — no completed assistant turn')
      const fresh = cache.get(session.id)
      if (fresh !== undefined && fresh.seq === seq) return { ok: true, text: fresh.text }
      const pending = inflight.get(session.id)
      if (pending !== undefined) return await pending
      const job = run(session, seq).finally(() => { inflight.delete(session.id) })
      inflight.set(session.id, job)
      return await job
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
