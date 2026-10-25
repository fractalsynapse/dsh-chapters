/**
 * The one boundary that decides which bytes of the durable log are CONVERSATION
 * and which are host-injected context (knowledge-repo.md §15 amendment,
 * "host-injected context is not conversation").
 *
 * Why this exists: the harness injects project context — workspace instruction
 * files (whatever a given project's AGENTS.md holds), the runtime-context
 * snapshot, the skill catalog — and injected events arrive in the log either as
 * their own `user/message` (source.kind `agent-instructions`, `plugin`, …) or
 * riding INSIDE human messages as `<system-reminder>` spans. A target project's
 * instruction text is that project's business: it must not be archived into the
 * shared knowledge corpus, searched by other workspaces, re-quoted into
 * enrichment input, or bloating a child's re-archive of its own TOC notice
 * generation after generation.
 *
 * Precedents this rule follows, not invents:
 * - `signature.ts` (r28) already excluded these events from per-turn topic
 *   signatures after measuring their poison: every signature gained the
 *   injected filenames and drowned the real topic signal.
 * - `tests/e2e/model-proxy.ts` (user decision 2026-09-20, AGENTS-BLIND) already
 *   masks the same classes for tape matching, on the same reasoning:
 *   development artifacts, every real project ships its own.
 *
 * What is NOT touched: the durable session log (invariant: append-only, always —
 * the originals live on in the parent session), and genuine conversation bytes
 * (a human typing the words "AGENTS.md" in prose is conversation and stays
 * verbatim; only the structural injected forms are removed).
 *
 * Pure module: no cordis, no fs, no network.
 */

/** A user/message is human-authored when it carries no source, or source.kind
 * 'user' (unlabelled keeps working for seeded fixtures — same rule the
 * signature layer has used since r28). Everything else — 'agent-instructions',
 * 'plugin' (the TOC notice, runtime snapshots), 'tool', 'system' — is injected
 * context, not conversation. Exported so signature.ts imports the SAME
 * predicate; the two layers must never drift on what counts as a turn. */
export function isHumanAuthored(data: Record<string, unknown>): boolean {
  const source = data.source as { kind?: string } | undefined
  return source?.kind === undefined || source.kind === 'user'
}

/**
 * The ONE targeted exception to the screen (human decision 2026-10-10): the harness's
 * own mode-switch narration — `source: { kind: 'plugin', plugin: 'plan-mode',
 * form: 'notice' }`, "The user switched this session to plan mode." — IS conversation.
 *
 * The screen exists so a project's private instruction files never travel in a shared
 * corpus. A mode flip the human performed is not that: it is a fact about THIS session,
 * and it is the seam that answers "was this approved before or after we started
 * implementing?". Named by plugin AND form, so it cannot be widened by accident into
 * the general plugin-source exemption — an instruction file or a runtime snapshot
 * arriving with a different form still screens.
 */
export function isSessionStateNarration(data: Record<string, unknown>): boolean {
  const source = data.source as { kind?: string; plugin?: string; form?: string } | undefined
  // v4 (issue #43, measured against dsh-plan-mode/lib/index.js:395-410 on
  // 0.2.0-rc.2): the producer owns the kind — `{ kind: 'plan-mode', form: 'notice' }`.
  if (source?.kind === 'plan-mode' && source.form === 'notice') return true
  // #61 Amendment B — a delegate's report is conversation about THIS session's work, not a project's
  // private bytes. Measured shapes (0.2.x logs): `{ kind: 'agent-message', form: 'relay' }` carries
  // "Agent <id> sent a message: <the result>", and `{ kind: 'subagent-settled', form: 'notice' }` is
  // when that delegate finished. The old rule screened both, which cost 44 markers / 248,150 chars
  // (~62K est tokens) in the first project built on this preset — delegated work vanished through BOTH
  // doors meant to capture it, leaving chapters that recorded a delegation with no outcome.
  // Named by producer AND form like the plan-mode arm above, so it cannot widen: the workspace
  // instruction file (`{ kind: 'agent-instructions', form: 'instructions' }`) is still screened, and
  // `isHumanAuthored` stays strict, because the topic-signature layer must not let a 2 KB report drag a
  // signature toward the filenames it mentions (record r28).
  if (source?.kind === 'agent-message' && source.form === 'relay') return true
  if (source?.kind === 'subagent-settled' && source.form === 'notice') return true
  // #113: a Suggested Next Step the human armed. It is conversation the human authorized — a chapter that
  // records an autorun response without the prompt that produced it is unexplainable — so it is captured like
  // the others. Deliberately NOT `kind: 'user'`: the host's goal tool decides "a direct human turn exists" by
  // looking for exactly that (measured, dsh-tool-goal:49-65), and laundering our loop through it would let a
  // suggestion authorize model-side goal operations. Named by producer AND form like every arm above: the TOC
  // notice (`form: 'snapshot'`) and any other plugin's message stay screened.
  if (source?.kind === 'plugin:dsh-chapters' && source.form === 'prompt-suggestion') return true
  // v3 logs, still replayed from disk: the retired wrapper the exception was
  // written against. Both arms stay named by producer AND form — neither widens.
  return source?.kind === 'plugin' && source.plugin === 'plan-mode' && source.form === 'notice'
}

/**
 * Does this event belong in the archive as conversation?
 *
 * Deliberately NARROWER than `isHumanAuthored`: the topic-signature layer keeps using
 * the strict predicate, because the r28 lesson was that injected text poisons topic
 * merging (every signature gained the injected filenames). A mode narration is one
 * short sentence, so archiving it is worth more than the risk of letting it move a
 * chapter boundary — and the two uses are separate functions on purpose.
 */
export function isArchivableConversation(data: Record<string, unknown>): boolean {
  return isHumanAuthored(data) || isSessionStateNarration(data)
}

/** Label for the omission marker: kind, plus plugin name when the source
 * carries one (so `plugin:dsh-chapters` is recognizable in a chapter). */
export function sourceLabel(data: Record<string, unknown>): string {
  const source = data.source as { kind?: string; plugin?: string; form?: string } | undefined
  if (source === undefined) return 'unlabelled'
  if (source.kind === 'plugin:dsh-chapters' && source.form === 'prompt-suggestion') return 'suggested-prompt'
  return source.kind === 'plugin' && typeof source.plugin === 'string'
    ? `plugin:${source.plugin}`
    : String(source.kind ?? 'unknown')
}

/**
 * The structural injection span. Anchored on the exact harness tag, case
 * sensitive (the tape's own skill-catalog rule is case sensitive for the same
 * reason: ordinary prose quoting the tag is vanishingly rare, and the cost of a
 * false positive is a marked, countable omission — never a silent rewrite of
 * history, the original bytes stay in the session log). The unclosed-tail form
 * `[\s\S]*?(</system-reminder>|$)` mirrors the tape's masking of truncated
 * injections.
 */
/**
 * The ONE predicate for "this text is host-injected context, not something the human wrote".
 *
 * `source.kind` remains the primary gate (`isHumanAuthored`, `screenConversation`) — but some consumers
 * see only flattened provider text with NO source at all, first among them `deriveIdentity` choosing a
 * chapter TITLE. Until #59 that path carried a private regex (`HARNESS_PROSE`) that had silently fallen
 * behind the host's injected kinds, so a `time-context` snapshot became a chapter title, slug, FILENAME
 * and a live TOC citation (`020-time-sampled-while-preparing-turn-11-step-24-202.md`, cited by a
 * checkpoint and never written). AGENTS.md: one predicate per semantic decision, and a source-shape row
 * fails if a second list reappears.
 *
 * Anchored at the START on purpose: a human quoting "time sampled while preparing" mid-sentence is
 * conversation and stays verbatim — the same line the body screen draws.
 *
 * `this is an automatically generated checkpoint` joined 2026-10-23 (#87): it is the host's own
 * in-place relief preamble — machine state that replaces earlier turns, never something a human asked.
 * It had to join THIS list rather than get a second one, because #87's fix asks the same question
 * ("is this a human turn?") at the compaction seam, and a parallel list is exactly the #59 drift this
 * comment already records.
 */
const INJECTED_PROSE = /^\s*(<system-reminder>|<codegraph_context|system reminder\b|current runtime context\.|time sampled while preparing|browser time zone for this request|\[workspace instructions?\b|this session is running under|the following workspace instructions|agent [A-Za-z0-9_-]{8,} sent a message|background subagent [A-Za-z0-9_-]{8,} finished|this is an automatically generated checkpoint)/i

export function isInjectedProse(text: string): boolean {
  return INJECTED_PROSE.test(text)
}

const REMINDER_SPAN = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g

/** Strip every injected span from a message's text; deterministic, idempotent
 * (the marker we emit below cannot re-trigger this rule). */
export function stripReminderSpans(text: string): { text: string; removedChars: number } {
  const removed = text.match(REMINDER_SPAN)?.join('').length ?? 0
  if (removed === 0) return { text, removedChars: 0 }
  return { text: text.replace(REMINDER_SPAN, '').trim(), removedChars: removed }
}

/** The visible, greppable, countable marker an omission leaves behind. One
 * shape for every class so downstream assertions (and the sentinel integration
 * test) pin a single prefix. */
export const omittedMarker = (what: string, chars: number): string =>
  `⟦omitted:host-injected ${what}, ${chars} chars — project state, not conversation⟧`

/**
 * The single screen the renderer and anything else consuming conversation text
 * should use: what survives as chapter text, and what was omitted (event-level
 * for non-human sources, span-level inside otherwise-human messages).
 */
export interface Screened {
  /** Conversation text to render (human messages: span-stripped; non-human: ''). */
  text: string
  /** True when the whole event is injected context (non-human source). */
  omittedEvent: boolean
  /** Character count removed by this screen (event-level OR span-level). */
  removedChars: number
  /** Source label for the event (for the marker + tests). */
  sourceKind: string
}

export function screenConversation(data: Record<string, unknown>, rawText: string, role: 'user' | 'assistant'): Screened {
  if (role === 'user' && !isArchivableConversation(data)) {
    return { text: '', omittedEvent: true, removedChars: rawText.length, sourceKind: sourceLabel(data) }
  }
  // Assistant text is model output, but a runtime snapshot has been observed
  // appended to role user|system by the harness — screening assistant spans
  // too costs one regex and can only ever mark, never invent, text.
  const { text, removedChars } = stripReminderSpans(rawText)
  return { text, omittedEvent: false, removedChars, sourceKind: 'user' }
}
