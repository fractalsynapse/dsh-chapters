/**
 * Chapter removal (#255) — the operator door that deletes BAD knowledge for real.
 *
 * The field case: a prompt meant for another project typed into a project session; its chapters
 * contaminate every derived surface downstream. Repair (#60) supersedes damage and keeps bytes;
 * removal deletes them. The maintainer's rule: *bad bytes leave the memory; the log is what lets
 * you admit you were wrong.*
 *
 * What this module guarantees, each pinned by tests/unit/removal.test.ts:
 * - **journal before deletion.** A journal that cannot be written stops the run before the first
 *   unlink — the #60 write-ahead discipline, same shape, different word.
 * - **the stub holds the watermark.** The registry record survives with `status: 'removed'`
 *   keeping number/span/path/sha256/artifacts: the watermark is `max(endSeq)` over ALL records, and
 *   an erased record would let an auto-archive moment re-capture the poisoned span (#59 poison).
 * - **orphan math protects shared blobs.** Artifacts are content-addressed and deduplicated across
 *   the subtree; a blob dies only when no ACTIVE, non-target record anywhere in the project names it.
 * - **one path dialect.** Comparisons go through `sameStoredPath`, never `===` (#69).
 * - **detected is delivered (#61).** Dangling citations are reported to the operator AND appended
 *   to `<store-root>/removals/missing-access.log`, never returned into a void.
 *
 * Restore is re-derivation from the durable log (Task 7, same file) — never resurrection of bytes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveStoredPath, sameStoredPath, type ChapterRecord } from './archive.ts'
import { ancestorPath, buildIndex, isActiveChapter, isRemovedChapter, type SessionState } from './registry.ts'
import type { RegistryStore } from './store.ts'
// One dialect, one direction: the removal imports the store→pool mapping from sync (it never
// re-implements it — a second mapping is a second truth), and sync never imports removal.
import { planStoreToRepo, type RemovedGuard } from './sync.ts'

export type RemovalRows = readonly (readonly [string, SessionState])[]

export interface RemovalTarget {
  sessionId: string
  rootSession: string
  record: ChapterRecord
}

export type ResolveOutcome = { target: RemovalTarget } | { refusal: string }

export interface RemovalFile {
  abs: string
  /** The stored-path dialect of the registry record (what `sameStoredPath` compares). */
  stored: string
  bytes: number
}

export interface DanglingRef {
  /** The surviving chapter (or artifact of the search) that still names the removed one. */
  referrer: string
  /** Which spelling of the removed chapter the referrer cites. */
  needle: string
  how: 'cited-in-body' | 'cited-in-toc'
}

export interface RemovalPlan {
  targets: RemovalTarget[]
  chapterFiles: RemovalFile[]
  /** Orphan blobs + plan documents: each named ONLY by the targets. */
  blobFiles: RemovalFile[]
  dangling: DanglingRef[]
  /** Files the plan expected on disk and did not find — stated, never silent (a stub can outrun a lost tree). */
  missing: string[]
}

export interface ApplyPorts {
  store: RegistryStore
  cwd: string
  rows: RemovalRows
  now: () => string
  /** The resolved store ROOT (the directory holding session trees). Defaults to `<cwd>/.dsh-chapters`. */
  storeDir?: string | undefined
  /** Linked project: the removal also unlinks the mirror copies, so the sync commit carries the
   * deletion (`publishIntoClone` copies — it can never propagate a deletion by itself). Absent ⇒
   * store-only removal (an unlinked project), which is the normal state, not an error. */
  cloneDir?: string | undefined
  projectKey?: string | undefined
}

export interface ApplyOutcome {
  journalId: string
  /** Stored paths actually unlinked (or already absent). */
  removed: string[]
  /** session:number of every record flipped to the removed stub. */
  stubbed: string[]
  problems: string[]
  dangling: DanglingRef[]
  bytes: number
}

export interface Journal {
  journalId: string
  at: string
  cwd: string
  /** 'planned' is written BEFORE the first unlink; 'applied'/'partial' rewrite it after. */
  status: 'planned' | 'applied' | 'partial'
  entries: {
    sessionId: string
    number: number
    title: string
    startSeq: number
    endSeq: number
    path: string
    sha256: string
    removedFiles: string[]
    appliedAt?: string
  }[]
  problems?: string[]
}

// ------------------------------------------------------------------ resolve

const nearCandidates = (raw: string, rows: RemovalRows, cwd: string): string => {
  const base = (raw.split('/').pop() ?? raw).toLowerCase()
  const out: string[] = []
  for (const [sessionId, state] of rows) {
    for (const c of state.chapters) {
      if (!isActiveChapter(c)) continue
      const name = c.path.split('/').pop() ?? ''
      if (name.toLowerCase().includes(base) || base.includes(name.toLowerCase().replace('.md', ''))) {
        out.push(`${sessionId}:${c.number} → ${c.path}`)
      }
      if (out.length >= 5) break
    }
  }
  return out.length === 0 ? 'no near candidates either' : `near candidates: ${out.join(', ')}`
}

/**
 * Resolve one operator-supplied id to exactly one ACTIVE chapter record. Accepted dialects:
 * registry path (the `list`/journal output), pool path from a search hit
 * (`chapters/<key>/<session>/<file>.md` — matched by its `<session>/<file>` tail),
 * `<sessionId>:<number>`, and a bare TOC display ordinal (needs the caller's session, because the
 * ordinal is a position in the caller's ancestor-path flat index, not a registry number).
 * Zero matches, several matches, or a tombstone each refuse with specifics — removal is destructive
 * and never guesses.
 */
export function resolveRemovalId(
  raw: string,
  rows: RemovalRows,
  cwd: string,
  callerSessionId?: string,
): ResolveOutcome {
  const norm = raw.trim()
  if (norm === '') return { refusal: 'empty id' }
  const ordinal = /^\d+$/.test(norm)
  if (ordinal && callerSessionId === undefined) {
    return { refusal: `bare ordinal "${norm}" needs a session context (it is a position in a TOC, not a registry number) — use <sessionId>:<number> or a path from /chapters-remove list` }
  }
  const getter = (id: string): SessionState | undefined => rows.find(([k]) => k === id)?.[1]
  let ordinalHit: { sessionId: string; number: number } | null = null
  if (ordinal && callerSessionId !== undefined) {
    const entries = buildIndex(ancestorPath(getter, callerSessionId), (id) => getter(id) ?? undefined, () => 'ok')
    const n = Number(norm)
    const e = entries[n - 1]
    if (e !== undefined) ordinalHit = { sessionId: e.authorSession, number: e.number }
  }
  const [head, tail] = [norm.slice(0, Math.max(norm.lastIndexOf(':'), 0)), norm.slice(norm.lastIndexOf(':') + 1)]
  const colonHit = norm.includes(':') && /^\d+$/.test(tail) ? { sessionId: head, number: Number(tail) } : null
  const parts = norm.split('/')
  const poolBase = parts[parts.length - 1]!
  const poolSession = parts.length >= 2 ? parts[parts.length - 2]! : ''

  const matches: RemovalTarget[] = []
  let tombstone = ''
  for (const [sessionId, state] of rows) {
    for (const c of state.chapters) {
      const isMatch = ordinal
        ? ordinalHit !== null && ordinalHit.sessionId === sessionId && ordinalHit.number === c.number
          // the ordinal of a REMOVED chapter can exist on a stale page — name the tombstone honestly
          || (ordinalHit === null && sessionId === callerSessionId && c.number === Number(norm))
          : colonHit !== null
            ? colonHit.sessionId === sessionId && colonHit.number === c.number
            : sameStoredPath(norm, c.path, cwd)
              || sameStoredPath(resolveStoredPath(cwd, norm), c.path, cwd)
              || (poolSession !== '' && poolBase.endsWith('.md') && c.path.endsWith(`/${poolSession}/chapters/${poolBase}`))
              // third dialect (#255): searchLocalStore answers paths relative to the STORE ROOT
              // (`<session>/chapters/<file>`); any raw that is a boundary-suffix of a record path
              // resolves — ambiguity across records still refuses.
              || (norm.includes('/') && c.path.endsWith(`/${norm}`))
              || (parts.length === 1 && (c.path.split('/').pop() ?? '') === poolBase)
      if (!isMatch) continue
      if (!isActiveChapter(c)) {
        if (isRemovedChapter(c)) tombstone = `${sessionId}:${c.number} (${c.path})`
        continue
      }
      matches.push({ sessionId, rootSession: state.rootSession, record: c })
    }
  }
  if (matches.length === 1) return { target: matches[0]! }
  if (matches.length > 1) {
    return { refusal: `ambiguous "${norm}" — ${matches.length} active chapters match: ${matches.map((m) => `${m.sessionId}:${m.record.number} → ${m.record.path}`).join(', ')}; nothing was removed` }
  }
  if (tombstone !== '') return { refusal: `${tombstone} — already removed (its bytes left the store; the stub is kept on purpose so the watermark cannot rewind)` }
  return { refusal: `no active chapter matches "${norm}" — ${nearCandidates(norm, rows, cwd)}` }
}

// ------------------------------------------------------------------ plan

const fileEntry = (stored: string, cwd: string, missing: string[]): RemovalFile | null => {
  const abs = resolveStoredPath(cwd, stored)
  try {
    return { abs, stored, bytes: fs.statSync(abs).size }
  } catch {
    missing.push(stored)
    return null
  }
}

/**
 * The exact deletion set + the dangling report, from registry rows and the filesystem — written
 * for the dry-run and consumed unchanged by apply. Reads only; deletes nothing.
 */
export function planRemoval(opts: {
  targets: readonly RemovalTarget[]
  rows: RemovalRows
  cwd: string
}): RemovalPlan {
  const { targets, rows, cwd } = opts
  const targetKeys = new Set(targets.map((t) => `${t.sessionId}#${t.record.number}`))
  // Active refs from NON-target records — the orphan test's other side. Removed/superseded stubs do
  // NOT hold blobs open: their references are exactly what the operator judged bad.
  const activeRefs: string[] = []
  const survivingChapters: { path: string }[] = []
  for (const [sessionId, state] of rows) {
    for (const c of state.chapters) {
      if (!isActiveChapter(c) || targetKeys.has(`${sessionId}#${c.number}`)) continue
      survivingChapters.push({ path: c.path })
      // A survivor's OWN file is a live reference too: a record may name another chapter's path as
      // an artifact (measured by the path-collision test — the orphan math must not schedule the
      // neighbor's bytes for deletion).
      activeRefs.push(c.path)
      for (const a of c.artifacts) activeRefs.push(a.path)
      for (const p of c.plans ?? []) activeRefs.push(p.artifactPath)
      for (const d of c.planDocs ?? []) activeRefs.push(d.path)
    }
  }
  const missing: string[] = []
  const chapterFiles: RemovalFile[] = []
  const blobFiles: RemovalFile[] = []
  const seen = new Set<string>()
  for (const t of targets) {
    const f = fileEntry(t.record.path, cwd, missing)
    if (f !== null && !seen.has(f.abs)) { seen.add(f.abs); chapterFiles.push(f) }
    const candidates = [
      ...t.record.artifacts.map((a) => a.path),
      ...(t.record.plans ?? []).map((p) => p.artifactPath),
      ...(t.record.planDocs ?? []).map((d) => d.path),
    ]
    for (const p of [...new Set(candidates)]) {
      if (sameStoredPath(p, t.record.path, cwd)) continue
      if (activeRefs.some((r) => sameStoredPath(r, p, cwd))) continue
      const bf = fileEntry(p, cwd, missing)
      if (bf !== null && !seen.has(bf.abs)) { seen.add(bf.abs); blobFiles.push(bf) }
    }
  }
  const dangling = scanDangling(rows, targets, cwd, targetKeys)
  return { targets: [...targets], chapterFiles, blobFiles, dangling, missing }
}

/**
 * Every SURVIVING chapter body that still names a removed chapter — by any dialect: the stored path,
 * the filename, or the absolute path a TOC copy would carry. This is the operator's "should the
 * referrer stay?" list, and the seed for missing-access.log.
 */
export function scanDangling(rows: RemovalRows, targets: readonly RemovalTarget[], cwd: string, targetKeys?: Set<string>): DanglingRef[] {
  const keys = targetKeys ?? new Set(targets.map((t) => `${t.sessionId}#${t.record.number}`))
  const needles: { needle: string; target: string }[] = []
  for (const t of targets) {
    const name = t.record.path.split('/').pop() ?? t.record.path
    for (const n of new Set([t.record.path, name, resolveStoredPath(cwd, t.record.path)])) {
      needles.push({ needle: n, target: t.record.path })
    }
  }
  const out: DanglingRef[] = []
  const done = new Set<string>()
  for (const [sessionId, state] of rows) {
    for (const c of state.chapters) {
      if (!isActiveChapter(c) || keys.has(`${sessionId}#${c.number}`)) continue
      let text: string
      try { text = fs.readFileSync(resolveStoredPath(cwd, c.path), 'utf8') } catch { continue }
      for (const { needle, target } of needles) {
        if (needle === c.path || !text.includes(needle)) continue
        const id = `${c.path}|${target}`
        if (done.has(id)) continue
        done.add(id)
        out.push({ referrer: c.path, needle: target, how: 'cited-in-body' })
      }
    }
  }
  return out
}

// ------------------------------------------------------------------ apply

const journalDirOf = (storeDir: string, rootSession: string): string => path.join(storeDir, rootSession, 'removals')

const writeJournal = (dir: string, j: Journal): string => {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${j.journalId}.json`)
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`)
  return file
}

/**
 * Execute a plan. Safety order, pinned by tests: journal (status 'planned') BEFORE the first unlink;
 * unlinks; stub the record through `store.mutate` (never a snapshot put, #59) ONLY for targets whose
 * chapter file is gone; append the dangling report to the missing-access log; rewrite the journal as
 * applied (or partial, naming every problem). Idempotence: a second apply finds the records already
 * tombstoned by the caller's resolve step — resolve refuses tombstones, so there is nothing to redo.
 */
export async function applyRemoval(ports: ApplyPorts, plan: RemovalPlan): Promise<ApplyOutcome> {
  const { store, cwd, rows, now } = ports
  const at = now()
  const journalId = at.replace(/[:.]/g, '-')
  const problems: string[] = []
  const byRoot = new Map<string, RemovalTarget[]>()
  for (const t of plan.targets) {
    const list = byRoot.get(t.rootSession) ?? []
    list.push(t)
    byRoot.set(t.rootSession, list)
  }
  // 1. journal-before-unlink — per affected tree, so restoreRepair-style lookup by (tree, id) works.
  const journals: { dir: string; file: string; j: Journal }[] = []
  try {
    for (const [root, list] of byRoot) {
      const dir = journalDirOf(pathStoreDir(ports), root)
      const j: Journal = {
        journalId, at, cwd, status: 'planned',
        entries: list.map((t) => ({
          sessionId: t.sessionId, number: t.record.number, title: t.record.title,
          startSeq: t.record.startSeq, endSeq: t.record.endSeq, path: t.record.path,
          sha256: t.record.sha256, removedFiles: [],
        })),
      }
      journals.push({ dir, file: writeJournal(dir, j), j })
    }
  } catch (error) {
    return {
      journalId: '', removed: [], stubbed: [],
      problems: [`journal could not be written (${String((error as Error)?.message ?? error)}) — refusing to apply anything`],
      dangling: plan.dangling, bytes: 0,
    }
  }

  // 2. unlinks — chapter files first, then orphan blobs; ENOENT counts as done (the tree may already
  // be half-lost, and a "missing" note in the plan said so).
  const removed: string[] = []
  const goneAbs = new Set<string>()
  // Mirror rels are listed from the CURRENT store state (planStoreToRepo) BEFORE any unlink —
  // one mapping, the sync module's own (#255: publishIntoClone only copies; the removal must
  // unlink the clone paths itself so stageAllAndCommit sees a deletion).
  const cloneRels = new Map<string, string>()
  if (ports.cloneDir !== undefined && ports.projectKey !== undefined) {
    try {
      for (const { abs, rel } of planStoreToRepo(pathStoreDir(ports), ports.projectKey)) cloneRels.set(abs, rel)
    } catch (error) {
      problems.push(`mirror listing failed (${String((error as Error)?.message ?? error)}): clone copies stay this run — the guard still keeps them out of the store`)
    }
  }
  for (const f of [...plan.chapterFiles, ...plan.blobFiles]) {
    try {
      if (fs.existsSync(f.abs)) fs.unlinkSync(f.abs)
      goneAbs.add(f.abs)
      removed.push(f.stored)
    } catch (error) {
      problems.push(`unlink ${f.stored} failed: ${String((error as Error)?.message ?? error)}`)
    }
  }

  // 2b. mirror copies — only for files whose store side is actually gone (a failed store unlink means
  // the chapter is still knowledge on disk; deleting its mirror copy alone would strand the truth).
  if (ports.cloneDir !== undefined && ports.projectKey !== undefined) {
    for (const f of [...plan.chapterFiles, ...plan.blobFiles]) {
      if (!goneAbs.has(f.abs)) continue
      const rel = cloneRels.get(f.abs) ?? cloneRelOf(f.stored, ports.projectKey)
      if (rel === null) {
        problems.push(`no mirror path derivable for ${f.stored} — the pool copy (if any) was NOT unlinked`)
        continue
      }
      const abs = path.join(ports.cloneDir, rel)
      try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs)
        removed.push(`mirror:${rel}`)
      } catch (error) {
        problems.push(`mirror unlink ${rel} failed: ${String((error as Error)?.message ?? error)}`)
      }
    }
  }

  // 3. stub records — ONLY for targets whose chapter file is gone: an active record whose bytes are
  // still on disk and uncited-by-nothing is repair's problem, not removal's. The tombstone flips
  // only when the deletion actually landed.
  const stubbed: string[] = []
  for (const t of plan.targets) {
    if (!goneAbs.has(resolveStoredPath(cwd, t.record.path))) continue
    try {
      await store.mutate(t.sessionId, (st) => ({
        ...st,
        chapters: st.chapters.map((c) => (c.number === t.record.number && isActiveChapter(c)
          ? { ...c, status: 'removed' as const, removedAt: at }
          : c)),
      }))
      stubbed.push(`${t.sessionId}:${t.record.number}`)
      for (const jj of journals) {
        const e = jj.j.entries.find((x) => x.sessionId === t.sessionId && x.number === t.record.number)
        if (e !== undefined) e.removedFiles = [...plan.chapterFiles, ...plan.blobFiles]
          .filter((f) => f.stored === t.record.path || t.record.artifacts.some((a) => sameStoredPath(a.path, f.stored, cwd))
            || (t.record.planDocs ?? []).some((d) => sameStoredPath(d.path, f.stored, cwd))
            || (t.record.plans ?? []).some((p) => sameStoredPath(p.artifactPath, f.stored, cwd)))
          .map((f) => f.stored)
      }
    } catch (error) {
      problems.push(`registry stub for ${t.sessionId}:${t.record.number} failed: ${String((error as Error)?.message ?? error)}`)
    }
  }

  // 4. missing-access log — dangling refs are the operator's referrer-deciding material (#61).
  const logLines = [
    ...plan.dangling.map((d) => `${at} | removed=${d.needle} | referrer=${d.referrer} | how=${d.how}`),
    ...plan.targets.map((t) => `${at} | removed=${t.record.path} | session=${t.sessionId} | span=${t.record.startSeq}-${t.record.endSeq} | stub-holds-watermark`),
  ]
  if (logLines.length > 0) appendMissingAccess(pathStoreDir(ports), logLines, problems)

  // 5. finalize journals.
  for (const jj of journals) {
    jj.j.status = problems.length === 0 ? 'applied' : 'partial'
    jj.j.problems = problems
    for (const e of jj.j.entries) e.appliedAt = at
    try { writeJournal(jj.dir, jj.j) } catch (error) {
      problems.push(`journal ${journalId} could not be updated: ${String((error as Error)?.message ?? error)}`)
    }
  }
  const bytes = plan.chapterFiles.reduce((s, f) => s + f.bytes, 0) + plan.blobFiles.reduce((s, f) => s + f.bytes, 0)
  return { journalId, removed, stubbed, problems, dangling: plan.dangling, bytes }
}

/** The store ROOT (the directory holding session trees): the configured one, else the default name. */
function pathStoreDir(ports: ApplyPorts): string {
  return ports.storeDir ?? path.join(ports.cwd, '.dsh-chapters')
}

// ------------------------------------------------------------------ missing-access log

export const MISSING_ACCESS_FILE = path.join('removals', 'missing-access.log')

export function appendMissingAccess(storeDir: string, lines: readonly string[], problems?: string[]): void {
  const file = path.join(storeDir, MISSING_ACCESS_FILE)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${lines.join('\n')}\n`)
  } catch (error) {
    const msg = `missing-access log append failed: ${String((error as Error)?.message ?? error)}`
    if (problems !== undefined) problems.push(msg)
    // never throw into the operator's turn: the dangling report already printed; the line is gone,
    // the fact is said.
  }
}

export function readMissingAccess(storeDir: string, maxLines: number): { lines: string[]; total: number; withheld: number; file: string } {
  const file = path.join(storeDir, MISSING_ACCESS_FILE)
  let all: string[] = []
  try {
    all = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  } catch { /* no log yet is an EMPTY state, stated — not an error */ }
  const tail = all.slice(Math.max(0, all.length - maxLines))
  return { lines: tail, total: all.length, withheld: Math.max(0, all.length - tail.length), file }
}

// ------------------------------------------------------------------ removed guard

/**
 * The rehydrate guard (#255): every name a `removed` stub owns, in the mirror walk's identity
 * (`<sessionDir>#<file>` for chapters and plan documents; blob basename for content-addressed
 * artifacts). Rehydration that skips these cannot resurrect a decision; the count lands in the
 * sync steps. Keys are session-id-scoped and content-addressed-scoped, so they cannot collide
 * across projects on one machine.
 */
export function removedGuard(rows: Iterable<readonly [string, SessionState]>): RemovedGuard {
  const chapterKeys = new Set<string>()
  const blobKeys = new Set<string>()
  const keyFor = (stored: string): void => {
    const segs = stored.split('/').filter((s) => s !== '')
    const ci = segs.lastIndexOf('chapters')
    if (ci >= 1 && ci < segs.length - 1) chapterKeys.add(`${segs[ci - 1]}#${segs[ci + 1]}`)
    else blobKeys.add(segs[segs.length - 1]!)
  }
  for (const [, state] of rows) {
    for (const c of state.chapters ?? []) {
      if (!isRemovedChapter(c)) continue
      keyFor(c.path)
      for (const d of c.planDocs ?? []) keyFor(d.path)
      for (const a of c.artifacts ?? []) blobKeys.add(a.path.split('/').pop() ?? '')
    }
  }
  return { chapterKeys, blobKeys }
}

/** Deterministic fallback mapping for a stored path when the pre-unlink listing lacks the entry. */
function cloneRelOf(stored: string, projectKey: string): string | null {
  const segs = stored.split('/').filter((s) => s !== '')
  const ci = segs.lastIndexOf('chapters')
  if (ci >= 1 && ci < segs.length - 1) return path.join('chapters', projectKey, segs[ci - 1]!, segs[ci + 1]!)
  const ai = segs.indexOf('artifacts')
  if (ai >= 0 && ai < segs.length - 1) return path.join('artifacts', projectKey, ...segs.slice(ai + 1))
  return null
}

// ------------------------------------------------------------------ restore (re-derivation)

import { saveSession, type SaveSessionConfig } from './save-core.ts'
import { coveringChapter, markSupersededBy } from './repair.ts'
import type { SessionEventLike } from './types.ts'

export interface RestorePorts {
  store: RegistryStore
  cwd: string
  storeDir: string
  /** The payload-bearing durable-log read (#58's contract) — never a metadata-only record list. */
  readLog(sessionId: string): Promise<SessionEventLike[] | null>
  config: SaveSessionConfig
  now: () => string
}

export interface RestoreOutcome {
  journalId: string
  /** `sid:number → ch.N` per entry whose span re-rendered and committed under a NEW number. */
  restored: string[]
  /** Legitimate no-ops, stated: already superseded, still-active, span already covered. */
  skipped: string[]
  /** Failures with names: no journal, no log, rendered nothing, vanished record. */
  problems: string[]
}

/**
 * Reversal is RE-DERIVATION (#255): the journaled span is re-rendered from the session's durable
 * log through the SAME save core every door calls — a repaired chapter is byte-for-byte a normal
 * chapter, and so is a restored one. The number is NEW (a spent number stays spent; identity is
 * `(number, sha256)`); the removed stub flips to `superseded` with `repairs[].class =
 * 'operator-restore'`, which is how an audit tells a restore from a repair. The log is never
 * touched. A span that renders nothing REFUSES (never commit an empty archive); an unreadable log
 * is UNRECOVERABLE and said so. One journal id can span trees: apply wrote one per affected tree,
 * so restore collects entries from every `<tree>/removals/<id>.json`.
 */
export async function restoreRemoval(ports: RestorePorts, journalId: string): Promise<RestoreOutcome> {
  const restored: string[] = []
  const skipped: string[] = []
  const problems: string[] = []
  type Entry = { sessionId: string; e: Journal['entries'][number] }
  const entries: Entry[] = []
  let trees: string[] = []
  try {
    trees = fs.readdirSync(ports.storeDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (error) {
    return { journalId, restored, skipped, problems: [`store root unreadable (${String((error as Error)?.message ?? error)}) — no journal can be read`] }
  }
  let found = 0
  for (const tree of trees) {
    const file = path.join(ports.storeDir, tree, 'removals', `${journalId}.json`)
    if (!fs.existsSync(file)) continue
    found += 1
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Journal
      for (const e of j.entries ?? []) entries.push({ sessionId: e.sessionId, e })
    } catch (error) {
      problems.push(`journal ${journalId} in ${tree} is unreadable (${String((error as Error)?.message ?? error)}) — its entries were NOT restored`)
    }
  }
  if (found === 0) return { journalId, restored, skipped, problems: [`no journal ${journalId} under ${ports.storeDir}/*/removals/ — apply printed the id it wrote; nothing was restored`] }

  for (const { sessionId, e } of entries) {
    const st = await ports.store.get(sessionId)
    const stub = st.chapters.find((c) => c.number === e.number)
    if (stub === undefined) { problems.push(`${sessionId}:${e.number}: the record vanished from the registry — nowhere to attach the re-derivation`); continue }
    if (isActiveChapter(stub)) { skipped.push(`${sessionId}:${e.number}: still ACTIVE knowledge — removal never applied to it; refusing to restore over it`); continue }
    if (!isRemovedChapter(stub)) { skipped.push(`${sessionId}:${e.number}: stub is already ${String(stub.status)} — a repair or an earlier restore spent this number (idempotent)`) ; continue }
    const events = await ports.readLog(sessionId)
    if (events === null || events.length === 0) { problems.push(`${sessionId}:${e.number}: UNRECOVERABLE — the durable log for this session cannot be read, so span ${e.startSeq}-${e.endSeq} cannot be re-derived; the stub stays`); continue }
    try {
      const out = await saveSession({
        events, sessionId, cwd: ports.cwd, store: ports.store, config: ports.config,
        span: { fromSeq: e.startSeq, toSeq: e.endSeq },
        supersede: { over: e.number, reason: 'operator-restore' },
        attemptSalt: `restore:${journalId}:${sessionId}:${e.number}`,
      })
      if (out.records.length === 0) {
        problems.push(`${sessionId}:${e.number}: the re-render produced nothing (${out.skipped ?? 'no records'}) — stub left in place; an empty archive is never committed`)
        continue
      }
      restored.push(`${sessionId}:${e.number} → ch.${out.records.map((r) => r.number).join(', ch.')}`)
    } catch (error) {
      const msg = String((error as Error)?.message ?? error)
      if (!/already archived|already in the archive/i.test(msg)) { problems.push(`${sessionId}:${e.number}: restore failed: ${msg.slice(0, 160)}`); continue }
      // #60's lesson reborn: an earlier pass archived this span. Point the stub at what covers it
      // rather than stranding it — nothing is rewritten, the covered fact is recorded.
      const fresh = await ports.store.get(sessionId)
      const cover = coveringChapter(fresh, e.startSeq, e.endSeq, e.number)
      if (cover.length === 0) { problems.push(`${sessionId}:${e.number}: the re-read said "already archived" but no active chapter covers ${e.startSeq}-${e.endSeq} — stub left in place`); continue }
      let markProblem: string | undefined
      await ports.store.mutate(sessionId, (s) => {
        const m = markSupersededBy(s, e.number, cover[0]!.number, 'operator-restore')
        markProblem = m.problem
        return m.state
      })
      if (markProblem !== undefined) { problems.push(`${sessionId}:${e.number}: ${markProblem}`); continue }
      skipped.push(`${sessionId}:${e.number}: span already covered by ch.${cover[0]!.number}; stub marked superseded, nothing was rewritten`)
    }
  }

  if (restored.length > 0) {
    appendMissingAccess(ports.storeDir, restored.map((r) => `${ports.now()} | restored | ${r} | journal=${journalId}`))
  }
  return { journalId, restored, skipped, problems }
}
