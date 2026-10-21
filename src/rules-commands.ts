/**
 * P3 S2 — the /chapters-rule command family (record §7.2, §7.9), as a pure-ish
 * module so the lifecycle is testable without a commands service.
 *
 *   /chapters-rule add <category> <text…>          # the PROJECT tier only
 *   /chapters-rule list [--all | --proposed | --category <c> | --scope <t>]
 *   /chapters-rule active                          # what a rebuilt head will show
 *   /chapters-rule approve <id> | revoke <id>
 *   /chapters-rule pin <id> | unpin <id>
 *   /chapters-rule conflicts [--model <route>]
 *
 * Identity: '<harnessId>/<NNN>'. Files are write-once; status is a per-machine
 * curation fact (§15 amendment) appended to the mirror's own edits/<harness>/
 * curation.jsonl and pushed immediately (offline-safe: the local commit still
 * happens; push coalesces later). Commands never enter the model context.
 *
 * #50: the session tier joins the SAME surface (§7.1) — same ids, same files,
 * same list — with two differences that are load-bearing. It has no `approve`
 * (activation derives from the ancestor path, §7.5), and `revoke` is the one
 * fact it does write. Pinning rides a fact too: rewriting a write-once file to
 * pin it would be the first sanctioned file-edit in this store, and the append-
 * only rule has no exceptions.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  renderRuleFile, rulePath, collectMirrorRules, appendRuleStatusFact, appendRulePinFact, loadRulePins,
  collectStoreRules, loadRuleStatusFacts, sessionRuleActive, buildRulesSection, revokedRuleIds,
  type RuleRecord, type RuleStatus,
} from './rules.ts'
import type { ProjectRecord } from './sync.ts'
import { resolveStoreRoot } from './store.ts'

export interface RulesIo {
  cwd(): string
  storeRoot: string
  harnessId: string
  store: {
    rules(): IterableIterator<[string, RuleRecord]>
    getRule(id: string): RuleRecord | undefined
    putRule(id: string, value: RuleRecord): Promise<void>
  }
  projectFor(cwd: string): ProjectRecord | undefined
  mirrorDir(cwd: string): string
  /** arm an immediate sync so facts and files travel (never throws) */
  syncNow(cwd: string): Promise<void>
  /** provenance of the ADD path: 'manual' for commands, the session id for the tool */
  sourceSession?: string
  now: () => Date
  /**
   * #50 §7.5: the current session's ancestor path (root-first), so `active`,
   * `list --scope session` and `conflicts` can tell which session rules bind.
   * Absent ⇒ the session tier is reported as unresolved, never guessed.
   */
  ancestors?: () => Promise<ReadonlySet<string>>
  /** #50 §7.7: ONE bounded model call, report-only. Absent ⇒ the verb refuses. */
  ask?: (prompt: string) => Promise<string>
  /** §7.3/§7.4 numbers the answer is measured with — the SAME config the doors
   * render from, so `active` cannot report a view the head will not show. */
  budgetTokens?: number
  projectCap?: number
  sessionCap?: number
  /** §7.5: reported by `active`, and drives whether mined rules govern on arrival */
  autoActivate?: boolean | undefined
  /** the shared settings table (`rules.model` lives beside `enrichment.model`) */
  settings?: { get(key: string): string | undefined; put(key: string, value: string): Promise<void> } | undefined
}

export interface RulesReply { kind: 'success' | 'error'; text: string }

const HELP = 'usage: /chapters-rule add <category> <text> | list [--all|--proposed|--category <c>|--scope project|session] | active | approve <id> | revoke <id> | pin <id> | unpin <id> | model [<provider/model|clear>] | conflicts'

/** one row per rule, both tiers, with the effective status of THIS machine */
interface RuleRow {
  id: string
  scope: 'project' | 'session'
  category: string
  title: string
  status: RuleStatus
  /** session tier: derived activation (§7.5) */
  active?: boolean
  pinned: boolean
  body: string
  sourceSession: string
  /** §7.5: held for review by policy — inert until this machine approves it */
  reviewOnly?: boolean | undefined
  /** §7.5 warrant shown to the human: stated (a human sentence) vs inferred */
  basis?: string | undefined
}

export async function rulesCommand(io: RulesIo, args: string): Promise<RulesReply> {
  const parts = args.trim().split(/\s+/).filter((p) => p.length > 0)
  const verb = parts[0] ?? 'help'
  const cwd = io.cwd()
  const project = io.projectFor(cwd)
  if (project === undefined) {
    return { kind: 'error', text: 'no knowledge repository is linked for this workspace — link one with /chapters-link first (rules are shared state)' }
  }
  const mirror = io.mirrorDir(cwd)
  const storeDir = resolveStoreRoot(cwd, io.storeRoot)
  const pins = loadRulePins(mirror, io.harnessId)

  // every rule known to THIS machine: mirror files (all authors) ∪ own domain
  // records (pre-sync) ∪ the LOCAL session tier (§7.5 — those never reach the
  // pool, so the mirror walk cannot see them)
  const known = async (): Promise<RuleRow[]> => {
    const byId = new Map<string, RuleRow>()
    const ancestorSet = io.ancestors !== undefined ? await io.ancestors() : new Set<string>()
    const statusFacts = loadRuleStatusFacts(mirror, io.harnessId)
    // §7.5: `revoke` is the one fact the session tier writes, and it lives in
    // curation.jsonl — the FILE stays `proposed` forever (write-once). Reading
    // file status instead of facts would keep a revoked rule rendering.
    const revokedHere = revokedRuleIds(mirror, io.harnessId)
    for (const r of collectMirrorRules(mirror, project.projectKey, io.harnessId)) {
      byId.set(r.id, {
        id: r.id, scope: r.scope === 'session' ? 'session' : 'project', category: r.category, title: r.title,
        status: r.status, pinned: r.pinned || pins.has(r.id), body: r.body, sourceSession: '',
      })
    }
    for (const [, rec] of io.store.rules()) {
      if (rec.projectKey !== project.projectKey) continue
      const prev = byId.get(rec.id)
      byId.set(rec.id, {
        id: rec.id, scope: (rec.scope ?? 'project') === 'session' ? 'session' : 'project', category: rec.category, title: rec.title,
        status: prev?.status ?? 'proposed', pinned: prev?.pinned === true || pins.has(rec.id), body: prev?.body ?? '',
        sourceSession: io.sourceSession ?? 'manual',
      })
    }
    // the session tier comes off disk, activated by the ancestor predicate
    for (const r of collectStoreRules(storeDir, io.harnessId, statusFacts)) {
      if (r.scope !== 'session') continue
      byId.set(r.id, {
        id: r.id, scope: 'session', category: r.category, title: r.title, status: r.status,
        active: sessionRuleActive(r, { ancestorSessions: ancestorSet, revoked: revokedHere, facts: statusFacts }),
        pinned: r.pinned || pins.has(r.id), body: r.body, sourceSession: r.session,
        reviewOnly: r.reviewOnly, basis: r.basis,
      })
    }
    return [...byId.values()].sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.id < b.id ? -1 : 1))
  }

  if (verb === 'add') {
    const category = parts[1]
    const body = parts.slice(2).join(' ')
    if (category === undefined || body.length < 10) {
      return { kind: 'error', text: `add needs a category and at least a sentence of rule text. ${HELP}` }
    }
    let number = 1
    for (const [id] of io.store.rules()) {
      const m = new RegExp(`^${io.harnessId}/(\\d{3})$`).exec(id)
      if (m !== null) number = Math.max(number, Number(m[1]) + 1)
    }
    const title = body.split(/[.!?\n]/)[0]!.trim().slice(0, 60)
    let rel = rulePath(io.storeRoot, io.harnessId, number, category, title)
    let abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
    // The domain may be fresh while disk is not (e2e rebuilds the home every
    // boot; per-machine rule files are write-once): walk past any number the
    // disk already holds rather than refuse. Refusing was the r39-era e2e
    // deadlock — add could never land again in a dirty workspace. The walk is
    // keyed on the NUMBER PREFIX, not the exact path: a disk ghost of a dead
    // rule (its title killed, its domain record gone) still owns its number —
    // reusing that number for a different title would mint two files sharing
    // one id (approve-by-id would be ambiguous).
    const rulesDir = path.join(storeDir, 'rules', io.harnessId)
    const numberTaken = (n: number): boolean => {
      const prefix = `${String(n).padStart(3, '0')}-`
      try { return fs.readdirSync(rulesDir).some((f) => f.startsWith(prefix)) } catch { return false }
    }
    for (let hops = 0; (numberTaken(number) || fs.existsSync(abs)) && hops < 200; hops += 1) {
      number += 1
      rel = rulePath(io.storeRoot, io.harnessId, number, category, title)
      abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
    }
    if (numberTaken(number) || fs.existsSync(abs)) return { kind: 'error', text: `refusing to overwrite ${rel} (rule files are write-once; 200 number slots exhausted?)` }
    const id = `${io.harnessId}/${String(number).padStart(3, '0')}`
    const rec: RuleRecord = {
      id, projectKey: project.projectKey, number, path: rel,
      category: category.toLowerCase(), title, sourceSession: io.sourceSession ?? 'manual', at: io.now().toISOString(),
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, renderRuleFile({ number, category: rec.category, title, sourceSession: io.sourceSession ?? 'manual', at: rec.at, body: body + '\n' }))
      await io.store.putRule(id, rec)
    } catch (error) {
      return { kind: 'error', text: `rule add failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` }
    }
    await io.syncNow(cwd)
    return { kind: 'success', text: `rule ${id} proposed (PROJECT tier, category ${rec.category}) — approve it into this machine's core set with: /chapters-rule approve ${id}. Session rules are not authored here: they are captured from your own messages (ADD RULE:), and /chapters-rule list --scope session shows them.` }
  }

  if (verb === 'list') {
    const all = parts.includes('--all')
    const proposedOnly = parts.includes('--proposed')
    const catIdx = parts.indexOf('--category')
    const cat = catIdx > -1 ? (parts[catIdx + 1] ?? '').toLowerCase() : ''
    const scopeIdx = parts.indexOf('--scope')
    const scope = scopeIdx > -1 ? (parts[scopeIdx + 1] ?? 'all') : 'all'
    if (scope !== 'all' && scope !== 'project' && scope !== 'session') {
      return { kind: 'error', text: `--scope wants project, session or all (got ${scope})` }
    }
    let rows = await known()
    if (scope !== 'all') rows = rows.filter((r) => r.scope === scope)
    if (cat !== '') rows = rows.filter((r) => r.category === cat)
    if (!all && !proposedOnly) rows = rows.filter((r) => r.status !== 'revoked')
    if (proposedOnly) rows = rows.filter((r) => r.status === 'proposed')
    if (rows.length === 0) return { kind: 'success', text: scope === 'all' ? 'no rules match' : `no ${scope}-tier rules match` }
    const text = rows.map((r) => `${r.id.padEnd(12)} ${r.scope.padEnd(8)} ${(r.scope === 'session' ? (r.status === 'revoked' ? 'revoked' : (r.active === true ? 'active' : (r.reviewOnly === true ? 'review   ' : 'inactive'))) : r.status).padEnd(10)} ${(r.pinned ? 'pin ' : '    ')}${r.category.padEnd(14)} ${r.title}`).join('\n')
    return { kind: 'success', text: `id           scope    status     pin   category       title\n${text}` }
  }

  if (verb === 'active') {
    const rows = await known()
    const ancestorsNote = io.ancestors === undefined ? ' (no session context — the session tier is reported unresolved, never guessed)' : ''
    if (io.harnessId === undefined) return { kind: 'error', text: 'rules surface not configured (harnessId absent)' }
    const built = buildRulesSection(mirror, {
      projectKey: project.projectKey, harnessId: io.harnessId,
      budgetTokens: io.budgetTokens ?? 1200,
      storeDir,
      ...(io.ancestors !== undefined ? { ancestorSessions: await io.ancestors() } : { ancestorSessions: new Set<string>() }),
      ...(io.projectCap !== undefined ? { projectCap: io.projectCap } : {}),
      ...(io.sessionCap !== undefined ? { sessionCap: io.sessionCap } : {}),
    })
    const head = `project tier: ${rows.filter((r) => r.scope === 'project' && r.status === 'core').length} approved-core on THIS machine, ${rows.filter((r) => r.scope === 'project' && r.status === 'proposed').length} proposed\n`
      + `session tier: ${rows.filter((r) => r.scope === 'session' && r.active === true).length} active for this session tree`
      + ` (${rows.filter((r) => r.scope === 'session' && (r.basis ?? '') === 'inferred').length} of them inferred by the model, never said by you)`
      + `\nmining posture: ${io.autoActivate === false ? 'REVIEW — mined rules stay inert until you approve them' : 'AUTO — mined rules govern on arrival (revoke is the undo)'}${ancestorsNote}\n`
    if (built.kind === 'refusal') return { kind: 'success', text: `${head}RENDERED: nothing — ${built.reason}` }
    if (built.kind === 'none') return { kind: 'success', text: `${head}RENDERED: zero rule bytes (an empty tier injects NOTHING — the tape-safe shape)` }
    return {
      kind: 'success',
      text: `${head}RENDERED: ${built.shown.project} project + ${built.shown.session} session rule(s), `
        + `withheld ${built.withheld.project} + ${built.withheld.session}; tokens ${built.tokens}\n\n${built.text}`,
    }
  }

  if (verb === 'approve' || verb === 'revoke') {
    let id = parts[1] ?? ''
    if (id === '') return { kind: 'error', text: `${verb} needs a rule id (see /chapters-rule list)` }
    if (!id.includes('/')) id = `${io.harnessId}/${id.padStart(3, '0')}`
    const rows = await known()
    const row = rows.find((r) => r.id === id)
    if (row === undefined) return { kind: 'error', text: `no rule ${id} in project ${project.slug} — unknown id (list shows what exists)` }
    // §7.5: a SUGGESTED model rule is exactly what approve is FOR; a marker rule
    // is already active, so approving it would be theatre.
    if (verb === 'approve' && row.scope === 'session' && row.reviewOnly !== true) {
      // §7.1: the session tier does not approve. Promoting it to the shared tier
      // is the human act, and it is a NEW rule file with its own id (§1.3).
      return { kind: 'error', text: `${id} is a SESSION rule already active for this session tree — there is nothing to approve. To make it bind your team: /chapters-rule add ${row.category} "${row.body.replace(/\s+/g, ' ').slice(0, 160)}"` }
    }
    try {
      // 'approve' is the verb; 'core' is the status — conflating them writes a
      // fact no resolver recognizes (caught by unit test)
      appendRuleStatusFact(mirror, io.harnessId, { rule: id, status: verb === 'approve' ? 'core' : 'revoked', at: io.now().toISOString() })
    } catch (error) {
      return { kind: 'error', text: `${verb} failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` }
    }
    await io.syncNow(cwd)
    return { kind: 'success', text: verb === 'approve'
      ? row.scope === 'session'
        ? `mined rule ${id} approved — it now governs this session tree (and stays LOCAL: session rules are never staged to the pool)`
        : `rule ${id} is CORE on THIS machine (other machines approve independently) — it will render into continuations from this workspace`
      : row.scope === 'session'
        ? `session rule ${id} revoked on this machine — out of every head in this tree, file bytes untouched (write-once)`
        : `rule ${id} revoked on this machine (out of the notice, still in the repo)` }
  }

  if (verb === 'pin' || verb === 'unpin') {
    let id = parts[1] ?? ''
    if (id === '') return { kind: 'error', text: `${verb} needs a rule id (see /chapters-rule list)` }
    if (!id.includes('/')) id = `${io.harnessId}/${id.padStart(3, '0')}`
    const rows = await known()
    if (!rows.some((r) => r.id === id)) return { kind: 'error', text: `no rule ${id} in project ${project.slug} — unknown id` }
    try {
      // §7.4: a pin is a per-machine FACT, never a rewrite of a write-once file.
      appendRulePinFact(mirror, io.harnessId, { rule: id, pinned: verb === 'pin', at: io.now().toISOString() })
    } catch (error) {
      return { kind: 'error', text: `${verb} failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` }
    }
    await io.syncNow(cwd)
    return { kind: 'success', text: verb === 'pin'
      ? `rule ${id} pinned on this machine — it is rendered into every rebuilt head regardless of caps or topicality (ground rules are OLD; ranking would evict them)`
      : `rule ${id} unpinned on this machine — it now competes for a capped slot by relevance` }
  }

  const depsRoute = (): string => {
    const cur = io.settings?.get('enrichment.route') ?? ''
    return cur === '' ? 'the conversation route' : `the ${cur} route`
  }

  if (verb === 'model') {
    // §7.5: rule mining may deserve a better model than annotation does. Persisted
    // in the shared settings table so both planes see it, exactly like the
    // enrichment override; `clear` falls back to riding the annotation call.
    if (io.settings === undefined) return { kind: 'error', text: 'the settings table is unavailable on this plane' }
    const arg = parts[1] ?? ''
    if (arg === '') {
      const cur = io.settings.get('rules.model') ?? ''
      return { kind: 'success', text: cur === ''
        ? `rules.model: (unset) — mining rides the enrichment call (${depsRoute()}), costing no extra inference`
        : `rules.model: ${cur} — one extra bounded call per chapter` }
    }
    try {
      await io.settings.put('rules.model', arg === 'clear' ? '' : arg)
    } catch (error) {
      return { kind: 'error', text: `model failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` }
    }
    return { kind: 'success', text: arg === 'clear'
      ? 'rules.model cleared — mining rides the enrichment call again'
      : `rules.model set to ${arg} — each chapter now costs one extra bounded call to mine its rules` }
  }

  if (verb === 'conflicts') {
    if (io.ask === undefined) return { kind: 'error', text: 'conflicts needs the conversation model route (not available on this plane)' }
    const rows = (await known()).filter((r) => (r.scope === 'project' && r.status === 'core') || r.active === true)
    if (rows.length < 2) return { kind: 'success', text: `only ${rows.length} active rule(s) — nothing to compare yet` }
    const listing = rows.map((r) => `[${r.id}] (${r.scope}/${r.category}) ${r.body.replace(/\s+/g, ' ')}`).join('\n')
    const prompt = 'These are the rules currently governing one agent session. Report ONLY genuine contradictions — pairs where following one means breaking the other — as lines "CONFLICT: <idA> vs <idB> — <one sentence>". Say "NO CONFLICTS" if there are none. Do not rewrite or merge any rule; do not add advice.\n\n' + listing
    try {
      const answer = await io.ask(prompt)
      const found = /CONFLICT:/i.test(answer)
      return { kind: 'success', text: `${found ? 'conflicts reported (nothing was changed — rule files are write-once; resolve with approve/revoke):' : 'no contradictions reported (nothing was changed):'}\n${answer.trim().slice(0, 2000)}` }
    } catch (error) {
      return { kind: 'error', text: `conflicts call failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` }
    }
  }

  return { kind: 'success', text: HELP }
}
