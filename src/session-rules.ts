/**
 * #50 §7.5 — the session tier's capture path.
 *
 * Two speeds, deliberately (this is §6.2's single-slot constraint applied to
 * rules, not a new policy):
 *
 *   - **marker**: `ADD RULE: <text>` on a line of a HUMAN message becomes an
 *     active session rule at the existing `turn/end` boundary — deterministic,
 *     zero model tokens (§1 invariant 1), the body is the human's own words.
 *   - **enrichment** (src/enrich-wire.ts): idle-batched, default off, and only
 *     ever activates behind a verbatim quote of human bytes.
 *
 * Session rules are **files, not registry rows**: their activation derives from
 * the ancestor path (§7.5), so they need no record to resolve status, no linked
 * project (an unlinked checkout still gets its rules — the whole point of the
 * tier), and no fact in a pool-synced curation file. The registry keeps holding
 * the shared tier's pre-sync records exactly as before.
 *
 * Idempotent by body: repeated `turn/end`s on a continuable child, and the
 * after-loss re-derivation walk over the durable log, both FILL GAPS and never
 * duplicate — the same posture `rehydrateStoreFromMirror` takes.
 *
 * Pure module: events and paths in, files out. The engine listener mounts it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isHumanAuthored, stripReminderSpans } from './injections.ts'
import { turnSpanOf } from './signature.ts'
import { buildRulesSection, parseRuleFile, parseRuleMarkers, renderRuleFile, ruleSlug, type RuleRecord, type RulesSectionResult } from './rules.ts'
import { redactText } from './redact.ts'
import type { SessionEventLike } from './types.ts'

/** One captured rule: the human's body, anchored to the seq it came from. */
export interface CapturedRule {
  body: string
  seq: number
}

const messageText = (data: Record<string, unknown>): string => {
  const message = (data.message ?? data) as Record<string, unknown>
  const content = Array.isArray(message.content) ? message.content as { type?: string; text?: string }[] : []
  return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
}

/**
 * The markers a turn's HUMAN messages contain. Two screens, both load-bearing:
 *
 *   - `isHumanAuthored` — the same shared predicate signatures use (r28: injected
 *     context moves chapter boundaries and would here too). A host-injected
 *     instruction file that happens to contain a line starting with the marker is
 *     NOT a rule request.
 *   - `stripReminderSpans` — `<system-reminder>` spans ride INSIDE human
 *     messages. The human's own lines survive; the injected span does not (§15
 *     amendment, "host-injected context is not conversation").
 */
export function humanRuleMarkers(events: readonly SessionEventLike[], prefix: string): CapturedRule[] {
  const out: CapturedRule[] = []
  const seen = new Set<string>()
  for (const ev of events) {
    if (ev.type !== 'user/message') continue
    const data = (ev.data ?? {}) as Record<string, unknown>
    if (!isHumanAuthored(data)) continue
    const text = stripReminderSpans(messageText(data)).text
    for (const body of parseRuleMarkers(text, prefix)) {
      if (seen.has(body)) continue
      seen.add(body)
      out.push({ body, seq: ev.seq })
    }
  }
  return out
}

/**
 * The next free number in the SHARED per-machine sequence. Both tiers author
 * into `rules/<harness>/`, and ids are `<harness>/<NNN>`, so a session rule must
 * not take a number a project rule already holds — neither the registry's (pre-
 * sync) records' nor the disk's (a killed write leaves a file without a record;
 * the r39 walk-past rule). Numbers are allocated, never scanned-for-content.
 */
export function nextRuleNumber(opts: {
  records: Iterable<[string, RuleRecord]>
  harnessId: string
  rulesDir: string
}): number {
  const used = new Set<number>()
  const tail = new RegExp(`^${opts.harnessId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\d{3})$`)
  for (const [id] of opts.records) {
    const m = tail.exec(id)
    if (m !== null) used.add(Number(m[1]))
  }
  if (fs.existsSync(opts.rulesDir)) {
    for (const f of fs.readdirSync(opts.rulesDir)) {
      const m = /^(\d{3})-/.exec(f)
      if (m !== null) used.add(Number(m[1]))
    }
  }
  let n = 1
  while (used.has(n)) n += 1
  return n
}

export interface CaptureDeps {
  /** workspace store root, e.g. `<cwd>/.dsh-chapters` */
  storeDir: string
  harnessId: string
  /** the session whose tree these rules bind (§7.5 activation) */
  sessionId: string
  /** for id-collision avoidance with the shared tier's pre-sync records */
  records: Iterable<[string, RuleRecord]>
  prefix: string
  /** the completed turn's events */
  events: readonly SessionEventLike[]
  now?: () => string
}

export interface CaptureResult {
  written: string[]
  skipped: number
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Capture this turn's markers. Returns the rule ids written (empty when nothing
 * matched), and never throws into the session — the caller contains failures the
 * way the signature listener does.
 */
export function captureSessionRules(deps: CaptureDeps): CaptureResult {
  const markers = humanRuleMarkers(deps.events, deps.prefix)
  if (markers.length === 0) return { written: [], skipped: 0 }
  const rulesDir = path.join(deps.storeDir, 'rules', deps.harnessId)
  // dedupe against what is ALREADY on disk for this machine (§7.5 idempotence):
  // a body captured last turn is not captured twice, and a re-derivation pass
  // over the log fills only the gaps.
  const existing = new Set<string>()
  if (fs.existsSync(rulesDir)) {
    for (const f of fs.readdirSync(rulesDir)) {
      if (!f.endsWith('.md')) continue
      // the SAME parser the collectors use — one definition of a rule body,
      // never a second hand-rolled frontmatter split that can drift from it.
      const parsed = parseRuleFile(fs.readFileSync(path.join(rulesDir, f), 'utf8'))
      if (parsed !== null) existing.add(norm(parsed.body))
    }
  }
  let written = 0
  const ids: string[] = []
  for (const m of markers) {
    if (existing.has(norm(m.body))) continue
    // §9 applies to rule bodies like any other archived bytes: a captured rule
    // can carry a credential, and this tier is local but still a file on disk.
    const body = redactText(m.body).text
    const number = nextRuleNumber({ records: deps.records, harnessId: deps.harnessId, rulesDir })
    const title = body.split(/[.!?\n]/)[0]!.trim().slice(0, 60)
    const name = `${String(number).padStart(3, '0')}-${ruleSlug('general', title)}.md`
    fs.mkdirSync(rulesDir, { recursive: true })
    const file = path.join(rulesDir, name)
    // write-once: the file is created complete, never edited in place (§1.3)
    fs.writeFileSync(file, renderRuleFile({
      number,
      category: 'general',
      title,
      sourceSession: deps.sessionId,
      at: (deps.now !== undefined ? deps.now() : new Date().toISOString()),
      body: `${body}\n`,
      scope: 'session',
      session: deps.sessionId,
      derivedFrom: 'marker',
    }), { flag: 'wx' })
    ids.push(`${deps.harnessId}/${String(number).padStart(3, '0')}`)
    existing.add(norm(body))
    written += 1
  }
  return { written: ids, skipped: markers.length - written }
}

/**
 * The current session's ancestor path, root-first — the async mirror of
 * `registry.ancestorPath`, which takes a synchronous getter the realm does not
 * have. §7.5 activation is "this rule's session is on MY path", so every render
 * site needs this walk; a missing parent stops the walk instead of throwing,
 * because a rules render must never break a compaction (the same containment
 * the notice path uses).
 */
export async function ancestorSessionIds(
  get: (id: string) => Promise<{ parentSession: string | null } | undefined>,
  sessionId: string,
  maxDepth = 1000,
): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = sessionId
  while (cursor !== undefined && !seen.has(cursor) && seen.size < maxDepth) {
    seen.add(cursor)
    out.push(cursor)
    const state = await get(cursor)
    if (state === undefined) break
    cursor = state.parentSession ?? undefined
  }
  return out.reverse()
}

/** Turn a task description into the relevance term set §7.4 selects on — the same
 * normalization the rule-term index uses, so a query and a rule body meet in one
 * vocabulary instead of two. */
export function queryTopics(query: string): string[] {
  const out: string[] = []
  for (const tok of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length < 3 || tok.length > 28 || out.includes(tok)) continue
    out.push(tok)
  }
  return out.slice(0, 40)
}

/** The registry view the renderer needs — kept structural so tests can hand it a map. */
export interface RulesStoreLike {
  get(id: string): Promise<{ parentSession: string | null; collections: { terms: string[] }[] } | undefined>
}

export interface RenderRulesOpts {
  mirrorDir: string
  storeDir: string
  projectKey: string
  harnessId: string
  budgetTokens: number
  projectCap?: number | undefined
  sessionCap?: number | undefined
  /** §7.4 relevance on; off ⇒ deterministic category→id order (the tape order). */
  relevance: boolean
  /** §7.6: a BRANCH head carries the project tier only — zero session bytes. */
  includeSession: boolean
  /** When supplied, selection uses THESE terms (the assembly door passes the
   * task query) instead of the session's own recent signatures. */
  topicsOverride?: readonly string[] | undefined
  store: RulesStoreLike
  sessionId: string
}

/**
 * THE one rules renderer for a rebuilt head. Both doors (continue / fork) and the
 * compaction checkpoint call this and nothing else, so the same session can never
 * see two different rule sets depending on which path rebuilt its head — the same
 * one-builder discipline as `search.rankEntries` and `deterministicCommand`.
 *
 * Relevance topics come from the session’s OWN stored turn signatures:
 * deterministic, already on disk, zero model tokens (§1 invariant 1).
 */
export async function renderRulesBlock(opts: RenderRulesOpts): Promise<RulesSectionResult> {
  const ancestors = opts.includeSession
    ? new Set(await ancestorSessionIds(async (id) => await opts.store.get(id), opts.sessionId))
    : new Set<string>()
  const state = opts.relevance ? await opts.store.get(opts.sessionId) : undefined
  const topics = opts.topicsOverride !== undefined && opts.topicsOverride.length > 0
    ? opts.topicsOverride
    : opts.relevance && state !== undefined
      ? state.collections.slice(-6).flatMap((c) => c.terms).slice(0, 40)
      : undefined
  return buildRulesSection(opts.mirrorDir, {
    projectKey: opts.projectKey,
    harnessId: opts.harnessId,
    budgetTokens: opts.budgetTokens,
    projectCap: opts.projectCap,
    sessionCap: opts.sessionCap,
    ...(opts.includeSession ? { storeDir: opts.storeDir, ancestorSessions: ancestors } : {}),
    ...(topics !== undefined ? { relevanceTopics: topics } : {}),
  })
}

/**
 * The `turn/end` listener (the same boundary the topic signatures collect on —
 * §7.5: this extends the existing door, it is not a sixth archive moment).
 *
 * Never-break containment: every failure lands in `warn`, because a rule that
 * could not be written must not cost a user their turn.
 */
export function makeRuleCaptureListener(deps: {
  enabled: () => boolean
  prefix: () => string
  harnessId: () => string
  storeRoot: (cwd: string) => string
  store: () => Promise<{ store: { rules(): IterableIterator<[string, RuleRecord]> } }>
  warn: (error: unknown) => void
  onCaptured?: (sessionId: string, ids: string[]) => void
}): (session: unknown, event: unknown) => void {
  const chains = new Map<string, Promise<void>>()
  return (session, event) => {
    try {
      if (!deps.enabled()) return
      if ((event as { type?: string })?.type !== 'turn/end') return
      const id = (session as { id?: string } | undefined)?.id
      const events = (session as { snapshotEvents?: () => readonly SessionEventLike[] } | undefined)?.snapshotEvents?.()
      const cwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd
      const endSeq = (event as { seq?: number }).seq
      if (id === undefined || events === undefined || cwd === undefined || endSeq === undefined) return
      const span = turnSpanOf(events, endSeq)
      if (span.length === 0) return
      // cheap pre-screen OUTSIDE the async chain: no marker in this turn is the
      // overwhelmingly common case, and it must cost one regex over one message.
      if (humanRuleMarkers(span, deps.prefix()).length === 0) return
      const job = (): Promise<void> => deps.store()
        .then(({ store }) => captureSessionRules({
          storeDir: deps.storeRoot(cwd),
          harnessId: deps.harnessId(),
          sessionId: id,
          records: store.rules(),
          prefix: deps.prefix(),
          events: span,
        }))
        .then((res) => { if (res.written.length > 0) deps.onCaptured?.(id, res.written) })
        .catch(deps.warn)
      const prev = chains.get(id)
      void (prev === undefined ? job() : prev.then(job)).finally(() => chains.delete(id))
    } catch (error) {
      deps.warn(error)
    }
  }
}
