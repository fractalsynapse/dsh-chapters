/**
 * The repair engine (#60) — re-derive the archive from the durable log, never edit it.
 *
 * WHY THIS EXISTS (docs/architecture.md § Repair). The durable session log is append-only and complete
 * (invariant 1), which is the only reason the defects measured in the first `chapters`-preset project
 * (`/home/adrian/Projects/saip`, see var/saip-audit/SAIP-CHAPTERS-AUDIT-2026-10-22.md) are recoverable
 * at all: 12 hollow chapters a payload-less read produced, a 203-event completed turn no chapter covers,
 * a 960 KB chapter file its own tree does not cite, two different `015-*.md` from one rewound counter,
 * and two checkpoints citing files that were never written. Nothing in the plugin could see or say any
 * of it. This module is the seeing; `/chapters-repair` is the saying; the fixes run through the SAME
 * save core every other door uses, so a repaired chapter is byte-identical to a normal one.
 *
 * THE CONTRACT, in one line each:
 *  1. **Supersede, never rewrite.** A damaged chapter gets a NEW number carrying `repairs:`, the old
 *     record is marked `status: 'superseded'`, and the bad file is COPIED into `.repair-quarantine/`.
 *     Nothing is deleted; nothing is edited in place (the body-hash guard is the only sanctioned
 *     chapter-file mutation, and repair is not an exception to it).
 *  2. **A dead citation is satisfied, not edited.** A compaction manifest already handed the host its
 *     TOC text naming `…/020-<title>.md`. Repair renders that span and writes it AT the cited path with
 *     the reserved number, so the committed text becomes true and no log byte moves.
 *  3. **Numbers stay spent.** Releasing a reservation frees its retry key, never its numbers; a counter
 *     is raised to `max(spent)+1` and never lowered.
 *  4. **Journalled, therefore reversible.** An applied run writes `<tree>/repairs/<stamp>.json` FIRST —
 *     one entry per move with before/after hashes — and `restore <journal-id>` walks it backwards.
 *  5. **One serialized section per row.** Every registry mutation goes through `store.mutate` (#59): a
 *     repair that clobbered a live door's commit would be #59 with better intentions.
 */
import { appendChapters, isActiveChapter, releaseReservation, type SessionState } from './registry.ts'
import type { ChapterRecord } from './archive.ts'
import type { RenderConfig } from './types.ts'

// ─────────────────────────────────────────────────── findings (pure)

/** What can be wrong. Each class maps to exactly one remedy; see `REMEDY`. */
export type FindingClass =
  | 'hollow-payload'          // messages === 0 with events > 0 — a payload-less read (#58)
  | 'empty-artifact'          // a 0-byte blob cited as knowledge (#59)
  | 'never-archived-span'     // a completed turn inside no chapter (#59)
  | 'orphan-file'             // a RECORD whose chapter file is gone (re-render it from the log)
  | 'unregistered-file'       // a FILE on disk that no record cites (re-register it; its bytes ARE the archive)
  | 'duplicate-number'        // two records spent on one number (#59)
  | 'countervalue-drift'      // a counter at or below the numbers already spent
  | 'ghost-plan-manifest'     // a finalize manifest whose chapter never landed
  | 'unreleased-reservation'  // a retry key whose files never landed
  | 'dead-citation'           // committed TOC text citing a missing file
  | 'tampered-file'           // record hash ≠ file hash
  | 'test-litter'             // data another rig wrote into this store
  | 'unrecoverable'           // record and file both gone; the log is gone too

export type Remedy =
  | 'reread-span' | 'materialize-chapter' | 're-register-file' | 'quarantine-file' | 'release-reservation'
  | 'expire-manifest' | 'raise-counter' | 'report-only'

export interface RepairFinding {
  class: FindingClass
  session: string
  detail: string
  remedy: Remedy
  /** The chapter number, seq span or path the remedy acts on — the operator reads this, not prose. */
  target: { number?: number; path?: string; fromSeq?: number; toSeq?: number }
}

/** What the auditor may ask about the store. The caller owns the filesystem; this stays pure. */
export interface RepairFileSet {
  exists(path: string): boolean
  bytes(path: string): number
  shaMatches(path: string, sha: string): boolean
  /** Every chapter `.md` present under this session's tree, however it got there. */
  chapterPaths: string[]
  artifactPaths: string[]
  emptyArtifactPaths: string[]
  /** Other session roots sitting in the same store (rig litter shows up here). */
  roots?: string[]
  /**
   * Does this chapter file carry the #58 SHELL signature — `tool: unknown`, `arguments: {}`, a
   * `0 B` result? That signature, not a zero message count, is what a payload-less read leaves behind:
   * a repair split can legitimately produce a part with no prose (turn/step events only), and calling
   * that a husk would report damage that is not damage. `false` when the caller cannot read files.
   */
  looksLikeShell?(path: string): boolean
  /**
   * FALSE when the caller cannot list a directory — which is the HOST's case: `ArchiveFs` is
   * write/read/exists only (src/archive.ts), so an in-host repair can never discover a file the registry
   * does not cite. Reporting "no orphan files" from a port that cannot see them would be a lie of
   * omission, exactly the class of defect this issue is about; so the audit returns BLIND SPOTS and the
   * command says them out loud. The offline script (`scripts/chapters-repair.mjs`) has `readdir` and
   * leaves this true.
   */
  canScan?: boolean
}

export interface RepairLogFacts {
  /** Every `turn/end` seq in the session — the ONLY authority on completeness (§4.3). */
  turnEndSeqs: number[]
  /** Signed collection spans, for reporting why a span went unsigned. */
  collections: Array<{ from: number; to: number }>
}

export interface AuditInput {
  sessionId: string
  state: SessionState
  files: RepairFileSet
  log: RepairLogFacts
}

const REMEDY: Record<FindingClass, Remedy> = {
  'hollow-payload': 'reread-span',
  'empty-artifact': 'quarantine-file',
  'never-archived-span': 'reread-span',
  'orphan-file': 'materialize-chapter',
  'unregistered-file': 're-register-file',
  'duplicate-number': 'reread-span',
  'countervalue-drift': 'raise-counter',
  'ghost-plan-manifest': 'expire-manifest',
  'unreleased-reservation': 'release-reservation',
  'dead-citation': 'materialize-chapter',
  'tampered-file': 'report-only',
  'test-litter': 'report-only',
  unrecoverable: 'report-only',
}

/**
 * Compare the three things that can disagree: the log, the files, the records.
 *
 * Deliberately READ-ONLY and pure — the same function serves `audit`, `dry-run` and `apply`, so what an
 * operator sees is exactly what will be done, and a report can never be more optimistic than the run.
 * A clean store must return an EMPTY list: a repair that prints friendly noise is a repair whose output
 * nobody reads.
 */
export function audit(input: AuditInput): { findings: RepairFinding[]; blindSpots: FindingClass[] } {
  const { sessionId, state, files, log } = input
  const findings: RepairFinding[] = []
  const add = (f: Omit<RepairFinding, 'session' | 'remedy'> & { class: FindingClass }): void => {
    findings.push({ ...f, session: sessionId, remedy: REMEDY[f.class] })
  }
  const active = state.chapters.filter(isActiveChapter)

  // 1. Hollow chapters: the pair that turned 12 recoverable archives into permanent ones (#58).
  for (const c of active) {
    // STRICT equality: `messages` is ABSENT on records written before counts existed, and on every row
    // a repair re-registered from a file whose frontmatter has no such field (render.ts: "absent … never
    // a lying zero"). Coercing undefined to 0 turned 162 legitimate re-registrations into false
    // "hollow-payload" findings on the first real run — an auditor that invents damage is worse than one
    // that misses it, because the operator learns to distrust the report.
    // A record with `messages === 0` is suspect, but not always a wound: a repair that split one enormous
    // turn into event-bounded parts knowingly produced parts holding tool calls and no prose (save-core
    // names each in its warnings). The discriminator is CONTENT, not provenance — my first guess was a
    // `repairs` stamp, and it missed, because parts made by the never-archived-span branch carry no
    // stamp at all, so a healthy repaired tree reported 14 fresh "husks". A #58 shell deferred
    // ZERO-BYTE blobs (its read had no payloads to defer); a real tool-only part has bytes. An empty

    // Evidence, not arithmetic: a payload-less read left EITHER zero-byte deferred blobs (it "archived"
    // 335 empty results) OR the shell signature in the bytes (`tool: unknown`, `arguments: {}`). A bare
    // empty artifact list is NOT evidence — a repair split legitimately produces an empty part (turn and
    // step events only), and three of those were reported as husks until this rule named its evidence.
    const shellSignature = files.looksLikeShell?.(c.path) ?? false
    const zeroByteBlobs = c.artifacts.length > 0 && c.artifacts.every((a) => a.bytes === 0)
    if (c.messages === 0 && c.endSeq >= c.startSeq && (zeroByteBlobs || shellSignature)) {
      add({ class: 'hollow-payload', detail: `chapter ${c.number} ("${c.title}") has messages 0 over seqs ${c.startSeq}-${c.endSeq} — a payload read that went wrong, not a short conversation`, target: { number: c.number, path: c.path, fromSeq: c.startSeq, toSeq: c.endSeq } })
    } else if (!files.exists(c.path)) {
      // 2. A record whose file is gone: knowledge for the reader, a ghost for every tool.
      add({ class: 'orphan-file', detail: `chapter ${c.number} is recorded at ${c.path} but no such file exists — the record is a ghost: re-render it from the log`, target: { number: c.number, path: c.path, fromSeq: c.startSeq, toSeq: c.endSeq } })
    } else if (!files.shaMatches(c.path, c.sha256)) {
      add({ class: 'tampered-file', detail: `chapter ${c.number}'s body hash no longer matches ${c.path}`, target: { number: c.number, path: c.path } })
    }
    for (const a of c.artifacts) {
      if (a.bytes === 0 || files.emptyArtifactPaths.includes(a.path)) {
        add({ class: 'empty-artifact', detail: `chapter ${c.number} cites the 0-byte blob ${a.path} (sha ${a.sha256.slice(0, 12)}…) as an artifact`, target: { path: a.path, number: c.number } })
      }
    }
  }

  // 3. Files the registry does not cite — the shape a lost update leaves behind (#59: the 960 KB case).
  const cited = new Set(state.chapters.map((c) => c.path))
  for (const p of files.chapterPaths) {
    if (!cited.has(p) && !p.includes('.repair-quarantine')) {
      const m = /\/(\d{3})-/.exec(p)
      const num = m ? Number(m[1]) : undefined
      add({ class: 'unregistered-file', detail: `${p} exists on disk and no chapter record cites it — the registry lost its commit${num !== undefined ? ` (number ${num})` : ''}`, ...(num !== undefined ? { target: { path: p, number: num } } : { target: { path: p } }) })
    }
  }

  // 4. Two records on one number (identity is (number, sha256), never number alone).
  const byNumber = new Map<number, ChapterRecord[]>()
  for (const c of state.chapters) byNumber.set(c.number, [...(byNumber.get(c.number) ?? []), c])
  for (const [n, list] of byNumber) {
    if (list.length > 1) {
      add({ class: 'duplicate-number', detail: `chapter number ${n} is carried by ${list.length} different records (${list.map((c) => c.path.split('/').pop()).join(', ')}) — a lost update re-spent it`, target: { number: n } })
    }
  }

  // 5. A counter at or below what is already spent: the next door would collide (#59).
  const maxSpent = state.chapters.reduce((m, c) => Math.max(m, c.number), 0)
  if (state.nextChapterNumber <= maxSpent) {
    add({ class: 'countervalue-drift', detail: `nextChapterNumber ${state.nextChapterNumber} is not above the highest spent number ${maxSpent}`, target: { number: maxSpent + 1 } })
  }

  // 6. Coverage: a completed turn inside no chapter. turn/end is the ONLY authority on completeness —
  //    the old note inferred "unfinished" from a missing signature and was wrong (#59).
  const covered = new Set<number>()
  for (const c of active) for (let s = c.startSeq; s <= c.endSeq; s++) covered.add(s)
  const lastEnd = log.turnEndSeqs.length > 0 ? Math.max(...log.turnEndSeqs) : -1
  let holeStart = -1
  const flushHole = (to: number): void => {
    if (holeStart >= 0) {
      add({ class: 'never-archived-span', detail: `seqs ${holeStart}-${to} belong to COMPLETED turns and are inside no chapter — signed collections do not cover them`, target: { fromSeq: holeStart, toSeq: to } })
      holeStart = -1
    }
  }
  for (let s = 0; s <= lastEnd; s++) {
    if (!covered.has(s)) holeStart = holeStart < 0 ? s : holeStart
    else flushHole(s - 1)
  }
  flushHole(lastEnd)

  // 7. Bookkeeping: manifests the row still carries for work that never landed. The manifest IS the
  //    plan the post-commit finalizer was going to execute — `path` is the chapter it promised to
  //    commit, `number` its reserved chapter number, `chapters` the bullets it already handed the host
  //    as TOC text (src/registry.ts PlanManifest). Read the real shape, not an imagined one.
  for (const [key, plan] of Object.entries(state.plans ?? {})) {
    if (!state.chapters.some((c) => c.path === plan.path) && !files.exists(plan.path)) {
      add({ class: 'ghost-plan-manifest', detail: `finalize manifest ${key} promises chapter ${plan.number} at ${plan.path}, which never landed`, target: { path: plan.path, number: plan.number } })
    }
    // 8. Dead citations: the manifest's OWN committed TOC bullets naming files that do not exist.
    //    The host already holds that text — satisfaction, never editing, is the honest repair (#60).
    for (const ch of plan.chapters ?? []) {
      if (!files.exists(ch.path)) {
        const num = /\/(\d{3})-/.exec(ch.path)?.[1]
        add({
          class: 'dead-citation',
          detail: `a committed checkpoint cites ${ch.path} (number ${num ?? '?'}) and that file was never written — render the span and write it AT that path; do not touch the text`,
          ...(num !== undefined ? { target: { path: ch.path, number: Number(num) } } : { target: { path: ch.path } }),
        })
      }
    }
  }
  for (const [key, numbers] of Object.entries(state.reservations ?? {})) {
    const landed = numbers.every((n) => state.chapters.some((c) => c.number === n))
    if (!landed) {
      add({ class: 'unreleased-reservation', detail: `reservation ${key} holds [${numbers.join(', ')}] and not every number produced a record — its key can never land`, ...(numbers[0] !== undefined ? { target: { number: numbers[0] } } : { target: {} }) })
    }
  }

  // 9. Someone else's data in this store: reported, never decided here.
  for (const root of files.roots ?? []) {
    add({ class: 'test-litter', detail: `the store holds a second root ${root} (not this session's tree); it is not touched automatically — inspect it before removing anything`, target: { path: root } })
  }

  // What we could NOT look at, stated rather than implied. The host port has no directory listing, so
  // unlisted files and stray roots are invisible there; the offline script sees them.
  const blindSpots: FindingClass[] = files.canScan === false ? ['orphan-file', 'test-litter'] : []
  return { findings, blindSpots }
}

// ─────────────────────────────────────────────────── operator vocabulary (pure, ONE list)

/**
 * The class names an operator may type, and what each expands to (#60). BOTH `/chapters-repair` and
 * `scripts/chapters-repair.mjs` read this table — two lists is how the command quietly accepted
 * `--apply bogus` and reported "0 moves" as success while the script refused it. Unknown names must
 * fail loudly: a repair that does nothing and says nothing is the defect this whole issue is named for.
 */
export const REPAIR_CLASS_ALIASES: Record<string, string | string[]> = {
  hollow: 'hollow-payload',
  gaps: 'never-archived-span',
  citations: 'dead-citation',
  bookkeeping: ['ghost-plan-manifest', 'unreleased-reservation', 'countervalue-drift'],
  files: 'unregistered-file',
  orphans: 'unregistered-file',
  all: 'all',
}

/** Resolve operator words into finding classes, or return the unknown names it must refuse. */
export function resolveRepairClasses(input: readonly string[]): { classes: FindingClass[]; unknown: string[] } {
  if (input.length === 0 || input.includes('all')) return { classes: 'all' as never, unknown: [] }
  const expanded = input.flatMap((c) => REPAIR_CLASS_ALIASES[c] ?? c)
  if (expanded.includes('all')) return { classes: 'all' as never, unknown: [] }
  const unknown = expanded.filter((c) => !(FINDING_CLASSES as readonly string[]).includes(c))
  return { classes: expanded as FindingClass[], unknown }
}

/** Every class the auditor can produce — the accept-list for operator words. */
export const FINDING_CLASSES: readonly FindingClass[] = [
  'hollow-payload', 'empty-artifact', 'never-archived-span', 'orphan-file', 'unregistered-file',
  'duplicate-number', 'countervalue-drift', 'ghost-plan-manifest', 'unreleased-reservation',
  'dead-citation', 'tampered-file', 'test-litter', 'unrecoverable',
]

// ─────────────────────────────────────────────────── supersede (pure)

/**
 * Mark the damaged record superseded and commit its replacement, in ONE pure state transition.
 *
 * The old record KEEPS its number, its seqs and its hash: the watermark is `max(endSeq)+1` and a spent
 * number must never be re-spendable (#59). What changes is that it stops being knowledge — every derived
 * layer reads it through `isActiveChapter`, so it leaves the TOC, the index and the enrichment queue.
 */
export function supersedeChapter(
  state: SessionState,
  overNumber: number,
  replacements: readonly ChapterRecord[],
  reason: FindingClass,
  at: number = Date.now(),
): SessionState {
  const stamped = replacements.map((r) => ({ ...r, repairs: [...(r.repairs ?? []), { class: reason, over: overNumber, at }] }))
  const withMarks: SessionState = {
    ...state,
    chapters: state.chapters.map((c) => (c.number === overNumber && replacements.length > 0
      ? { ...c, status: 'superseded' as const, supersededBy: replacements[0]!.number }
      : c)),
  }
  return appendChapters(withMarks, stamped)
}

/**
 * Mark a record superseded by a chapter that ALREADY EXISTS — no new bytes (#60).
 *
 * The residue after a project-wide repair: a husk whose span was re-archived correctly by an earlier
 * run, so re-rendering it now is a no-op and `supersedeChapter` (which commits replacements) can never
 * run. The knowledge is safe; only the false record is still circulating. This closes that last step:
 * point the husk at whatever active chapter covers its seqs, and let the derived layers drop it.
 * Refuses (returns the state unchanged with a reason) when nothing covers the span — because silently
 * superseding an uncovered span would delete the only claim that content exists.
 */
export function markSupersededBy(
  state: SessionState,
  overNumber: number,
  byNumber: number,
  reason: FindingClass,
  at: number = Date.now(),
): { state: SessionState; problem?: string } {
  const over = state.chapters.find((c) => c.number === overNumber)
  const by = state.chapters.find((c) => c.number === byNumber)
  if (over === undefined) return { state, problem: `no record for chapter ${overNumber}` }
  if (by === undefined) return { state, problem: `no covering chapter ${byNumber} to supersede ${overNumber} with` }
  if (byNumber === overNumber) return { state, problem: `chapter ${overNumber} cannot supersede itself` }
  // Full coverage is the caller's job (`coveringChapter` returns a SET); this guard only insists the
  // named successor starts no later than the husk, so the citation never claims a partial span.
  if (by.startSeq > over.startSeq) {
    return { state, problem: `chapter ${byNumber} starts at ${by.startSeq}, above ${overNumber}'s span start ${over.startSeq}` }
  }
  return {
    state: {
      ...state,
      chapters: state.chapters.map((c) => (c.number === overNumber
        ? { ...c, status: 'superseded' as const, supersededBy: byNumber, repairs: [...(c.repairs ?? []), { class: reason, over: overNumber, at }] }
        : c)),
    },
  }
}

/**
 * The active chapter whose span fully covers `[from..to]`, if any — the candidate a husk defers to.
 * `exceptNumber` is not cosmetic: the husk covers its OWN span, so without excluding it the search
 * returns the record about to be superseded and `markSupersededBy` would point a chapter at itself
 * (caught by `tests/unit/repair.test.ts`).
 */
export function coveringChapter(state: SessionState, from: number, to: number, exceptNumber?: number): ChapterRecord[] {
  // A REPAIR may have split the span across several chapters, so coverage is a UNION, not one record:
  // insisting on a single coverer left 14 husks unsuperseded in the first full project run, each
  // "not covered" when in fact three chapters carried it between them.
  const pool = state.chapters.filter((c) => isActiveChapter(c) && c.number !== exceptNumber && c.startSeq <= to && c.endSeq >= from)
  const sorted = [...pool].sort((a, b) => a.startSeq - b.startSeq)
  let cursor = from
  const chosen: ChapterRecord[] = []
  for (const c of sorted) {
    if (c.startSeq > cursor) break // a real hole: nothing reaches `cursor`
    chosen.push(c)
    cursor = Math.max(cursor, c.endSeq + 1)
    if (cursor > to) return chosen
  }
  return []
}

/** Raise a counter to the first number nothing has spent. Upward ONLY — never a rewind. */
export function raiseCounters(state: SessionState): SessionState {
  const maxChapter = state.chapters.reduce((m, c) => Math.max(m, c.number), 0)
  const maxPlan = state.chapters.flatMap((c) => c.planDocs ?? [])
    .map((d) => /plan-(\d+)-/.exec(d.path)?.[1]).filter((n): n is string => n !== undefined).map(Number)
    .reduce((m, n) => Math.max(m, n), 0)
  return {
    ...state,
    nextChapterNumber: Math.max(state.nextChapterNumber, maxChapter + 1),
    nextPlanNumber: Math.max(state.nextPlanNumber, maxPlan + 1),
  }
}

/** Drop a manifest/reservation whose work never landed, keeping every number spent. */
export function expireBookkeeping(state: SessionState, keys: readonly string[]): SessionState {
  const plans = { ...state.plans }
  const reservations = { ...state.reservations }
  for (const k of keys) { delete plans[k]; delete reservations[k] }
  return { ...state, plans, reservations }
}

export { releaseReservation }

// ─────────────────────────────────────────────────── journal (pure)

export interface JournalEntry {
  kind: 'write' | 'quarantine' | 'registry'
  path: string
  beforeSha: string | null
  afterSha: string | null
  /** Quarantine target, registry rev, or the span re-read — whatever `undo` needs. */
  to?: string
  rev?: number
}

export interface Journal {
  id: string
  sessionId: string
  startedAt: number
  classes: FindingClass[]
  /** Null until the run finishes; an unfinished journal is how `status` knows a run died. */
  completedAt: number | null
  entries: JournalEntry[]
  findingsBefore: number
  findingsAfter: number
}

/** How an entry is undone. The inverse is DERIVED, never hand-written, so a journal cannot lie about itself. */
export function journalEntryInverse(e: JournalEntry): { undo: 'remove' | 'restore-from-quarantine' | 'restore-registry-rev' | 'unchanged' } {
  if (e.kind === 'registry') return { undo: 'restore-registry-rev' }
  if (e.kind === 'quarantine') return { undo: 'restore-from-quarantine' }
  if (e.beforeSha === null) return { undo: 'remove' }
  return { undo: 'restore-from-quarantine' }
}

/** Chapter-file frontmatter keys a repair adds. `renderChapter` owns every other byte. */
export function repairFrontmatter(lines: readonly string[], marks: JournalEntry[]): string[] {
  return [...lines, ...marks.map((m) => `repairs: ${m.path}`)]
}

export type { RenderConfig }
