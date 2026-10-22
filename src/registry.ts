/**
 * Registry — pure ancestry/numbering state. No cordis, no zod, no I/O: this is
 * the L0 layer (docs/development.md § Test Layers); `src/store.ts` is the thin
 * storage-domain adapter over it, deliberately untested because it is glue.
 *
 * The registry is the SOLE authority on ancestry (contract.md § Lineage: the
 * kernel header carries `parentSession` for seed lineage we deliberately do not
 * use; the UI graph will show our children as unrelated roots). Corruptions it
 * must survive: cycles (walk guard throws, never hangs), duplicate chapter ids
 * (append is idempotent), retry-after-crash (reserve is attempt-keyed, so the
 * same `sourceSession@ceiling` reuses its numbers — archive.ts depends on it).
 *
 * Numbering is per-author-session (invariant: chapters keyed by creating
 * session, so siblings cannot collide), and the flat index is built by the
 * PLUGIN walking the ancestor path — the model never traverses a graph.
 */
import type { ChapterRecord } from './archive.ts'

import type { CollectionSignature } from './signature.ts'

export interface SessionState {
  /** Registry-level parent, set at continuation commit. null until linked. */
  parentSession: string | null
  /** Root of the ancestry tree; the store directory key. Self for a root session. */
  rootSession: string
  /** Next unallocated chapter number for THIS author session. */
  nextChapterNumber: number
  /**
   * Next unallocated PLAN-DOCUMENT number for this author session. Its own counter so
   * plan documents never consume a chapter number or reorder the chapter list, while
   * still being allocated through the registry (never by scanning a directory — a
   * concurrent sibling must not be able to pick the same name).
   */
  nextPlanNumber: number
  chapters: ChapterRecord[]
  /**
   * Write counter, bumped by the store on every accepted put (#59). It exists so a read-modify-write
   * can DETECT that the row moved underneath it — the row is one whole value and five doors plus the
   * turn/end listener write it, so "last writer wins" is not a theoretical concern: in the field a
   * stale enrichment put erased a compaction's committed manifest, reservation, `finalized` entry and
   * chapter record while leaving its file on disk. Optional-with-default so a stored row from before
   * the field parses unchanged.
   */
  rev?: number | undefined
  /** attemptKey -> numbers, so an idempotent retry reuses rather than duplicates. */
  reservations: Record<string, number[]>
  /**
   * compactionId -> the plan summarize() committed to: the TOC text already
   * cited `path`, so finalize (possibly after a crash and process restart)
   * must reproduce it exactly. Rebuilding the title from messages is not
   * available post-commit — this manifest is the durable bridge.
   */
  plans: Record<string, { number: number; path: string; title: string; summary: string; chapters?: PlanChapter[] | undefined }>
  /**
   * compactionId -> chapter numbers, written when a compaction's chapter bodies
   * are durably finalized post-commit. Idempotence key for the finalizer and
   * the reconciliation scan (FINDINGS § correlation seam).
   */
    finalized: Record<string, number[]>
  /**
   * Per-turn deterministic signatures, appended at turn/end (knowledge-repo
   * §4.1). The composer (§4.2) reads these at archive time; P2 enrichment may
   * relabel later but never rewrites them. Append-only like chapters.
   */
  collections: CollectionSignature[]
}

export const freshSession = (sessionId: string): SessionState => ({
  rev: 0,
  parentSession: null,
  rootSession: sessionId,
  nextChapterNumber: 1,
  nextPlanNumber: 1,
  collections: [],
  chapters: [],
  reservations: {},
  plans: {},
  finalized: {},
})

/**
 * One composed chapter of a compaction plan (r29): the composer's range,
 * its reserved number and cited path, durable BEFORE the summary text cites
 * them. Legacy single-chapter plans keep the four flat fields and omit this.
 */
export interface PlanChapter {
  number: number
  path: string
  title: string
  summary: string
  startSeq: number
  endSeq: number
}

/** Persist a summarize-time plan so finalization survives a restart. */
export function rememberPlan(
  state: SessionState,
  compactionId: string,
  plan: { number: number; path: string; title: string; summary: string; chapters?: PlanChapter[] },
): SessionState {
  return { ...state, plans: { ...state.plans, [compactionId]: plan } }
}

/** Record a post-commit finalization for one compaction. Same write twice is a no-op. */
export function markFinalized(state: SessionState, compactionId: string, numbers: readonly number[]): SessionState {
  if (state.finalized[compactionId] !== undefined) return state
  return { ...state, finalized: { ...state.finalized, [compactionId]: [...numbers] } }
}

/** True when a compaction's chapters are already committed (finalizer + scan use this). */
export const isFinalized = (state: SessionState, compactionId: string): boolean =>
  state.finalized[compactionId] !== undefined

/** Immutably updated copy with `n` numbers reserved for `attemptId`. */
export function reserve(state: SessionState, attemptId: string, count: number): { state: SessionState; numbers: number[] } {
  if (count <= 0 || !Number.isInteger(count)) {
    throw new Error(`reserve: count must be a positive integer, got ${count}`)
  }
  const existing = state.reservations[attemptId]
  if (existing !== undefined) {
    if (existing.length !== count) {
      // Same attempt, different size: the caller's chapter set changed under a
      // half-finished attempt. Reusing a shorter list would silently drop
      // chapters; growing would collide. Refuse — never guess.
      throw new Error(`reserve: attempt "${attemptId}" already holds ${existing.length} numbers, requested ${count}`)
    }
    return { state, numbers: [...existing] }
  }
  // Never hand out a number the row already carries. A committed number with no matching
  // reservation is a real state, not a bug: an orphan row written before this field existed, or a
  // chapter whose record a lost update erased while its file survived (#59). Allocating into it would
  // put two `0NN-*.md` in one tree, so allocation SKIPS it and spends the next free number instead.
  const taken = new Set(state.chapters.map((c) => c.number))
  const numbers: number[] = []
  let cursor = state.nextChapterNumber
  while (numbers.length < count) {
    if (!taken.has(cursor)) numbers.push(cursor)
    cursor += 1
  }
  return {
    state: {
      ...state,
      nextChapterNumber: cursor,
      reservations: { ...state.reservations, [attemptId]: numbers },
    },
    numbers,
  }
}
/** The same allocation rule for plan documents, on its own counter. */
export function reservePlan(
  state: SessionState,
  attemptId: string,
  count: number,
): { state: SessionState; numbers: number[] } {
  if (count <= 0 || !Number.isInteger(count)) {
    throw new Error(`reservePlan: count must be a positive integer, got ${count}`)
  }
  const key = `plan:${attemptId}`
  const existing = state.reservations[key]
  if (existing !== undefined) {
    if (existing.length !== count) {
      throw new Error(`reservePlan: attempt "${key}" already holds ${existing.length} numbers, requested ${count}`)
    }
    return { state, numbers: [...existing] }
  }
  // Same skip rule as reserve(): plan documents are numbered independently but the collision
  // hazard is identical (a lost update rewinding nextPlanNumber re-issues `plan-003` over a twin).
  const taken = new Set(
    state.chapters.flatMap((c) => (c as unknown as { planDocs?: Array<{ path: string }> }).planDocs ?? [])
      .map((d) => /plan-(\d+)-/.exec(d.path)?.[1]).filter((n): n is string => n !== undefined).map(Number),
  )
  const numbers: number[] = []
  let cursor = state.nextPlanNumber
  while (numbers.length < count) {
    if (!taken.has(cursor)) numbers.push(cursor)
    cursor += 1
  }
  return {
    state: {
      ...state,
      nextPlanNumber: cursor,
      reservations: { ...state.reservations, [key]: numbers },
    },
    numbers,
  }
}

/**
 * Append verified chapter records.
 *
 * Identity is `(number, sha256)`, never `number` alone (#59). An identical record is a no-op — that is
 * what makes a retry after a crash safe. A record reusing a number for DIFFERENT bytes is not a retry,
 * it is a collision: one door's reservation was rewound by a lost update and another door has now been
 * handed a number whose file already exists. Measured in the field: chapter 15 was spent twice in
 * `session-aac0254e`, and number-only dedupe silently DROPPED the second record while its 960 KB file
 * stayed on disk — a chapter no TOC cites and no tool can find. Refusing is the only honest option.
 */
export function appendChapters(state: SessionState, records: readonly ChapterRecord[]): SessionState {
  const byNumber = new Map(state.chapters.map((c) => [c.number, c]))
  const fresh: ChapterRecord[] = []
  for (const r of records) {
    const prior = byNumber.get(r.number)
    if (prior !== undefined) {
      if (prior.sha256 !== r.sha256 || prior.path !== r.path) {
        throw new Error(
          `appendChapters: chapter number ${r.number} is already committed with different content `
          + `(${prior.path} sha ${prior.sha256.slice(0, 12)}…) — refusing to overwrite or silently drop `
          + `${r.path} (sha ${r.sha256.slice(0, 12)}…). A reused number means a lost registry update (#59).`,
        )
      }
      continue // identical retry
    }
    fresh.push(r)
    byNumber.set(r.number, r)
  }
  return fresh.length === 0 ? state : { ...state, chapters: [...state.chapters, ...fresh] }
}

/**
 * Free an attempt's retry key WITHOUT un-spacing its numbers (#59). Reserve-before-write exists so a
 * crash cannot re-issue a number whose file may already be on disk; that guarantee must not be undone
 * here. What this does is stop a burned key from living forever: a door that reserved and then failed
 * (a read-back that did not verify, a refusal after writing) currently leaves `reservations[k]` behind
 * with no file and no record, which is the state the field showed at numbers 20 and 37.
 *
 * `numbersSpent` stays monotonic — only the attempt key goes.
 */
export function releaseReservation(state: SessionState, attemptId: string): SessionState {
  if (state.reservations[attemptId] === undefined) return state
  const { [attemptId]: _gone, ...rest } = state.reservations
  return { ...state, reservations: rest }
}

/**
 * Commit point for a continuation: the child inherits the PARENT's root and
 * gets its direct parent recorded. Set once, never rewritten — re-pointing a
 * linked session would silently re-home every chapter below it. Same link
 * twice is a no-op (retry safety); a DIFFERENT link is corruption or a bug,
 * and it throws.
 */
export function linkChild(state: SessionState, parentSessionId: string, parentRootSession: string): SessionState {
  if (state.parentSession !== null) {
    if (state.parentSession === parentSessionId && state.rootSession === parentRootSession) return state
    throw new Error(
      `linkChild: session already linked to parent ${state.parentSession} (root ${state.rootSession});`
      + ` refusing rewrite to parent ${parentSessionId} (root ${parentRootSession})`,
    )
  }
  return { ...state, parentSession: parentSessionId, rootSession: parentRootSession }
}

/**
 * Walk parent links root-first. Throws on a cycle or a missing parent — both
 * are registry corruption, and an infinite walk is how a small bad write
 * becomes a hung plugin at the worst moment.
 */
export function ancestorPath(get: (id: string) => SessionState | undefined, sessionId: string, maxDepth = 1000): string[] {
  const path: string[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = sessionId
  while (cursor !== undefined) {
    if (seen.has(cursor)) throw new Error(`ancestorPath: cycle through ${cursor}`)
    if (seen.size >= maxDepth) throw new Error(`ancestorPath: exceeded depth ${maxDepth}`)
    seen.add(cursor)
    const state = get(cursor)
    if (state === undefined) {
      if (cursor === sessionId) return [cursor] // unregistered root: itself is the path
      throw new Error(`ancestorPath: missing state for parent ${cursor} (registry corruption)`)
    }
    path.unshift(cursor)
    cursor = state.parentSession ?? undefined
  }
  return path
}

export interface IndexEntry {
  /** Session that authored the chapter, for back-links. */
  authorSession: string
  number: number
  path: string
  title: string
  summary: string
  /** Integrity verdict supplied by the caller (verifyChapter via its fs port). */
  status: 'ok' | 'modified' | 'missing'
}

/**
 * The flat, chronological, numbered index the TOC renders — reading order IS
 * causal order (docs/architecture.md § Ancestry). Ancestor sessions first;
 * within a session, by reserved number. Siblings are excluded by construction:
 * the walk never enters them.
 */
export function buildIndex(
  path: readonly string[],
  get: (id: string) => SessionState | undefined,
  status: (record: ChapterRecord) => IndexEntry['status'],
): IndexEntry[] {
  const entries: IndexEntry[] = []
  for (const sessionId of path) {
    const state = get(sessionId)
    if (state === undefined) continue
    for (const chapter of [...state.chapters].sort((a, b) => a.number - b.number)) {
      entries.push({
        authorSession: sessionId,
        number: chapter.number,
        path: chapter.path,
        title: chapter.title,
        summary: chapter.summary,
        status: status(chapter),
      })
    }
  }
  return entries
}

/** Append one turn's signature. Idempotent per turn (same seqs → no-op), like appendChapters. */
export function appendCollection(state: SessionState, sig: CollectionSignature): SessionState {
  const last = state.collections[state.collections.length - 1]
  if (last !== undefined && last.seqs.length === sig.seqs.length && last.seqs.every((q, i) => q === sig.seqs[i])) return state
  return { ...state, collections: [...state.collections, sig] }
}
