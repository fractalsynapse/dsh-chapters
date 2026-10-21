/**
 * P2 S1 — the enrichment pass, pure core (record §6.1).
 *
 * One structured call per ARCHIVED chapter, input = the cheap slice the user
 * specified (user requests + first/last assistant message, capped, plus the
 * first ~200 tokens of the chapter body), output = validated JSON:
 *   {"title": "...", "summary": "...", "topics": ["...", ...], "rules": [{"text","category","quote"}]?}
 *
 * No fs, no harness, no model here — the queue (S2) wires the fetcher. This
 * module guarantees the properties the record stakes:
 *   - VALIDATION BEFORE COMMIT: parseEnrichResult accepts nothing malformed;
 *   - NEVER BLOCKS OR BLANKS: applyEnrich(null) is a pure no-op — the
 *     deterministic title/summary/topics from P1 survive any model failure.
 */

export interface EnrichSlice {
  requests: string[]
  firstAssistant?: string
  lastAssistant?: string
}

export interface EnrichResult {
  title: string
  summary: string
  topics: string[]
  /**
   * #50 §7.5 — rules mined from this chapter. OPTIONAL: a model that returns the
   * old three-field shape still validates, so every existing stub, fake and tape
   * keeps passing. Each entry carries the human's own words as `quote`, and the
   * quote is what gates activation (`session-rules.quoteIsHuman`) — the pass may
   * PROPOSE a standing order, it may not make one on inference alone.
   */
  rules: MinedRuleOut[]
}

export interface MinedRuleOut {
  text: string
  category: string
  quote: string
  /** the model's own claim about its warrant; the plugin re-checks the quote and
   * records `stated` only when the material really contains it (§7.5) */
  basis?: 'stated' | 'inferred' | undefined
}

export type GeneratedMark =
  | { by: 'deterministic' }
  | { by: 'model', model: string, at: string }

export interface GeneratedProvenance {
  title: GeneratedMark[]
  summary: GeneratedMark[]
  topics: GeneratedMark[]
}

export type EnrichableFields = 'title' | 'summary' | 'topics'

const TITLE_CAP = 160
const SUMMARY_CAP = 600
const TOPIC_MAX = 10
const TOPIC_LEN = 48
// §7.5 mining bounds: few, short, and traceable. One chapter is not allowed to
// mint a dozen standing orders for a session tree.
const RULE_MAX = 3
const RULE_TEXT_MIN = 10
const RULE_TEXT_CAP = 320
const RULE_QUOTE_CAP = 200
const PART_CAP = 1200
const TOTAL_IN_CAP = 8000
const BODY_HEAD_TOKENS = 200

// The default ceiling for ONE auxiliary completion — the annotation pass (which now
// also carries mined rules) and the conflicts report.
//
// 900 was the pre-mining number. Measured 2026-10-21, mining real chapters at
// `qwen3.8-flash`: the provider reported completion usage of 969–3237 tokens against a
// 700-token request, because REASONING tokens are counted in completion usage. A ceiling
// with room only for the visible JSON truncates mid-object, and a truncated answer
// parses as "no rules" — a silent loss that reads like a model with nothing to say. So
// the budget covers the thinking, not just the answer: 4000, configurable as
// `enrichmentMaxTokens` so no call site carries a literal.
//
// Unchanged: the input caps and the one-retry ladder. Cost is bounded by chapters per
// drain, not by this number.
export const ENRICH_MAX_TOKENS_DEFAULT = 4000

const INSTRUCTION =
  'You annotate one archived chapter of a coding-agent conversation for retrieval. '
  + 'Reply with ONLY one JSON object, no prose, no code fences, shaped exactly: '
  + '{"title": "<one descriptive sentence, <=120 chars>", "summary": "<2-3 informative sentences>", '
  + '"topics": ["<lowercase short labels, 3 to 10>"], "rules": [{"text": "<one imperative standing instruction>", "category": "<short slug>", "quote": "<the user\u0027s own words verbatim>"}]}. '
  + 'Topics are semantic labels (concepts, not file paths). Base everything strictly on the material below.\n'
  + 'rules is OPTIONAL and for durable steering only: a convention, invariant or pitfall the USER stated '
  + 'that should keep applying to future work in this project (e.g. "run the tape replay before tagging"). '
  + 'Do NOT report one-off task details, preferences about this chapter only, or anything you inferred. '
  + 'Every rule MUST quote the user\u0027s own words verbatim in "quote"; if no rule is backed by a literal user '
  + 'sentence, omit "rules" or send []. At most 3. They are reviewed and usually invisible to the model that wrote them.'

/** cap a piece of the slice; truncation is EXPLICIT, never silent. */
function cap(text: string, n: number): string {
  const t = defuseInjections(text).trim()
  if (t.length <= n) return t
  return t.slice(0, n) + ' …[truncated]'
}

/**
 * Host-injected spans enter the chapter as ⟦omitted:host-injected <label>,
 * N chars…⟧ markers whose COUNT and length are machine state (a dev box
 * carries a skills catalog message; a runner does not). The ladder annotates
 * CONVERSATION — record §"host-injected context is not conversation": in the
 * enricher's input every marker collapses to a fixed token. Without this the
 * 8000-char input cap lands at different offsets per machine (measured on
 * hosted CI 2026-09-25: recorded prompts cut ' …[truncated]' at offset 1771
 * while the runner's shorter material sent the full tail — the exchange
 * missed, the ladder starved).
 */
function defuseInjections(text: string): string {
  return text
    .replace(/⟦omitted:host-injected[^⟧]*⟧/g, '⟦injected-context⟧')
    .replace(/(?:⟦injected-context⟧[ \t\n]*){2,}/g, '⟦injected-context⟧ ')
}

/**
 * Assemble the model input: capped slice, stable order, hard total budget.
 * Deterministic — same chapter material always produces the same prompt,
 * which is what makes the queue's chapter+model idempotency key sound.
 *
 * @param codegraphContext Optional structural context from CodeGraph (symbols,
 *   call paths). When present, appended as a bounded block so the enricher can
 *   produce more precise topics. Absent → identical output to before this feature.
 */
export function buildEnrichInput(meta: { title: string }, slice: EnrichSlice, bodyHead: string, codegraphContext?: string): string {
  const parts: string[] = [INSTRUCTION, '', `CURRENT TITLE: ${cap(meta.title, TITLE_CAP)}`]
  if (slice.firstAssistant !== undefined) parts.push(`FIRST ASSISTANT: ${cap(slice.firstAssistant, PART_CAP)}`)
  if (slice.lastAssistant !== undefined) parts.push(`LAST ASSISTANT: ${cap(slice.lastAssistant, PART_CAP)}`)
  for (const [i, r] of slice.requests.slice(-3).entries()) parts.push(`REQUEST ${i + 1}: ${cap(r, PART_CAP)}`)
  parts.push('', 'CHAPTER BODY (opening):', cap(bodyHead, BODY_HEAD_TOKENS * 4))
  // CodeGraph structural context: symbols and their immediate relationships,
  // verified against the project index. Helps the enricher produce structurally
  // precise topics (e.g. "auth-middleware" instead of just "auth"). Capped at
  // 800 chars to stay within TOTAL_IN_CAP; absent → zero bytes added.
  if (codegraphContext !== undefined && codegraphContext.trim().length > 0) {
    parts.push('', 'CODE STRUCTURE (from CodeGraph index):', cap(codegraphContext, 800))
  }
  let text = parts.join('\n')
  if (text.length > TOTAL_IN_CAP) text = text.slice(0, TOTAL_IN_CAP) + '\n…[input truncated]'
  return text
}

/** label sanitizer: lowercase, bracket/quote-free, bounded; null if unusable. */
function cleanTopic(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim().toLowerCase().replace(/["'`[\]{}()<>|\\]/g, '').replace(/\s+/g, ' ').trim()
  if (t.length === 0 || t.length > TOPIC_LEN) return null
  return t
}

/**
 * The validator. Tolerates code fences and surrounding prose (extracts the
 * first JSON object), then requires every field well-shaped. Returns null —
 * never throws — on ANY failure; the retry-then-keep-deterministic ladder is
 * the caller's loop by design.
 */
export function parseEnrichResult(text: string): EnrichResult | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (m === null) return null
  let obj: unknown
  try { obj = JSON.parse(m[0]) } catch { return null }
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>
  if (typeof o.title !== 'string' || typeof o.summary !== 'string' || !Array.isArray(o.topics)) return null
  const title = o.title.trim()
  const summary = o.summary.trim()
  if (title.length === 0 || summary.length === 0) return null
  const topics: string[] = []
  for (const t of o.topics) {
    const c = cleanTopic(t)
    if (c !== null && !topics.includes(c)) topics.push(c)
    if (topics.length >= TOPIC_MAX) break
  }
  if (topics.length === 0) return null
  // rules are additive: absent, malformed or empty ⇒ no mined rules, and the
  // annotation itself still commits. A bad `rules` array must never cost a
  // chapter its title/summary/topics (the ladder's never-blank guarantee).
  const rules: MinedRuleOut[] = []
  if (Array.isArray(o.rules)) {
    for (const raw of o.rules) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      if (typeof r.text !== 'string' || typeof r.quote !== 'string') continue
      const text = r.text.trim()
      const quote = r.quote.trim().replace(/^["'`]+|["'`]+$/g, '')
      if (text.length < RULE_TEXT_MIN || text.length > RULE_TEXT_CAP * 3 || quote.length === 0) continue
      const category = typeof r.category === 'string'
        ? r.category.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)
        : ''
      rules.push({ text: text.slice(0, RULE_TEXT_CAP), category, quote: quote.slice(0, RULE_QUOTE_CAP) })
      if (rules.length >= RULE_MAX) break
    }
  }
  return {
    title: title.slice(0, TITLE_CAP),
    summary: summary.slice(0, SUMMARY_CAP),
    topics,
    rules,
  }
}

const MINE_INSTRUCTION =
  'You read one archived chapter of a coding-agent conversation and write the STANDING ORDERS that '
  + 'would keep this project focused. Reply with ONLY a JSON object: '
  + '{"rules": [{"text": "<one imperative, generalizable instruction>", "category": "<short slug>", "basis": "<stated|inferred>", "quote": "<a short verbatim phrase from the material, or empty>"}]}. '
  + 'Infer what the material implies even when nobody spelled it out — a convention, an invariant, a trap '
  + 'that bit this work and will bite again — but each rule must GENERALIZE beyond this chapter: a '
  + 'one-off task detail is not a rule. `basis` is stated when a human sentence in the material backs it, '
  + 'inferred when you judged it. At most 3; send {"rules":[]} when nothing durable applies. Do not '
  + 'restate the chapter\u2019s contents.'

/** The rules-only prompt for a dedicated mining model (§7.5, `rulesModel`). */
export function buildMineInput(slice: EnrichSlice, bodyHead: string): string {
  const parts: string[] = [MINE_INSTRUCTION, '']
  for (const [i, r] of slice.requests.slice(-4).entries()) parts.push(`REQUEST ${i + 1}: ${cap(r, PART_CAP)}`)
  if (slice.lastAssistant !== undefined) parts.push(`LAST ASSISTANT: ${cap(slice.lastAssistant, PART_CAP)}`)
  parts.push('', 'CHAPTER BODY:', cap(bodyHead, 6000))
  let text = parts.join('\n')
  if (text.length > TOTAL_IN_CAP) text = text.slice(0, TOTAL_IN_CAP) + '\n…[input truncated]'
  return text
}

/**
 * Validate a mining-only answer. Bounds are the same as the annotation path's
 * `rules` field so the two routes cannot produce differently-shaped candidates;
 * an unknown `basis` falls back to the conservative `inferred`.
 */
export function parseMinedRules(text: string): MinedRuleOut[] {
  const m = /\{[\s\S]*\}/.exec(text)
  if (m === null) return []
  let obj: unknown
  try { obj = JSON.parse(m[0]) } catch { return [] }
  const o = obj as Record<string, unknown>
  if (typeof o !== 'object' || o === null || !Array.isArray(o.rules)) return []
  const out: MinedRuleOut[] = []
  for (const raw of o.rules) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    if (typeof r.text !== 'string') continue
    const textOk = r.text.trim()
    if (textOk.length < RULE_TEXT_MIN || textOk.length > RULE_TEXT_CAP * 3) continue
    const quote = typeof r.quote === 'string' ? r.quote.trim().slice(0, RULE_QUOTE_CAP) : ''
    const category = typeof r.category === 'string' ? r.category.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) : ''
    out.push({ text: textOk.slice(0, RULE_TEXT_CAP), category, quote, basis: r.basis === 'stated' ? 'stated' : 'inferred' })
    if (out.length >= RULE_MAX) break
  }
  return out
}

export interface CurrentValues {
  title: string
  summary: string
  topics: string[]
  generated?: Partial<GeneratedProvenance>
}

/**
 * Merge an enrichment result into the chapter's model-owned fields.
 * - result === null (ladder bottomed out) → PURE no-op, values + provenance
 *   untouched (deterministic P1 values survive forever).
 * - same values AND same newest model author → no-op (idempotent re-run).
 * - otherwise: fields update; each provenance chain grows newest-first, one
 *   entry per model (re-annotation by a newer model never erases history).
 * The verbatim BODY is not in this module's universe — callers may only
 * rewrite frontmatter fields (record §6.2), body hash-verified elsewhere.
 */
export function applyEnrich(
  current: CurrentValues,
  result: EnrichResult | null,
  model: string,
  at: string,
): { values: CurrentValues; changed: boolean } {
  if (result === null) return { values: current, changed: false }
  const sameValues = current.title === result.title
    && current.summary === result.summary
    && current.topics.join('\u0000') === result.topics.join('\u0000')
  const authoredBySame = (['title', 'summary', 'topics'] as const).every((f) => {
    const top = current.generated?.[f]?.[0]
    return top?.by === 'model' && (top as { model?: string }).model === model
  })
  if (sameValues && authoredBySame) return { values: current, changed: false }
  const gen: GeneratedProvenance = { title: [], summary: [], topics: [] }
  const mark: GeneratedMark = { by: 'model', model, at }
  for (const f of ['title', 'summary', 'topics'] as const) {
    const chain = current.generated?.[f] ?? []
    gen[f] = [mark, ...chain.filter((c) => !(c.by === 'model' && (c as { model?: string }).model === model))]
  }
  return { values: { ...current, title: result.title, summary: result.summary, topics: result.topics, generated: gen }, changed: true }
}
