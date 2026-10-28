/**
 * The repair runner (#60) — apply what `audit()` found, through the doors that already exist.
 *
 * There is no second archive implementation here, on purpose. Every mutation is either
 *  - a call into the SAME save core the other five archive moments call (`saveSession`, now with its
 *    repair-only `span` / `supersede` / `attemptSalt` knobs), or
 *  - one pure registry transition (`supersedeChapter`, `raiseCounters`, `expireBookkeeping`,
 *    `releaseReservation`) run inside a `store.mutate` section (#59).
 * So a repaired chapter is byte-identical to a chapter that archived normally, and a repair cannot
 * drift from the pipeline it is fixing.
 *
 * Ordering the run (docs/architecture.md § Repair):
 *  1. audit (read-only, and the SAME function `dry-run` shows);
 *  2. write the journal FIRST — if the journal cannot be written, the run refuses to start;
 *  3. apply, journalling each move as it happens;
 *  4. re-audit and report the before/after counts, so the operator sees whether the repair worked
 *     rather than whether it ran.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { audit, coveringChapter, journalEntryInverse, markSupersededBy, raiseCounters, expireBookkeeping, supersedeChapter, type FindingClass, type Journal, type JournalEntry, type RepairFinding, type RepairFileSet } from './repair.ts'
import { appendChapters, releaseReservation, type SessionState } from './registry.ts'
import { parseFrontmatter } from './indexing.ts'
import type { ChapterRecord } from './archive.ts'
import { resolveStoredPath } from './archive.ts'
import { resolveStoreRoot } from './store.ts'
import type { RegistryStore } from './store.ts'
import { saveSession, type SaveSessionConfig } from './save-core.ts'
import type { SessionEventLike } from './types.ts'

/**
 * One refusal line → its class: the text before the first `': '`, or `'other'`. Grouping is presentation
 * only — every item is kept — because the class is shared and the FILE NAMES are the content an operator
 * needs (#101: 483 repeated `test-litter` lines buried 372 real findings in the maintainer's run, in the
 * command surface, because only the offline report had been aggregated).
 */
const refusalClassOf = (line: string): string => {
  const i = line.indexOf(':')
  return i > 0 ? line.slice(0, i).trim() : 'other'
}

export interface RefusalGroup { cls: string; items: string[] }

export function groupRefusals(refused: string[]): RefusalGroup[] {
  const order: string[] = []
  const map = new Map<string, string[]>()
  for (const r of refused) {
    const cls = refusalClassOf(r)
    const bucket = map.get(cls)
    if (bucket === undefined) { map.set(cls, [r]); order.push(cls) } else bucket.push(r)
  }
  // Loudest class first: the one that would otherwise fill the screen is the one to dispose of.
  return order.map((cls) => ({ cls, items: map.get(cls)! })).sort((a, b) => b.items.length - a.items.length)
}

/** How many named examples a grouped class keeps visible. The rest is COUNTED, never dropped silently. */
export const REFUSAL_EXAMPLES = 3

export function renderRefusalGroups(refused: string[], examples: number = REFUSAL_EXAMPLES): string[] {
  return groupRefusals(refused).map(({ cls, items }) => {
    const detail = (r: string): string => { const i = r.indexOf(':'); return i > 0 ? r.slice(i + 1).trim() : r }
    if (items.length === 1) return `refused: ${items[0]}`
    const keep = Math.max(1, examples)
    const shown = items.slice(0, Math.min(items.length, keep)).map(detail).join(' | ').slice(0, 300)
    const withheld = items.length - Math.min(items.length, keep)
    return `refused ×${String(items.length)} (${cls}): ${shown}`
      + (withheld > 0 ? `; ${String(withheld)} more of the same class` : '')
      + ' — each names its own file; nothing in this class is touched automatically'
  })
}

export interface RepairPorts {
  store: RegistryStore
  /** A PAYLOAD-BEARING read of the durable log (#58's lesson: never a metadata-only record list). */
  readLog(sessionId: string): Promise<SessionEventLike[] | null>
  /** The session's workspace cwd — the store root lives here. */
  cwd: string
  /** Every root session the registry knows about, so a sibling tree is not mistaken for litter (#60). */
  knownRoots?: string[] | undefined
  config: SaveSessionConfig
  log(message: string): void
  warn(message: string): void
}

export interface RepairOptions {
  sessionId: string
  /** Which classes to act on. `all` is the default for the operator, not for the tests. */
  classes: FindingClass[] | 'all'
  dryRun?: boolean
  /** Chapter-file paths already known from the registry, when no directory scan is possible. */
  listedPaths?: string[]
}

const ACTABLE: Record<FindingClass, boolean> = {
  'hollow-payload': true, 'never-archived-span': true, 'dead-citation': true,
  'ghost-plan-manifest': true, 'unreleased-reservation': true, 'countervalue-drift': true,
  // empty-artifact / duplicate-number / orphan-file are resolved BY the re-render of their chapter: a
  // 0-byte ref disappears when its chapter is superseded and re-rendered by the fixed renderer, and a
  // duplicate number is fixed by re-spending it correctly. Half-fixing them separately would leave a
  // record citing a file we moved. Report-only until their parent finding runs.
  'empty-artifact': false, 'duplicate-number': false, 'orphan-file': false, 'unregistered-file': true,
  'tampered-file': false, 'test-litter': false, unrecoverable: false,
}

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')

/** The file view of the store, from a real directory scan (the offline script's advantage over ctx.fs). */
export function fileSetFromDisk(cwd: string, storeRoot: string, rootSession: string, knownRoots: readonly string[] = []): RepairFileSet {
  const rel = (abs: string): string => path.relative(cwd, abs).split(path.sep).join('/')
  const subdirs = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => rel(path.join(dir, e.name)))
    } catch { return [] }
  }
  const listDir = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        return e.isDirectory() ? listDir(p) : [p]
      })
    } catch { return [] }
  }
  // The registry stores paths RELATIVE TO THE WORKSPACE (`.dsh-chapters/<root>/chapters/001-x.md`), so
  // the file set speaks the same dialect — comparing `root-1/chapters/…` against `.dsh-chapters/root-1/…`
  // is how a first draft invented an orphan for every chapter and called its own tree litter.
  const treeRoot = path.join(cwd, storeRoot, rootSession)
  const abs = (p: string): string => path.isAbsolute(p) ? p : path.join(cwd, p)
  const onDisk = listDir(treeRoot).map(rel)
  const bytesOf = (p: string): number => {
    try { return fs.statSync(abs(p)).size } catch { return -1 }
  }
  return {
    exists: (p) => fs.existsSync(abs(p)),
    bytes: bytesOf,
    shaMatches: (p, sha) => {
      try { return sha256(fs.readFileSync(abs(p))) === sha } catch { return false }
    },
    chapterPaths: onDisk.filter((p) => p.includes('/chapters/') && p.endsWith('.md') && !p.includes('/plan-')),
    artifactPaths: onDisk.filter((p) => p.includes('/artifacts/')),
    emptyArtifactPaths: onDisk.filter((p) => p.includes('/artifacts/') && bytesOf(p) === 0),
    // ROOTS are the immediate SUBDIRECTORIES of the store root that NO registry row claims. Two false
    // starts, both measured on the first real run: `listDir` returns FILES, so every chapter became a
    // "second root" (36,000 findings), and then every OTHER SESSION's legitimate tree did (634). One
    // directory per root session is the normal shape of this store — litter is a directory nothing owns.
    roots: subdirs(resolveStoreRoot(cwd, storeRoot)).filter((d) => !knownRoots.includes(path.basename(d))),
    // the #58 signature is a fact about the BYTES, so read it from the bytes
    looksLikeShell: (p) => {
      try {
        const t = fs.readFileSync(abs(p), 'utf8')
        return /tool: unknown/.test(t) || /arguments: \{\}/.test(t) || /result \(seq \d+, 0 B\)/.test(t)
      } catch { return false }
    },
    canScan: true,
  }
}

/** The same view WITHOUT a directory scan — what the host can offer, declared honestly blind. */
export function fileSetFromRegistry(records: readonly ChapterRecord[], existsSync: (p: string) => boolean): RepairFileSet {
  return {
    exists: (p) => existsSync(p),
    bytes: () => 0,
    shaMatches: () => true,
    chapterPaths: records.map((r) => r.path),
    artifactPaths: records.flatMap((r) => r.artifacts.map((a) => a.path)),
    emptyArtifactPaths: records.flatMap((r) => r.artifacts.filter((a) => a.bytes === 0).map((a) => a.path)),
    canScan: false,
  }
}

/** Log facts the audit needs, derived from the durable events — never from the registry's memory. */
function logFacts(events: readonly SessionEventLike[]): { turnEndSeqs: number[]; collections: Array<{ from: number; to: number }> } {
  const turnEndSeqs = events.filter((e) => e.type === 'turn/end').map((e) => e.seq)
  const collections = events
    .filter((e) => e.type === 'turn/end')
    .map((e) => ({ from: e.seq, to: e.seq }))
  return { turnEndSeqs, collections }
}

export interface RepairOutcome {
  journalId: string
  findingsBefore: RepairFinding[]
  findingsAfter: RepairFinding[]
  blindSpots: FindingClass[]
  applied: JournalEntry[]
  refused: string[]
}

/**
 * Run the repair. `dryRun` produces the same audit and the same plan — it simply writes nothing, which
 * is what makes `dry-run` trustworthy as a preview of `apply`.
 */
export async function runRepair(ports: RepairPorts, opts: RepairOptions): Promise<RepairOutcome> {
  const { store, cwd, config } = ports
  const journalId = new Date().toISOString().replace(/[:.]/g, '-')
  const state0 = await store.get(opts.sessionId)

  const logEvents = await ports.readLog(opts.sessionId)
  if (logEvents === null || logEvents.length === 0) {
    // Invariant 1 is the whole reason repair exists. No log, nothing to re-derive from: say WHICH
    // sessions are unrecoverable rather than reporting a clean store.
    return {
      journalId, findingsBefore: [], findingsAfter: [], blindSpots: ['unrecoverable'], applied: [],
      refused: [`session ${opts.sessionId} has no readable durable log — its knowledge cannot be re-derived (unrecoverable)`],
    }
  }

  // ONE closure does both audits. Two separate call sites drifted: the after-audit forgot
  // `ports.knownRoots`, so it called every sibling session tree `test-litter`, and a journal reported
  // "25 findings remain" where 1 was real. A before/after number is only worth printing — or storing in
  // a journal — if both sides are computed by the same call with the same inputs (#60).
  const auditNow = (st: SessionState) => audit({
    sessionId: opts.sessionId,
    cwd,
    state: st,
    files: opts.listedPaths !== undefined
      ? fileSetFromRegistry(st.chapters, () => false)
      : fileSetFromDisk(cwd, config.artifactStoreRoot, st.rootSession, ports.knownRoots ?? []),
    log: logFacts(logEvents) as never,
  })
  const before = auditNow(state0)
  const wanted = opts.classes === 'all' ? before.findings : before.findings.filter((f) => (opts.classes as FindingClass[]).includes(f.class))
  const actionable = wanted.filter((f) => ACTABLE[f.class])
  const deferred = wanted.filter((f) => !ACTABLE[f.class])

  if (opts.dryRun) {
    ports.log(`repair dry-run ${opts.sessionId}: ${actionable.length} actionable, ${deferred.length} report-only`)
    return { journalId, findingsBefore: before.findings, findingsAfter: before.findings, blindSpots: before.blindSpots, applied: [], refused: deferred.map((f) => `${f.class}: ${f.detail}`) }
  }

  // JOURNAL FIRST. An applied run with no journal is a story nobody can check or undo.
  const repairsDir = path.join(cwd, config.artifactStoreRoot, state0.rootSession, 'repairs')
  const journal: Journal = {
    id: journalId, sessionId: opts.sessionId, startedAt: Date.now(),
    classes: [...new Set(actionable.map((f) => f.class))], completedAt: null,
    entries: [], findingsBefore: before.findings.length, findingsAfter: before.findings.length,
  }
  try {
    fs.mkdirSync(repairsDir, { recursive: true })
    fs.writeFileSync(path.join(repairsDir, `${journalId}.json`), `${JSON.stringify(journal, null, 2)}\n`)
  } catch (error) {
    return { journalId, findingsBefore: before.findings, findingsAfter: before.findings, blindSpots: before.blindSpots, applied: [], refused: [`journal could not be written (${String((error as Error).message).slice(0, 120)}) — refusing to apply anything`] }
  }
  const flush = (): void => {
    try {
      fs.writeFileSync(path.join(repairsDir, `${journalId}.json`), `${JSON.stringify(journal, null, 2)}\n`)
    } catch (error) {
      ports.warn(`repair journal ${journalId} could not be updated: ${String((error as Error).message).slice(0, 100)}`)
    }
  }

  const quarantineDir = path.join(cwd, config.artifactStoreRoot, state0.rootSession, '.repair-quarantine')
  void 0
  const quarantine = async (relPath: string): Promise<void> => {
    const absP = path.join(cwd, relPath)
    if (!fs.existsSync(absP)) return
    const to = path.join(quarantineDir, relPath.split('/').pop() ?? 'file')
    fs.mkdirSync(quarantineDir, { recursive: true })
    const beforeSha = sha256(fs.readFileSync(absP))
    fs.copyFileSync(absP, to)
    // every journal path is stored in the SAME dialect the registry uses (relative to the workspace
    // cwd) — a mix of absolute and relative is how a restore silently finds nothing to undo (#60)
    journal.entries.push({ kind: 'quarantine', path: relPath, beforeSha, afterSha: beforeSha, to: path.relative(cwd, to).split(path.sep).join('/') })
    flush()
  }

  const refused: string[] = deferred.map((f) => `${f.class}: ${f.detail}`)

  for (const f of actionable) {
    try {
      if (f.class === 'hollow-payload' && f.target.fromSeq !== undefined && f.target.toSeq !== undefined && f.target.number !== undefined) {
        const huskPath = state0.chapters.find((c) => c.number === f.target.number)?.path
        // "already in the archive" is a THROW inside save-core, not an outcome — and for a repair it is
        // an EXPECTED answer (an earlier run, or the door itself, archived the span). Swallow it into the
        // same no-records shape so the coverage check below can supersede the husk by what already covers
        // it; a throw reaching the per-finding catch would strand the record forever (#60).
        let out: { records: ChapterRecord[]; skipped: string | null; warnings: string[] }
        try {
          out = await saveSession({
            events: logEvents as SessionEventLike[], sessionId: opts.sessionId, cwd, store, config,
            span: { fromSeq: f.target.fromSeq!, toSeq: f.target.toSeq! },
            supersede: { over: f.target.number!, reason: 'hollow-payload' },
            attemptSalt: `repair:${journalId}`,
          })
        } catch (error) {
          out = { records: [], skipped: 'already-archived', warnings: [] }
          ports.log(`ch.${f.target.number}: the re-read said "already archived" (${String((error as Error).message).slice(0, 60)}) — looking for what covers the span`)
        }
        if (out.records.length === 0) {
          // #60: a repair run after the first one finds the span ALREADY re-archived, so the re-read is
          // a legitimate no-op — and the husk record would circulate forever. Hand it to whichever
          // active chapter now covers its span instead of refusing.
          const fresh = await store.get(opts.sessionId)
          const cover = coveringChapter(fresh, f.target.fromSeq, f.target.toSeq, f.target.number)
          if (cover.length === 0 || f.target.number === undefined) {
            refused.push(`hollow-payload ch.${f.target.number}: the re-read rendered nothing (${out.skipped ?? 'no records'}) and no active chapter covers ${f.target.fromSeq}-${f.target.toSeq} — left in place, nothing was superseded`)
            continue
          }
          const marked = markSupersededBy(fresh, f.target.number, cover[0]!.number, 'hollow-payload')
          if (marked.problem !== undefined) { refused.push(`hollow-payload ch.${f.target.number}: ${marked.problem}`); continue }
          // #101: `mutate(id, () => snapshot)` is a stale `put` wearing a mutate's clothes — the fn must
          // apply the change to the row mutate hands it, because another door may have committed between
          // the `get` above and this write (measured once already: an enrichment put at 04:53:52.841
          // rewound a compaction commit from 04:53:50.915). Re-derive from the fresh row; if the chapter
          // we meant to supersede is gone or changed, refuse rather than resurrect a snapshot.
          // captured, not re-read: `f.target.number` is proven non-undefined by the check above, and a
          // closure cannot see that narrowing (a cast would have hidden the case where it ever changes).
          const hollowTarget = f.target.number
          const hollowCover = cover[0]!.number
          await store.mutate(opts.sessionId, (live) => {
            const re = markSupersededBy(live, hollowTarget, hollowCover, 'hollow-payload')
            if (re.problem !== undefined) { refused.push(`hollow-payload ch.${String(hollowTarget)}: ${re.problem} (row moved during repair)`); return live }
            return re.state
          })
          journal.entries.push({ kind: 'registry', path: fresh.chapters.find((c) => c.number === f.target.number)?.path ?? `ch.${f.target.number}`, beforeSha: null, afterSha: cover[0]!.sha256 })
          flush()
          ports.log(`superseded hollow ch.${f.target.number} by ${cover.length} chapter(s) [${cover.map((c) => c.number).join(', ')}] that together carry seqs ${f.target.fromSeq}-${f.target.toSeq}`)
          continue
        }
        if (huskPath !== undefined) await quarantine(huskPath)
        journal.entries.push({ kind: 'write', path: out.records[0]!.path, beforeSha: null, afterSha: out.records[0]!.sha256 })
        flush()
        ports.log(`repaired hollow ch.${f.target.number} → ch.${out.records[0]!.number} (${out.records.length} chapter(s), seqs ${f.target.fromSeq}-${f.target.toSeq})`)
      } else if (f.class === 'never-archived-span' && f.target.fromSeq !== undefined && f.target.toSeq !== undefined) {
        const out = await saveSession({
          events: logEvents as SessionEventLike[], sessionId: opts.sessionId, cwd, store, config,
          span: { fromSeq: f.target.fromSeq, toSeq: f.target.toSeq },
          attemptSalt: `repair:${journalId}`,
        })
        for (const r of out.records) journal.entries.push({ kind: 'write', path: r.path, beforeSha: null, afterSha: r.sha256 })
        flush()
        if (out.records.length === 0) refused.push(`never-archived-span ${f.target.fromSeq}-${f.target.toSeq}: rendered nothing (${out.skipped ?? 'unknown'})`)
        else ports.log(`archived the missed span ${f.target.fromSeq}-${f.target.toSeq} as ${out.records.length} chapter(s)`)
      } else if (f.class === 'dead-citation' && f.target.path !== undefined) {
        // Satisfy the citation: render THAT manifest chapter's own span and write it AT the cited path.
        const key = Object.keys(state0.plans ?? {}).find((k) => (state0.plans?.[k]?.chapters ?? []).some((c) => c.path === f.target.path))
        const pc = key !== undefined ? state0.plans?.[key]?.chapters?.find((c) => c.path === f.target.path) : undefined
        if (pc === undefined) { refused.push(`dead-citation ${f.target.path}: no manifest chapter carries its span`); continue }
        const out = await saveSession({
          events: logEvents as SessionEventLike[], sessionId: opts.sessionId, cwd, store, config,
          span: { fromSeq: pc.startSeq, toSeq: pc.endSeq },
          attemptSalt: `repair:${journalId}`,
        })
        const written = out.records[0]
        if (written === undefined) { refused.push(`dead-citation ${f.target.path}: the span rendered nothing (${out.skipped ?? 'no records'})`); continue }
        // The cited PATH is the promise; move the bytes onto it (a copy of the same content, same hash).
        const fromAbs = resolveStoredPath(cwd, written.path)
        const toAbs = resolveStoredPath(cwd, f.target.path)
        if (fs.existsSync(fromAbs)) {
          fs.mkdirSync(path.dirname(toAbs), { recursive: true })
          fs.copyFileSync(fromAbs, toAbs)
          journal.entries.push({ kind: 'write', path: toAbs, beforeSha: null, afterSha: sha256(fs.readFileSync(toAbs)) })
          await store.mutate(opts.sessionId, (fresh) => ({
            ...fresh,
            chapters: fresh.chapters.map((c): ChapterRecord => (c.number === written.number ? { ...c, path: f.target.path! } : c)),
          }))
          flush()
          ports.log(`dead citation satisfied: ${f.target.path} now exists with the re-rendered bytes (chapter ${written.number})`)
        }
      } else if (f.class === 'unregistered-file' && f.target.path !== undefined) {
        // The bytes ARE the archive; only the registry row was lost. Re-read the file's own
        // frontmatter (the store's ONE parser, src/indexing.ts) and hand the row back. Nothing on disk
        // moves — this is not a rewrite, it is the registry catching up with the store.
        const relPath = f.target.path
        const absFile = path.join(cwd, relPath)
        if (!fs.existsSync(absFile)) { refused.push(`unregistered-file ${relPath}: vanished between audit and apply — re-run`); continue }
        const fm = parseFrontmatter(fs.readFileSync(absFile, 'utf8'))
        const range = Array.isArray(fm.seqRange) ? fm.seqRange.map((x) => Number(x)) : []
        const num = /\/(\d{3})-/.exec(relPath)?.[1]
        if (range.length !== 2 || Number.isNaN(range[0]) || num === undefined) {
          refused.push(`unregistered-file ${relPath}: frontmatter has no usable seqRange — it cannot be re-registered honestly`)
          continue
        }
        const taken = state0.chapters.some((c) => c.number === Number(num))
        if (taken) {
          // Two files claiming one number is #59's twin. Choosing a winner is a HUMAN call: the loser's
          // bytes stay, and the run says so instead of silently demoting knowledge.
          refused.push(`unregistered-file ${relPath}: number ${Number(num)} is already carried by another record — a lost-update twin. Re-registering it would need a new number, which means renumbering a chapter; forbidden. A human decides which of the two survives.`)
          continue
        }
        const tokensField = typeof fm.tokens === 'string' ? Number(fm.tokens.split('#')[0]?.trim() ?? NaN) : NaN
        const record: ChapterRecord = {
          number: Number(num),
          path: relPath,
          title: typeof fm.title === 'string' ? fm.title : relPath,
          summary: typeof fm.summary === 'string' ? fm.summary : '',
          startSeq: range[0]!, endSeq: range[1]!,
          topics: Array.isArray(fm.topics) ? fm.topics : [],
          // `messages` is NOT in chapter frontmatter. An absent field means "unknown"; writing 0 would
          // claim a husk (render.ts: "absent for records written before counts existed — never a lying
          // zero"), so it stays absent and the audit reads it as unknown, not as damage.
          // The registry's anchor is the hash of the WHOLE file (archive.ts: "Hash the whole file, so
          // verifyChapter() can re-check it with no knowledge of frontmatter layout"). The `sha256:`
          // field INSIDE the frontmatter is a different thing — the body-hash that anchors enrichment —
          // and copying it into the record made 162 honest re-registrations look tampered.
          sha256: sha256(fs.readFileSync(absFile)),
          estimatedTokens: Number.isFinite(tokensField) ? tokensField : 0,
          artifacts: [],
          repairs: [{ class: 'unregistered-file', over: 0, at: Date.now() }],
        }
        // append + counter-raise in ONE section: a re-registered number must never sit at or above
        // `nextChapterNumber`, or the next door collides with it (#59's twin).
        await store.mutate(opts.sessionId, (fresh) => raiseCounters(appendChapters(fresh, [record])))
        journal.entries.push({ kind: 'registry', path: relPath, beforeSha: null, afterSha: record.sha256 })
        flush()
        ports.log(`re-registered ${relPath} (seqs ${record.startSeq}-${record.endSeq}, ${record.estimatedTokens} tokens) — file untouched, row restored`)
      } else if (f.class === 'unreleased-reservation') {
        const key = /reservation (\S+) holds/.exec(f.detail)?.[1]
        if (key !== undefined) {
          await store.mutate(opts.sessionId, (st) => releaseReservation(st, key))
          journal.entries.push({ kind: 'registry', path: opts.sessionId, beforeSha: null, afterSha: null })
          flush()
          ports.log(`released reservation ${key}`)
        }
      } else if (f.class === 'ghost-plan-manifest') {
        const key = /manifest (\S+) promises/.exec(f.detail)?.[1]
        if (key !== undefined) {
          await store.mutate(opts.sessionId, (st) => expireBookkeeping(st, [key]))
          flush()
          ports.log(`expired the ghost finalize manifest ${key} (its numbers stay spent)`)
        }
      } else if (f.class === 'countervalue-drift') {
        await store.mutate(opts.sessionId, (st) => raiseCounters(st))
        flush()
        ports.log('counters raised to the first unspent number (upward only)')
      }
    } catch (error) {
      // One bad finding must not abort the run — #59's poison-pill lesson, applied to repair itself.
      ports.warn(`repair of ${f.class} (${opts.sessionId}) failed: ${String((error as Error).message).slice(0, 140)}`)
      refused.push(`${f.class}: failed — ${String((error as Error).message).slice(0, 100)}`)
    }
  }

  // the same call, the same inputs — see `auditNow` above
  const after = auditNow(await store.get(opts.sessionId))
  journal.completedAt = Date.now()
  journal.findingsAfter = after.findings.length
  flush()

  return { journalId, findingsBefore: before.findings, findingsAfter: after.findings, blindSpots: before.blindSpots, applied: journal.entries, refused }
}

/** Undo a whole applied run, newest entry first. Derived inverses — the journal is not trusted to describe itself. */
export async function restoreRepair(ports: RepairPorts, journalId: string, sessionId: string): Promise<{ undone: number; problems: string[] }> {
  const { store, cwd, config } = ports
  const state = await store.get(sessionId)
  const file = path.join(cwd, config.artifactStoreRoot, state.rootSession, 'repairs', `${journalId}.json`)
  if (!fs.existsSync(file)) return { undone: 0, problems: [`no journal ${journalId} under ${path.dirname(file)}`] }
  const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as Journal
  const at = (p: string): string => path.isAbsolute(p) ? p : path.join(cwd, p)
  const problems: string[] = []
  let undone = 0
  for (const entry of [...journal.entries].reverse()) {
    const inverse = journalEntryInverse(entry)
    const target = at(entry.path)
    const moved = entry.to !== undefined ? at(entry.to) : undefined
    try {
      if (inverse.undo === 'remove' && fs.existsSync(target)) {
        // undoing a repair is a MOVE too: the bytes a repair wrote go to quarantine, they are not deleted
        fs.mkdirSync(path.dirname(moved ?? target), { recursive: true })
        fs.copyFileSync(target, moved ?? path.join(cwd, config.artifactStoreRoot, state.rootSession, '.repair-quarantine', path.basename(target)))
        fs.rmSync(target)
        undone += 1
      } else if (inverse.undo === 'restore-from-quarantine' && moved !== undefined && fs.existsSync(moved) && !fs.existsSync(target)) {
        fs.copyFileSync(moved, target)
        undone += 1
      } else if (inverse.undo === 'restore-registry-rev') {
        problems.push(`registry change ${entry.path} cannot be un-applied by file restore — the row is append-only; run audit again to see what remains`)
      }
    } catch (error) {
      problems.push(`restore of ${entry.path} failed: ${String((error as Error).message).slice(0, 100)}`)
    }
  }
  // The RECORDS a repair committed stay: a restored file set is re-audited, never hand-reverted.
  await store.mutate(sessionId, (fresh) => fresh)
  return { undone, problems }
}

export type { RepairFinding, SessionState }

/**
 * Bound a repair report so one command result cannot outgrow the archive (#117).
 *
 * Why this is a function and not arithmetic in the command: the same rule has to hold for the in-host
 * `/chapters-repair` and the offline runner, and a decision that exists in two places is a decision that
 * drifts (#59's lesson). Pure, so the three things that matter are rows rather than intentions — the count
 * always survives, the withheld remainder is counted and named with a remedy, and a short report is not
 * wrapped in ceremony.
 *
 * The trigger was measured: a 23-session dry-run printed 2,796 findings as ONE `command/done` result —
 * 311 KB, an event larger than `2 × chapterTokenTarget` — which is what made that session permanently
 * un-compactable by `chapters_continue`. Clipping is forbidden by invariant, so the only honest options were
 * to stop generating the monster or to cap with a remedy. Both are here: the cap, and the count leading.
 */
export function capReportLines(body: readonly string[], capLines: number): { shown: string[]; withheld: number; capLine: string } {
  const cap = Math.max(1, Math.floor(capLines))
  const withheld = Math.max(0, body.length - cap)
  if (withheld === 0) return { shown: [...body], withheld: 0, capLine: '' }
  return {
    shown: body.slice(0, cap),
    withheld,
    capLine: `  … report capped at ${String(cap)} of ${String(body.length)} lines (repairReportMaxLines) — ${String(withheld)} withheld, nothing dropped: per-session detail is /chapters-repair dry-run <session-id>, or raise the cap`,
  }
}
