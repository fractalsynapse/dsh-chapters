/**
 * P3 — rules are chapters of a different kind (record §7.1): same file
 * format, same sync, searched like anything else; this module adds ONLY the
 * lifecycle-shaped parts:
 *
 *   - the rule file (written ONCE, status: proposed, immutable thereafter),
 *   - the per-machine status resolution (§15 amendment 2026-09-20): effective
 *     status comes from the APPROVING MACHINE's own curation facts
 *     (edits/<harnessId>/curation.jsonl, `rule-status` entries), never from a
 *     file rewrite — authorship stays partitioned, and a rule proposed on one
 *     machine affects no other machine's notice until a human there approves,
 *   - the rules block (§7.3): active rules verbatim + a category index,
 *     budgeted, refuse-with-numbers on overflow, and — load-bearing for the
 *     tape corpus — BYTE-IDENTICAL NOTHING when there are no rules: an empty
 *     project renders no section at all.
 *
 * #50 (record §7.1, §7.3–§7.5) adds the SECOND TIER without adding a second
 * subsystem: `scope: project | session` on the same file format. Absent means
 * `project`, so every rule record written before this amendment keeps its exact
 * bytes. Session rules are machine-local, captured from human bytes, and their
 * activation is DERIVED from the ancestor path — never a curation fact, because
 * `edits/<harness>/curation.jsonl` is pool-synced and reserved for human status
 * decisions (§15 amendment 2026-09-20, unrelaxed). They are also never staged
 * (§7.5, `planStoreToRepo`), so the pool cannot accumulate one machine's
 * mis-generalizations.
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { estimateTokens, sha256 } from './render.ts'
import { parseCuration } from './indexing.ts'
import { parseChapterFile } from './enrich-store.ts'

export const RULE_STATUS = ['proposed', 'core', 'revoked'] as const
export type RuleStatus = (typeof RULE_STATUS)[number]

/** §7.1: two tiers, one store. Absent scope on any file or record ⇒ `project`. */
export const RULE_SCOPE = ['project', 'session'] as const
export type RuleScope = (typeof RULE_SCOPE)[number]

/** How the bytes came to be: a person, the deterministic marker, or the model. */
export const RULE_DERIVED_FROM = ['human', 'marker', 'model'] as const
export type RuleDerivedFrom = (typeof RULE_DERIVED_FROM)[number]

/**
 * The WARRANT behind a rule — what a human reads when deciding whether to trust
 * it (record §7.5, amended 2026-10-21). `stated` means a human sentence is behind
 * the rule; `inferred` means the model judged that a standing order would help and
 * nobody said it. BOTH govern by default, because the premise of the tier is that
 * the human may not know the rule yet — the distinction is displayed, not used as
 * a permission check. Requiring a human to have already said it would make this
 * tier redundant with the deterministic `ADD RULE:` marker.
 */
export const RULE_BASIS = ['human', 'marker', 'stated', 'inferred'] as const
export type RuleBasis = (typeof RULE_BASIS)[number]

export interface RuleRecord {
  id: string // '<harnessId>/<NNN>' — globally unique, human-typable tail
  projectKey: string
  number: number
  path: string // workspace-relative authored path
  category: string
  title: string
  sourceSession: string
  at: string
  /** §7.1 tier; absent ⇒ 'project' (the pre-#50 default). The `| undefined`
   * unions are load-bearing: `exactOptionalPropertyTypes` is on, and this
   * interface is what `ruleRecordSchema` types at the registry boundary. */
  scope?: RuleScope | undefined
  /** session tier only: the session whose tree this rule belongs to (§7.5). */
  session?: string | undefined
  /** §7.1 provenance; absent ⇒ 'human'. */
  derivedFrom?: RuleDerivedFrom | undefined
  /** §7.4 always-rendered class; human-set only. */
  pinned?: boolean | undefined
  /** §7.5 (amended 2026-10-21): review posture, NOT an evidence test. A mined
   * rule is inert until this machine approves it only when `rulesAutoActivate` is
   * off. The default is that it governs immediately — inferring a useful standing
   * order IS the point of the tier. */
  reviewOnly?: boolean | undefined
  /** §7.5: the warrant a human reads alongside the text. */
  basis?: RuleBasis | undefined
  /** the chapter a mined rule came from (provenance for the review surface) */
  chapter?: number | undefined
}

export const ruleRecordSchema = z.object({
  id: z.string().min(3),
  projectKey: z.string().min(1),
  number: z.number().int().positive(),
  path: z.string().min(1),
  category: z.string().min(1),
  title: z.string(),
  sourceSession: z.string(),
  at: z.string(),
  scope: z.enum(RULE_SCOPE).optional(),
  session: z.string().optional(),
  derivedFrom: z.enum(RULE_DERIVED_FROM).optional(),
  pinned: z.boolean().optional(),
  reviewOnly: z.boolean().optional(),
  basis: z.enum(RULE_BASIS).optional(),
  chapter: z.number().int().positive().optional(),
})

export const ruleSlug = (category: string, title: string): string => {
  const s = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${s(category) || 'rule'}-${s(title) || 'untitled'}`
}

export const rulePath = (storeRoot: string, harnessId: string, number: number, category: string, title: string): string =>
  path.posix.join(storeRoot, 'rules', harnessId, `${String(number).padStart(3, '0')}-${ruleSlug(category, title)}.md`)

/** one write, ever: rules are proposed by their author and never rewritten (status rides facts) */
export function renderRuleFile(input: {
  number: number
  category: string
  title: string
  sourceSession: string
  at: string
  body: string
  scope?: RuleScope | undefined
  session?: string | undefined
  derivedFrom?: RuleDerivedFrom | undefined
  pinned?: boolean | undefined
  reviewOnly?: boolean | undefined
  basis?: RuleBasis | undefined
  chapter?: number | undefined
}): string {
  // §7.1 byte-compatibility: a project rule derived from a human and unpinned
  // emits NOTHING extra, so every rule file written before #50 keeps rendering
  // the same bytes. Defaults are absent, never printed.
  const extras: string[] = []
  if (input.scope !== undefined && input.scope !== 'project') extras.push(`scope: ${input.scope}`)
  if (input.session !== undefined && input.session !== '') extras.push(`session: ${JSON.stringify(input.session)}`)
  if (input.derivedFrom !== undefined && input.derivedFrom !== 'human') extras.push(`derivedFrom: ${input.derivedFrom}`)
  if (input.pinned === true) extras.push('pinned: true')
  if (input.reviewOnly === true) extras.push('reviewOnly: true')
  if (input.basis !== undefined && input.basis !== 'human') extras.push(`basis: ${input.basis}`)
  if (input.chapter !== undefined && input.chapter > 0) extras.push(`chapter: ${input.chapter}`)
  return [
    '---',
    `number: ${input.number}`,
    'kind: rule',
    `category: ${JSON.stringify(input.category)}`,
    `title: ${JSON.stringify(input.title)}`,
    'status: proposed',
    ...extras,
    `sourceSession: ${JSON.stringify(input.sourceSession)}`,
    `authoredAt: ${JSON.stringify(input.at)}`,
    `sha256: ${sha256(input.body)}`,
    '---',
    input.body,
  ].join('\n')
}

export interface ParsedRule {
  number: number
  category: string
  title: string
  fileStatus: RuleStatus
  sourceSession: string
  body: string
  scope: RuleScope
  session: string
  derivedFrom: RuleDerivedFrom
  pinned: boolean
  reviewOnly: boolean
  basis: RuleBasis
  chapter: number
}

export function parseRuleFile(text: string): ParsedRule | null {
  try {
    const doc = parseChapterFile(text)
    const fm = new Map<string, string>()
    for (const line of doc.fmLines) {
      const m = /^([A-Za-z][\w]*):\s*(.*)$/.exec(line)
      if (m !== null) fm.set(m[1]!, m[2]!.trim())
    }
    if (fm.get('kind') !== 'rule') return null
    const unq = (v: string | undefined, d: string): string => (v ?? d).replace(/^"|"$/g, '')
    const rawStatus = unq(fm.get('status'), 'proposed')
    const rawScope = unq(fm.get('scope'), 'project')
    const rawDerived = unq(fm.get('derivedFrom'), 'human')
    return {
      number: Number(fm.get('number') ?? '0'),
      category: unq(fm.get('category'), 'general'),
      title: unq(fm.get('title'), ''),
      fileStatus: (RULE_STATUS as readonly string[]).includes(rawStatus) ? rawStatus as RuleStatus : 'proposed',
      sourceSession: unq(fm.get('sourceSession'), ''),
      body: doc.body,
      // an unrecognized value degrades to the SAFE default: a hand-edited or
      // future-versioned file must never become active by accident
      scope: (RULE_SCOPE as readonly string[]).includes(rawScope) ? rawScope as RuleScope : 'project',
      session: unq(fm.get('session'), ''),
      derivedFrom: (RULE_DERIVED_FROM as readonly string[]).includes(rawDerived) ? rawDerived as RuleDerivedFrom : 'human',
      pinned: unq(fm.get('pinned'), '') === 'true',
      reviewOnly: unq(fm.get('reviewOnly'), '') === 'true',
      basis: (RULE_BASIS as readonly string[]).includes(unq(fm.get('basis'), '')) ? unq(fm.get('basis'), '') as RuleBasis : 'human',
      chapter: Number(unq(fm.get('chapter'), '0')) > 0 ? Number(unq(fm.get('chapter'), '0')) : 0,
    }
  } catch {
    return null
  }
}

export interface RuleStatusFact {
  rule: string
  status: RuleStatus
  at: string
}

/** the machine's own facts, last-write-wins per rule (append-only file order) */
export function loadRuleStatusFacts(mirrorDir: string, harnessId: string): Map<string, RuleStatusFact> {
  const out = new Map<string, RuleStatusFact>()
  const file = path.join(mirrorDir, 'edits', harnessId, 'curation.jsonl')
  if (!fs.existsSync(file)) return out
  for (const f of parseCuration(fs.readFileSync(file, 'utf8'))) {
    if (f.type !== 'rule-status') continue
    const f2 = f as unknown as { rule?: string; status?: string; at?: string }
    if (typeof f2.rule !== 'string' || typeof f2.status !== 'string') continue
    if (!(RULE_STATUS as readonly string[]).includes(f2.status)) continue
    out.set(f2.rule, { rule: f2.rule, status: f2.status as RuleStatus, at: f2.at ?? '' })
  }
  return out
}

/** append-only, like every other curation write */
export function appendRuleStatusFact(mirrorDir: string, harnessId: string, fact: RuleStatusFact): void {
  const dir = path.join(mirrorDir, 'edits', harnessId)
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'curation.jsonl'), JSON.stringify({ type: 'rule-status', ...fact }) + '\n')
}

export function effectiveStatus(ruleId: string, facts: Map<string, RuleStatusFact>, fileStatus: RuleStatus): RuleStatus {
  return facts.get(ruleId)?.status ?? fileStatus
}

/**
 * §7.4: a PIN is a curation fact, never a rewrite. Rule files are write-once
 * (§1.3) and the append-only rule has no exceptions, so "always show this one"
 * rides `edits/<harness>/curation.jsonl` as its own fact type — one writer per
 * file, per-machine by construction, and a git-revertable line.
 */
export interface RulePinFact { rule: string; pinned: boolean; at: string }

export function appendRulePinFact(mirrorDir: string, harnessId: string, fact: RulePinFact): void {
  const dir = path.join(mirrorDir, 'edits', harnessId)
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'curation.jsonl'), JSON.stringify({ type: 'rule-pin', ...fact }) + '\n')
}

/** the machine's pins, last-write-wins (so `unpin` is a later fact, not a delete) */
export function loadRulePins(mirrorDir: string, harnessId: string): Set<string> {
  const out = new Set<string>()
  const file = path.join(mirrorDir, 'edits', harnessId, 'curation.jsonl')
  if (!fs.existsSync(file)) return out
  for (const f of parseCuration(fs.readFileSync(file, 'utf8'))) {
    if (f.type !== 'rule-pin') continue
    const f2 = f as unknown as { rule?: string; pinned?: boolean }
    if (typeof f2.rule !== 'string') continue
    if (f2.pinned === true) out.add(f2.rule)
    else out.delete(f2.rule)
  }
  return out
}

export interface MirrorRule {
  id: string // '<harness>/<NNN>' as authored
  relPath: string
  status: RuleStatus
  category: string
  title: string
  body: string
  bodyTokens: number
  /** §7.1 tier. A session rule has no business appearing in the mirror (§7.5);
   * if one does (a hand-copied pool, an older build), the builder still only
   * renders session rules collected from the LOCAL store for this ancestor
   * path — so a smuggled file cannot govern a head. */
  scope: RuleScope
  session: string
  derivedFrom: RuleDerivedFrom
  pinned: boolean
  /** §7.5: inert pending review — set only when `rulesAutoActivate` is off */
  reviewOnly: boolean
  basis: RuleBasis
  chapter: number
}

/** every rule file the mirror knows for one project, with THIS machine's effective status */
export function collectMirrorRules(mirrorDir: string, projectKey: string, harnessId: string): MirrorRule[] {
  const root = path.join(mirrorDir, 'rules', projectKey)
  if (!fs.existsSync(root)) return []
  const facts = loadRuleStatusFacts(mirrorDir, harnessId)
  const pins = loadRulePins(mirrorDir, harnessId)
  const out: MirrorRule[] = []
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p, rel === '' ? e.name : path.join(rel, e.name)); continue }
      if (!e.name.endsWith('.md')) continue
      const relPath = path.posix.join('rules', projectKey, rel === '' ? e.name : `${rel}/${e.name}`)
      const rule = parseRuleFile(fs.readFileSync(p, 'utf8'))
      if (rule === null) continue
      const harness = e.name === '' ? harnessId : path.basename(path.dirname(p))
      const id = `${harness}/${String(rule.number).padStart(3, '0')}`
      const status = effectiveStatus(id, facts, rule.fileStatus)
      out.push({
        id, relPath, status, category: rule.category, title: rule.title,
        body: rule.body.trim(), bodyTokens: estimateTokens(rule.body.trim()),
        scope: rule.scope, session: rule.session, derivedFrom: rule.derivedFrom,
        // file-level pin (an authored default) OR this machine's pin fact (§7.4)
        pinned: rule.pinned || pins.has(id),
        reviewOnly: rule.reviewOnly, basis: rule.basis, chapter: rule.chapter,
      })
    }
  }
  walk(root, '')
  return out.sort((a, b) => a.category < b.category ? -1 : a.category > b.category ? 1 : a.id < b.id ? -1 : 0)
}

export type RulesSectionResult =
  | { kind: 'none' }
  | { kind: 'ok'; text: string; tokens: number; shown: { project: number; session: number }; withheld: { project: number; session: number } }
  | { kind: 'refusal'; reason: string; perRule: Array<{ id: string; tokens: number }>; cap: number; total: number }

/** §7.3 options. Every #50 field is optional: with none of them supplied the
 * builder renders exactly what it rendered before #50 — which is what keeps the
 * existing notice goldens, the four door call sites, and the tape corpus intact. */
export interface RulesSectionOptions {
  projectKey: string
  harnessId: string
  budgetTokens: number
  /** local store root (`<cwd>/<storeRoot>`); supplies the session tier (§7.5). */
  storeDir?: string | undefined
  /** this session's ancestor path, including itself (§7.5 activation). */
  ancestorSessions?: ReadonlySet<string> | undefined
  /** §7.4 per-tier count caps; absent ⇒ unlimited (the pre-#50 behavior). */
  projectCap?: number | undefined
  sessionCap?: number | undefined
  /** §7.4 relevance input: the archived span's topic signatures (or a query). */
  relevanceTopics?: readonly string[] | undefined
}

/** deterministic term set for overlap scoring — no clock, no locale surprises */
const ruleTerms = (r: MirrorRule): Set<string> =>
  new Set(`${r.category} ${r.title} ${r.body}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2))

/**
 * §7.4 selection: pinned first (ground rules are OLD — anything that ranks by
 * recency or topicality evicts them first), then topicality when topics are
 * supplied, then the pre-#50 category/id order. A pure function of the inputs,
 * so two machines with the same files render the same head and the tapes stay
 * stable.
 */
export function selectRules(rules: readonly MirrorRule[], topics?: readonly string[]): MirrorRule[] {
  const bag = topics === undefined || topics.length === 0 ? null : new Set(topics.map((t) => t.toLowerCase()))
  const overlap = (r: MirrorRule): number => {
    if (bag === null) return 0
    const terms = ruleTerms(r)
    let n = 0
    for (const t of bag) if (terms.has(t) || terms.has(t.replace(/s$/, ''))) n += 1
    return n
  }
  return [...rules].sort((a, b) =>
    (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1)
    || (overlap(b) - overlap(a))
    || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** the rule ids a human switched off on THIS machine (both tiers) */
export function revokedRuleIds(mirrorDir: string, harnessId: string): Set<string> {
  const out = new Set<string>()
  for (const [id, f] of loadRuleStatusFacts(mirrorDir, harnessId)) if (f.status === 'revoked') out.add(id)
  return out
}

/**
 * §7.5: session rules are collected from the LOCAL store, never from the pool
 * mirror — they are not staged (`planStoreToRepo` skips `scope: session`), so
 * the only place they exist is `<storeDir>/rules/<harness>/*.md`. Same parser,
 * same id shape, so `list`, numbering and search stay one mechanism for both
 * tiers.
 */
export function collectStoreRules(
  storeDir: string,
  harnessId: string,
  /** §7.5: this machine's `rule-status` facts, so a human `approve` can switch a
   * SUGGESTED model rule on without rewriting the write-once file. */
  facts?: Map<string, RuleStatusFact> | undefined,
): MirrorRule[] {
  const root = path.join(storeDir, 'rules')
  if (!fs.existsSync(root)) return []
  const out: MirrorRule[] = []
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p, rel === '' ? e.name : path.join(rel, e.name)); continue }
      if (!e.name.endsWith('.md')) continue
      const relPath = path.posix.join('rules', rel === '' ? e.name : `${rel}/${e.name}`)
      const rule = parseRuleFile(fs.readFileSync(p, 'utf8'))
      if (rule === null) continue
      const harness = rel === '' ? harnessId : path.basename(path.dirname(p))
      const id = `${harness}/${String(rule.number).padStart(3, '0')}`
      out.push({
        id, relPath, status: facts === undefined ? rule.fileStatus : effectiveStatus(id, facts, rule.fileStatus),
        category: rule.category, title: rule.title,
        body: rule.body.trim(), bodyTokens: estimateTokens(rule.body.trim()),
        scope: rule.scope, session: rule.session, derivedFrom: rule.derivedFrom,
        pinned: rule.pinned, reviewOnly: rule.reviewOnly, basis: rule.basis, chapter: rule.chapter,
      })
    }
  }
  walk(root, '')
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * §7.5 transport predicate: is this authored rule file part of the machine-local
 * session tier? Reads it through the SAME parser the collectors use — one
 * definition of `scope`, never a second lightweight guess that can drift from it.
 * An unreadable or non-rule file is treated as project (staged), because the
 * exclusion must be a decision about the session tier specifically, not a
 * side-effect of a parse miss.
 */
export function isSessionRuleFile(absPath: string): boolean {
  try {
    return parseRuleFile(fs.readFileSync(absPath, 'utf8'))?.scope === 'session'
  } catch {
    return false
  }
}

/**
 * §7.5 activation, DERIVED rather than approved: a session rule binds exactly
 * one session tree — its own session must be on the current session's ancestor
 * path — and a human `revoke` is the one fact that can switch it off (files are
 * write-once, §1.3, so there is nothing else to edit).
 */
export function sessionRuleActive(
  rule: MirrorRule,
  /** `facts` is unused here (the caller resolves status into `rule.status`); it is
   * accepted so both collectors and callers pass ONE options object around. */
  opts: { ancestorSessions: ReadonlySet<string>; revoked: ReadonlySet<string>; facts?: Map<string, RuleStatusFact> | undefined },
): boolean {
  if (rule.scope !== 'session') return false
  if (rule.session === '') return false
  if (opts.revoked.has(rule.id)) return false
  // Review posture, NOT an evidence test (amended 2026-10-21): a mined rule is
  // inert only when the plugin is configured to hold mined rules for review. What
  // keeps an inferred rule from doing damage is that it is machine-local, never
  // staged, count-capped, rendered with its warrant, and one command from
  // revoke — not a requirement that a human have already said it.
  if (rule.reviewOnly && rule.status !== 'core') return false
  return opts.ancestorSessions.has(rule.session)
}

/** The session-tier view for one rebuilt head: active rules, id-ordered. */
export function collectActiveSessionRules(
  storeDir: string,
  harnessId: string,
  opts: { ancestorSessions: ReadonlySet<string>; revoked: ReadonlySet<string>; facts?: Map<string, RuleStatusFact> | undefined },
): MirrorRule[] {
  return collectStoreRules(storeDir, harnessId, opts.facts).filter((r) => sessionRuleActive(r, opts))
}

/**
 * §7.5 re-derivation and the capture path: scan text for the marker at LINE
 * START and return the rule bodies, in order, deduped by exact body.
 *
 * Deterministic and model-free by contract (§1 invariant 1) — this is the
 * per-turn path AND the rebuild-after-loss path, so it must never touch `ctx.llm`.
 */
export function parseRuleMarkers(text: string, prefix: string): string[] {
  const out: string[] = []
  const p = prefix.trim()
  if (p === '') return out
  for (const raw of text.split(/\r?\n/)) {
    // line START only: a sentence that merely mentions the prefix mid-prose is
    // conversation, not a capture request.
    const line = raw.replace(/^\s+/, '')
    if (!line.startsWith(p)) continue
    const body = line.slice(p.length).trim()
    if (body.length < 10) continue // same minimum the add command enforces
    if (!out.includes(body)) out.push(body)
  }
  return out
}

const capLine = (tier: string, active: number, shown: number): string | null =>
  shown >= active ? null : `${active - shown} more ${tier} rule(s) active but not shown — /chapters-rule active lists them, pin one to keep it here`

/**
 * §7.3: the rules block a rebuilt head carries. `kind: 'none'` (no active rules
 * and no corpus) MUST produce zero injected bytes at the call site — the tape
 * corpus depends on it. Overflow of the TOKEN ceiling refuses with per-rule
 * numbers, never clips (§1.2); a count CAP selects, and what it left out is
 * ANNOUNCED, because silent selection would rebuild "lost in the noise" inside
 * the fix for it.
 */
export function buildRulesSection(
  mirrorDir: string,
  opts: RulesSectionOptions,
): RulesSectionResult {
  const statusFacts = loadRuleStatusFacts(mirrorDir, opts.harnessId)
  const revoked = new Set<string>([...statusFacts].filter(([, f]) => f.status === 'revoked').map(([id]) => id))
  const all = collectMirrorRules(mirrorDir, opts.projectKey, opts.harnessId)
  const projectActive = all.filter((r) => r.scope === 'project' && r.status === 'core')
  const sessionActive = opts.storeDir !== undefined && opts.ancestorSessions !== undefined
    ? collectActiveSessionRules(opts.storeDir, opts.harnessId, { ancestorSessions: opts.ancestorSessions, revoked, facts: statusFacts })
    : []

  const categories = new Map<string, { count: number; essence: string; samplePath: string }>()
  for (const r of all) {
    if (r.status === 'revoked' || r.scope !== 'project') continue
    const prev = categories.get(r.category)
    categories.set(r.category, {
      count: (prev?.count ?? 0) + 1,
      essence: prev?.essence ?? r.title,
      samplePath: prev?.samplePath ?? r.relPath,
    })
  }
  if (projectActive.length === 0 && sessionActive.length === 0 && categories.size === 0) return { kind: 'none' }

  const topics = opts.relevanceTopics
  const pSel = selectRules(projectActive, topics)
  const sSel = selectRules(sessionActive, topics)
  const pShown = opts.projectCap === undefined ? pSel : pSel.slice(0, Math.max(0, opts.projectCap))
  const sShown = opts.sessionCap === undefined ? sSel : sSel.slice(0, Math.max(0, opts.sessionCap))
  const withheld = { project: pSel.length - pShown.length, session: sSel.length - sShown.length }

  // the token ceiling is measured on what would actually render (§1.2)
  let total = 0
  for (const r of [...pShown, ...sShown]) total += r.bodyTokens
  if (total > opts.budgetTokens) {
    return {
      kind: 'refusal',
      reason: `core rules exceed their budget: ${total} tokens over a cap of ${opts.budgetTokens}. Revoke one ("/chapters-rule revoke <id>") or split a category — the notice never clips rules.`,
      perRule: [...pShown, ...sShown].map((r) => ({ id: r.id, tokens: r.bodyTokens })),
      cap: opts.budgetTokens,
      total,
    }
  }

  const lines: string[] = []
  if (pShown.length > 0) {
    lines.push('## CORE RULES (approved for this project — follow them)')
    for (const r of pShown) lines.push(`[${r.id}] (${r.category}) ${r.body}`, '')
  }
  // Every rule carries its WARRANT, because a human has to be able to tell a
  // standing order they gave from a standing order a model inferred (§7.5).
  const tag = (r: MirrorRule): string => {
    if (r.scope === 'project' || r.derivedFrom !== 'model') return r.derivedFrom === 'marker' ? 'you said this' : ''
    const from = r.chapter > 0 ? `ch.${r.chapter}` : 'this session tree'
    return r.basis === 'stated' ? `stated by you, mined from ${from}` : `inferred from ${from} — nobody said it`
  }
  const pWithheld = capLine('project', pSel.length, pShown.length)
  if (pWithheld !== null) lines.push(pWithheld, '')
  if (sShown.length > 0) {
    lines.push('## SESSION RULES (captured this session — they refine the project rules above; they never override them)')
    for (const r of sShown) { const t = tag(r); lines.push(`[${r.id}] (${r.category}${t !== '' ? `; ${t}` : ''}) ${r.body}`, '') }
    const sWithheld = capLine('session', sSel.length, sShown.length)
    if (sWithheld !== null) lines.push(sWithheld, '')
  }
  if (sShown.length > 0) {
    // The transparency the tier needs: an inferred standing order is exactly the
    // kind of thing a human must be able to catch, so the agent names which rules
    // actually shaped its reply (§7.5). Scoped to blocks that carry session rules —
    // a project-only block keeps its pre-#50 bytes (the R0 golden row pins that),
    // so this costs nothing to a session that has no mined rules.
    lines.push('Name by id the session rule(s) above that actually shaped what you did — say "none" if none applied. A rule cited wrongly twice should be revoked.', '')
  }
  if (categories.size > 0) {
    lines.push('Rule categories (load a category from the repo when this session\u2019s topics overlap it):')
    for (const [cat, m] of [...categories.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
      lines.push(`- ${cat} (${m.count}): ${m.essence} — e.g. ${m.samplePath}`)
    }
  }
  const text = lines.join('\n').trimEnd()
  return { kind: 'ok', text, tokens: estimateTokens(text), shown: { project: pShown.length, session: sShown.length }, withheld }
}
