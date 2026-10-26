/**
 * The storage-domain adapter: zod schemas, the durable spec, and the ports
 * that connect the pure registry (registry.ts) and pure archive writer
 * (archive.ts) to host persistence and the filesystem. This is glue next to
 * `src/index.ts` — thin by policy; every decision lives in the pure layer.
 *
 * Keying: one record per SESSION id (`sessions` table), because chapters are
 * keyed by creating session, not a linear chain id — siblings branching from
 * one ancestor cannot collide, and the flat TOC is built by walking links
 * (registry.ancestorPath), never by a directory scan.
 *
 * Concurrency, honestly: read-modify-write per key. Same-session archive
 * flows are serialized by their own reserve-before-write ordering, and a
 * session has exactly one write handle (the kernel refuses a second, measured
 * r3). Cross-process same-key writes are last-writer-wins on the JSON
 * backend — acceptable for MVP, worth revisiting before multi-host chains.
 */
import { z } from 'zod'
import { ruleRecordSchema } from './rules.ts'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname , isAbsolute} from 'node:path'
import type { ArchiveFs, ChapterRecord, NumberAllocator } from './archive.ts'
import { appendChapters, freshSession, releaseReservation, reserve, reservePlan as reservePlanNumber, type SessionState } from './registry.ts'

// ---------------------------------------------------------------- schemas + spec

const chapterRecordSchema = z.object({
  number: z.number().int().positive(),
  path: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  startSeq: z.number().int().nonnegative(),
  endSeq: z.number().int().nonnegative(),
  topics: z.array(z.string()).default([]),
  messages: z.number().int().nonnegative().optional(),
  shadowedSeqs: z.array(z.number().int().nonnegative()).optional(),
  sha256: z.string().min(16),
  /** P2 §2.4 provenance chains, newest-first per field (absent = everything
   * still deterministic; enrichment only ever grows these). */
  generated: z.record(z.string(), z.array(z.object({
    by: z.string(), model: z.string().optional(), at: z.string().optional(),
  }))).optional(),
  estimatedTokens: z.number().int().nonnegative(),
  artifacts: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().min(16),
    bytes: z.number().int().nonnegative(),
  })),
  // Plans this chapter carries (docs/plans-carriage.md § 2). Optional: a stored row
  // from before the feature simply has no field, which reads as "no plans here".
  plans: z.array(z.object({
    seq: z.number().int().nonnegative(),
    status: z.enum(['approved', 'rejected', 'dismissed', 'pending', 'superseded', 'failed']),
    title: z.string(),
    sha256: z.string().min(16),
    artifactPath: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    estTokens: z.number().int().nonnegative(),
    resultSeq: z.number().int().nonnegative().nullable(),
  })).optional(),
  planMode: z.enum(['active', 'inactive', 'unknown']).optional(),
  // Where each plan's own `kind: plan` document landed.
  planDocs: z.array(z.object({
    seq: z.number().int().nonnegative(),
    path: z.string().min(1),
    sha256: z.string().min(16),
  })).optional(),
})

const collectionSchema = z.object({
  seqs: z.array(z.number().int().nonnegative()).min(1),
  paths: z.array(z.string()),
  commands: z.array(z.string()),
  terms: z.array(z.string()),
  size: z.number().int().nonnegative(),
  by: z.literal('deterministic'),
})

const sessionStateSchema = z.object({
  rev: z.number().int().nonnegative().default(0),
  parentSession: z.string().nullable(),
  rootSession: z.string().min(1),
  nextChapterNumber: z.number().int().positive(),
  // Plan-document numbering (plans-carriage § 11). Optional with a default so a
  // stored row from before the feature parses unchanged.
  nextPlanNumber: z.number().int().positive().default(1),
  chapters: z.array(chapterRecordSchema),
  reservations: z.record(z.string(), z.array(z.number().int().positive())).default({}),
  // #113: the Suggested Next Step bar's durable facts. Optional-with-default (the `nextPlanNumber`
  // precedent) so a stored row from before the feature parses unchanged and no chapter bytes move.
  promptSuggestion: z.object({
    status: z.enum(['off', 'analyzing', 'ready', 'failed']),
    text: z.string(),
    turnSeq: z.number().int().nullable(),
    error: z.string(),
    at: z.string(),
    intent: z.enum(['worker-step', 'goal-edit']).default('worker-step'),
    goalRevision: z.number().int().nullable().default(null),
  }).default({ status: 'off', text: '', turnSeq: null, error: '', at: '', intent: 'worker-step', goalRevision: null }),
  plans: z.record(z.string(), z.object({
    number: z.number().int().positive(),
    path: z.string().min(1),
    title: z.string(),
    summary: z.string(),
    chapters: z.array(z.object({
      number: z.number().int().positive(),
      path: z.string().min(1),
      title: z.string(),
      summary: z.string(),
      startSeq: z.number().int().nonnegative(),
      endSeq: z.number().int().nonnegative(),
    })).optional(),
  })).default({}),
  finalized: z.record(z.string(), z.array(z.number().int().positive())).default({}),
  collections: z.array(collectionSchema).default([]),
})

/** Parse (and backfill defaults for) one raw registry record — the seam
 * migrations and tests use; the domain open path uses the same schema. */
export const parseSessionState = (raw: unknown): SessionState => sessionStateSchema.parse(raw)

const projectRecordSchema = z.object({
  projectKey: z.string().min(1),
  slug: z.string(),
  remote: z.string().min(1),
  harnessId: z.string().min(1),
  linkedAt: z.string(),
  cwd: z.string(),
  /** Transport kind (§15 amendment); absent on stored rows = 'git'. */
  kind: z.enum(['git', 'treedx']).default('git'),
  /** TreeDX: server-assigned repository id, resolved at link time. */
  repoId: z.string().optional(),
})

/** Parse (and default-fill) one stored project row — the migration seam tests
 * and any future provider-kind backfill use; same shape as parseSessionState. */
export const parseProjectRecord = (raw: unknown): ProjectRecordShape => projectRecordSchema.parse(raw)
type ProjectRecordShape = { projectKey: string; slug: string; remote: string; harnessId: string; linkedAt: string; cwd: string; kind: 'git' | 'treedx'; repoId?: string | undefined }

/** Durable declaration of the dsh_chapters registry domain. */export const chapterDomainSpec = defineDomain({
  name: 'dsh_chapters',
  // v1: + settings table (enrichment model overrides, P2). Existing v0 media
  // load under compatibleVersions; absent tables materialize empty.
  // v2: + rules table (P3 §7.1 records; status rides per-machine curation facts,
  // never this table).
  // v3: + projects.kind / projects.repoId (§15 amendment: transport is
  // pluggable). Stored v2 rows parse with kind defaulting to 'git' — old data
  // keeps working with zero migration, and the git path is untouched.
  version: 3,
  compatibleVersions: [0, 1, 2],
  tables: {
    sessions: domainTable<string, SessionState>(sessionStateSchema),
    projects: domainTable<string, import('./sync.ts').ProjectRecord>(projectRecordSchema),
    settings: domainTable<string, { value: string }>(z.object({ value: z.string() })),
    rules: domainTable<string, import('./rules.ts').RuleRecord>(ruleRecordSchema),
  },
})

/** Minimal structural type of `ctx.storageDomain.open(spec)` we rely on. */
export interface DomainLike {
  table(name: 'sessions'): {
    get(key: string): SessionState | undefined
    put(key: string, value: SessionState): Promise<void>
    entries(): IterableIterator<[string, SessionState]>
    readonly size: number
  }
  table(name: 'projects'): {
    get(key: string): import('./sync.ts').ProjectRecord | undefined
    put(key: string, value: import('./sync.ts').ProjectRecord): Promise<void>
    entries(): IterableIterator<[string, import('./sync.ts').ProjectRecord]>
    readonly size: number
  }
  table(name: 'settings'): {
    get(key: string): { value: string } | undefined
    put(key: string, value: { value: string }): Promise<void>
    /** Row removal (host table verb — dsh-storage-domain `delete(key)`). #71: a
     *  `model clear` must RESTORE the config fallback, which a stored value cannot
     *  express — `''` is the deliberate OFF state, deletion is the ABSENT state.
     *  Optional only so pre-delete fakes keep compiling; the store refuses loudly
     *  at the call site when the host table lacks it (every supported host has it). */
    delete?(key: string): Promise<boolean>
    entries(): IterableIterator<[string, { value: string }]>
    readonly size: number
  }
  table(name: 'rules'): {
    get(key: string): import('./rules.ts').RuleRecord | undefined
    put(key: string, value: import('./rules.ts').RuleRecord): Promise<void>
    entries(): IterableIterator<[string, import('./rules.ts').RuleRecord]>
    readonly size: number
  }
  close(): Promise<void>
}

// ---------------------------------------------------------------- registry ports

/** Read-modify-write seam over one domain. */
export type ProjectRecord = import('./sync.ts').ProjectRecord

export interface RegistryStore {
  get(sessionId: string): Promise<SessionState>
  /**
   * A whole-row write, guarded. `expectedRev` is the `rev` of the row the caller READ; a mismatch means
   * another door committed since, and the write is REFUSED with numbers rather than clobbering it.
   * Omit it only where a blind put is intended (the boot witness probe, a rollback to a captured row).
   */
  put(sessionId: string, state: SessionState, expectedRev?: number): Promise<void>
  /**
   * The ONLY sanctioned way to change a session row (#59): one serialized section per session, the fn
   * runs against a FRESH read, and the write is rev-checked. A door that holds work across an await
   * passes a function, never a snapshot — that is what stopped a stale `put` from erasing another
   * door's committed state. Nested calls for the same session are refused rather than deadlocked.
   */
  mutate(sessionId: string, fn: (state: SessionState) => SessionState | Promise<SessionState>): Promise<SessionState>
  /** Knowledge projects linked for this workspace (record §8). Live view. */
  projects(): IterableIterator<[string, ProjectRecord]>
  /** All session states in the domain (for collection publishing, §5). */
  sessions(): IterableIterator<[string, SessionState]>
  /** Durable kv (P2: enrichment model override). */
  getSetting(key: string): string | undefined
  putSetting(key: string, value: string): Promise<void>
  /** Remove a kv row entirely (#71): `clear` restores the config fallback, which
   *  a stored value cannot express — stored `''` means deliberately OFF. */
  deleteSetting(key: string): Promise<void>
  /** P3 §7.1 rule records (status is NOT here — per-machine curation facts, §15). */
  rules(): IterableIterator<[string, import('./rules.ts').RuleRecord]>
  getRule(id: string): import('./rules.ts').RuleRecord | undefined
  putRule(id: string, value: import('./rules.ts').RuleRecord): Promise<void>
}

export function makeDomainStore(domain: DomainLike): RegistryStore {
  const table = domain.table('sessions')
  const projects = domain.table('projects')
  const settings = domain.table('settings')
  const rules = domain.table('rules')

  // One serialized section per session (#59). The row is a single whole value and five doors plus the
  // turn/end signature listener write it; the wide sites hold a read across a model call or hundreds
  // of filesystem writes, and an unguarded whole-row put then silently ERASES whatever another door
  // committed in between (measured in the field: a compaction's manifest, reservation, `finalized`
  // entry and chapter record all vanished while its 960 KB file stayed on disk, and the chapter number
  // was re-spent). Serialization plus a rev check turns that into a refusal with numbers.
  const sections = new Map<string, Promise<unknown>>()
  const inside = new Set<string>()
  const runExclusive = async <T>(sessionId: string, job: () => Promise<T>): Promise<T> => {
    if (inside.has(sessionId)) {
      // Nested sections would deadlock (the inner waits on the outer's gate). Refusing is honest and
      // cheap; a caller that needs to compose two mutations does it inside ONE fn.
      throw new Error(`mutate: re-entered the registry section for ${sessionId} — compose the mutations in one fn`)
    }
    const prev = sections.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    // Chain: this session's next waiter must also wait for OUR completion, not just our predecessor.
    const mine = prev.then(() => gate)
    sections.set(sessionId, mine)
    await prev.catch(() => undefined)
    inside.add(sessionId)
    try {
      return await job()
    } finally {
      inside.delete(sessionId)
      release()
      if (sections.get(sessionId) === mine) sections.delete(sessionId)
    }
  }

  const readRow = (sessionId: string): SessionState => table.get(sessionId) ?? freshSession(sessionId)

  /** Bump the write counter and store. Only ever called from INSIDE a section. */
  const writeInside = async (sessionId: string, state: SessionState, currentRev: number): Promise<void> => {
    await table.put(sessionId, { ...state, rev: currentRev + 1 })
  }

  return {
    async get(sessionId) {
      return readRow(sessionId)
    },
    async put(sessionId, state, expectedRev) {
      return runExclusive(sessionId, async () => {
        const current = readRow(sessionId)
        if (expectedRev !== undefined && (current.rev ?? 0) !== expectedRev) {
          throw new Error(
            `registry put refused: session ${sessionId} moved under this write (expected rev ${expectedRev}, `
            + `found ${current.rev ?? 0}). Another door committed since the read — re-read and re-apply, `
            + 'do not clobber it (store.mutate).',
          )
        }
        await writeInside(sessionId, state, current.rev ?? 0)
      })
    },
    async mutate(sessionId, fn) {
      return runExclusive(sessionId, async () => {
        const before = readRow(sessionId)
        const draft = structuredClone(before)
        const next = await fn(draft)
        // Returning the very object handed in means "no change" — the same idiom commitChapters used
        // (`if (next !== state)`) so an idempotent retry costs no write and no rev bump.
        if (next === draft) return before
        await writeInside(sessionId, next, before.rev ?? 0)
        return next
      })
    },
    projects() {
      return projects.entries()
    },
    sessions() {
      return table.entries()
    },
    getSetting(key) {
      return settings.get(key)?.value
    },
    async putSetting(key, value) {
      await settings.put(key, { value })
    },
    async deleteSetting(key) {
      const del = (settings as { delete?: (k: string) => Promise<boolean> }).delete
      if (typeof del !== 'function') {
        throw new Error('settings table lacks delete — cannot restore the config default (host too old)')
      }
      await del.call(settings, key)
    },
    rules() {
      return rules.entries()
    },
    getRule(id) {
      return rules.get(id)
    },
    async putRule(id, value) {
      await rules.put(id, value)
    },
  }
}

/**
 * The NumberAllocator archive.ts asks for, bound to one author session.
 * Reserve-before-write per docs/architecture.md § Atomicity; retries reuse
 * numbers through registry.reserve's attempt-keyed idempotence.
 */
export function makeAllocator(store: RegistryStore, sessionId: string): NumberAllocator {
  return {
    // Allocation is the operation that MUST NOT interleave: two doors that both read
    // `nextChapterNumber: 15` write two different `015-*.md` files into one tree, which is the exact
    // damage #59 measured. `mutate` makes read-allocate-write one section, so the number a door is
    // handed is already durable by the time the call returns.
    async reserve(attemptId: string, count: number): Promise<number[]> {
      let numbers: number[] = []
      await store.mutate(sessionId, (state) => {
        const next = reserve(state, attemptId, count)
        numbers = next.numbers
        return next.state
      })
      return numbers
    },
    async reservePlan(attemptId: string, count: number): Promise<number[]> {
      let numbers: number[] = []
      await store.mutate(sessionId, (state) => {
        const next = reservePlanNumber(state, attemptId, count)
        numbers = next.numbers
        return next.state
      })
      return numbers
    },
    async release(attemptId: string): Promise<void> {
      await store.mutate(sessionId, (state) => releaseReservation(state, attemptId))
    },
  }
}

/** The commit-point write: verified chapter records into the session state. */
export async function commitChapters(
  store: RegistryStore,
  sessionId: string,
  records: readonly ChapterRecord[],
): Promise<void> {
  // One section, fresh read inside it (#59): the old get→append→put held the snapshot across an
  // await, which is how another door's committed state got erased.
  await store.mutate(sessionId, (state) => appendChapters(state, records))
}

/**
 * One domain, one opener: `DomainFacility.open` throws `already-open` for a
 * reserved name and never releases the reservation except via `Domain.close()`
 * (r27b proved the multi-opener lottery: plugin-apply, the realm engine, and
 * any probe all targeting dsh_chapters — whoever raced first won and everyone
 * else's compaction failed). Acquire = try open; on already-open, adopt the
 * live handle via `facility.get` and claim NO close ownership.
 */
export interface ChapterStoreHandle {
  store: RegistryStore
  /** the live domain handle: read-only table scans for acquirers that do not own it. */
  domain: DomainLike
  /**
   * True only for the acquire that actually opened the domain. Recorded for
   * observability; the CLOSER is the facility's own unmount disposer
   * (closeAll), never an opener-registered effect — a fiber-scoped close
   * effect fires when that fiber disposes, mid-run (r35).
   */
  owner: boolean
}

export async function acquireChapterStore(
  storageDomain: { open: (spec: unknown) => Promise<DomainLike>; get?: (name: string) => DomainLike | undefined },
): Promise<ChapterStoreHandle> {
  try {
    const domain = await storageDomain.open(chapterDomainSpec)
    return { store: makeDomainStore(domain), domain, owner: true }
  } catch (error) {
    if (!/already[- ]open/i.test(String((error as Error)?.message ?? error))) throw error
    const existing = storageDomain.get?.(chapterDomainSpec.name)
    if (existing === undefined) throw error
    return { store: makeDomainStore(existing), domain: existing, owner: false }
  }
}

// ---------------------------------------------------------------- filesystem port

const join = (...parts: string[]): string =>
  parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/')

/**
 * ArchiveFs over node:fs, anchored at one base dir (the session workspace).
 * Plugins are trusted same-process code — the sandbox governs TOOLS, not
 * this path — so node:fs is legitimate here; `ctx.fs` stays untouched.
 * `read` maps ENOENT to undefined; anything else propagates: a permission
 * error must not look like a missing file.
 */
/** Resolve a configured store root against the session cwd. An ABSOLUTE root
 * wins verbatim — the hosted profiles (#33) pin `/workspace/.dsh-chapters` so
 * archives land on a persisted volume no matter which subdirectory a session
 * runs in; relative roots keep the historical per-workspace meaning. */
export function resolveStoreRoot(cwd: string, storeRoot: string): string {
  return isAbsolute(storeRoot) ? storeRoot : join(cwd, storeRoot)
}

export function makeArchiveFs(baseDir: string): ArchiveFs {
  // absolute paths pass through (resolveStoreRoot may hand writeArchive an
  // absolute storeRoot); relative ones stay workspace-rooted as always.
  const abs = (p: string): string => (isAbsolute(p) ? p : join(baseDir, p))
  return {
    async write(p, content) {
      const target = abs(p)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    },
    async read(p) {
      try {
        return await readFile(abs(p), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    async exists(p) {
      return (await this.read(p)) !== undefined
    },
  }
}

/**
 * "Add <store-root>/ to .gitignore on first write and say so" — silently
 * polluting a user's tree is its own small bug (docs/architecture.md §
 * Storage). Returns a human line for the tool result's warnings.
 */
export async function ensureStoreGitignore(
  fs: ArchiveFs,
  storeRoot: string,
): Promise<string> {
  const current = await fs.read('.gitignore')
  const entry = `${storeRoot.replace(/\/+$/, '')}/`
  if (current !== undefined && current.split('\n').some((line) => line.trim() === entry)) {
    return `${entry} already in .gitignore`
  }
  const updated = (current ?? '') + (current !== undefined && !current.endsWith('\n') ? '\n' : '') +
    `\n# dsh-chapters archive (verbatim chapter store; see README)\n${entry}\n`
  await fs.write('.gitignore', updated)
  return `added ${entry} to .gitignore — say so: the plugin wrote into the repo root`
}
