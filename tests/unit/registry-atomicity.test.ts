/**
 * Registry atomicity and reservation identity (#59).
 *
 * The row is ONE whole value and five doors plus the turn/end signature listener write it. The wide
 * sites hold a snapshot across an await — a model call, or hundreds of filesystem writes — so a stale
 * `put` silently erases another door's COMMITTED state. That is worse than an orphan file: the files
 * still look right, and only the registry knows.
 *
 * Field instance (SAIP session-aac0254e, second-level timestamps): a compaction committed its manifest
 * and wrote its chapter at 04:53:50.915; an enrichment put built from a pre-compaction read landed at
 * 04:53:52.841 and rewound the row — manifest, reservation, `finalized` entry and chapter record all
 * gone, the 960 KB file still on disk, and chapter number 15 re-spent by the next door (two different
 * `015-*.md` files in one tree).
 *
 * These rows are written to FAIL before the fix and to pin the mechanism after it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendChapters, freshSession, releaseReservation, reserve, type SessionState } from '../../src/registry.ts'
import { makeDomainStore, type DomainLike } from '../../src/store.ts'
import type { ChapterRecord } from '../../src/archive.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const rec = (number: number, sha: string): ChapterRecord => ({
  number, path: `.dsh-chapters/A/chapters/${number}-x.md`, title: `T${number}`, summary: 's',
  startSeq: 0, endSeq: 1, sha256: sha, estimatedTokens: 10, artifacts: [],
})

/** In-memory domain whose `get` can be observed mid-flight, to build the interleave deliberately. */
function fakeDomain(opts: { onGet?: () => Promise<void> } = {}): { domain: DomainLike; map: Map<string, SessionState> } {
  const map = new Map<string, SessionState>()
  const domain: DomainLike = {
    table() {
      return {
        get: (k: string) => map.get(k),
        put: async (k: string, v: SessionState) => { map.set(k, structuredClone(v)) },
        entries: () => map.entries(),
        get size() { return map.size },
      } as never
    },
    close: async () => {},
  }
  if (opts.onGet !== undefined) {
    // wrap the table's get so the read can yield, exactly as a model call does in production
    const inner = domain.table
    domain.table = ((name: string) => {
      const t = inner.call(domain, name) as never as { get: (k: string) => SessionState | undefined }
      let seen = false
      return {
        ...t as object,
        get: (k: string) => { void (opts.onGet!)(); if (seen) return undefined; seen = true; return t.get(k) },
      } as never
    }) as never
  }
  return { domain, map }
}

// ---------------------------------------------------------------- the lost update

test('two doors mutating one session row BOTH survive when they go through mutate()', async () => {
  const { domain, map } = fakeDomain()
  map.set('A', { ...freshSession('A'), nextChapterNumber: 15 })
  const store = makeDomainStore(domain)
  // Door 1: a compaction committing its manifest + reservation. In production this read is held
  // across a plot elicitation (a MODEL CALL) before the write — engine.ts:567 → :641.
  const compaction = store.mutate('A', (s) => {
    const r = reserve(s, 'compaction:cid-1', 1)
    return { ...r.state, plans: { ...r.state.plans, 'cid-1': { number: r.numbers[0]!, path: 'p', title: 't', summary: 's' } } }
  })
  // Door 2: the enrichment ladder, which reads, calls the model, then writes the WHOLE row back
  // (enrich-wire.ts:185 → :297). Inside mutate the await is the model call; the read is re-taken at
  // write time, so the snapshot can no longer be stale.
  const ladder = store.mutate('A', async (s) => {
    await sleep(5) // the annotator
    return { ...s, chapters: [...s.chapters, rec(14, 'e'.repeat(64))] }
  })
  await Promise.all([compaction, ladder])
  const after = await store.get('A')
  assert.ok(after.chapters.some((c) => c.number === 14), 'the ladder record survived')
  assert.ok(after.plans['cid-1'] !== undefined, 'the compaction manifest survived')
  assert.ok(after.reservations['compaction:cid-1'] !== undefined, 'its reservation survived')
  assert.equal(after.nextChapterNumber, 16, 'one number spent, by the door that reserved it')
})

test('a blind whole-row put cannot erase a committed row: rev mismatch refuses with numbers', async () => {
  const { domain, map } = fakeDomain()
  map.set('A', { ...freshSession('A'), rev: 3 })
  const store = makeDomainStore(domain)
  const stale = { ...(await store.get('A')), chapters: [rec(14, 'e'.repeat(64))] }
  await store.mutate('A', (s) => ({ ...s, plans: { 'cid-1': { number: 15, path: 'p', title: 't', summary: 's' } } }))
  // The SAIP shape exactly: a write built from a pre-clobber snapshot, arriving late.
  await assert.rejects(() => store.put('A', stale, 3), /rev 3|rev 4|refused/i,
    'the clobber must be a loud refusal, not a silent erasure')
  const after = await store.get('A')
  assert.ok(after.plans['cid-1'] !== undefined, 'the committed manifest is intact after the refusal')
  // Without an expectedRev the caller has explicitly opted out of the check (the boot witness and the
  // rollback path do); the guard is only meaningful where callers use mutate/put(expectedRev).
})

test('no production door writes a session row from a held snapshot (#59 source shape)', async () => {
  const fs = await import('node:fs/promises')
  const read = async (f: string): Promise<string> => (await fs.readFile(new URL(f, import.meta.url))).toString()
  // engine.ts: the summarize put and the finalize put; enrich-wire: the ladder put; save-core/tools:
  // the allocator and commit puts. All must be mutate() — a raw put of a snapshot read earlier is the bug.
  for (const [file, label] of [['../../src/engine.ts', 'summarize/finalize'], ['../../src/enrich-wire.ts', 'the ladder'], ['../../src/save-core.ts', 'the save door']] as const) {
    const src = await read(file)
    const rawPuts = [...src.matchAll(/(?:store|deps\.store)\.put\(([^,]+),\s*([A-Za-z_$][\w$.]*)\)/g)]
      .filter((m) => !/^fresh$|^r\.state$|^next\.state$/.test(m[2] ?? ''))
    assert.equal(rawPuts.length, 0, `${label}: whole-row put of a held snapshot (${rawPuts.map((m) => m[2]).join(', ')}) — use store.mutate`)
  }
})

// ---------------------------------------------------------------- identity + reservations

test('appendChapters refuses a REUSED number carrying different bytes', () => {
  let s = freshSession('A')
  s = appendChapters(s, [rec(15, 'a'.repeat(64))])
  s = appendChapters(s, [rec(15, 'a'.repeat(64))])          // identical retry: still a no-op
  assert.equal(s.chapters.length, 1, 'an identical retry stays idempotent')
  // The SAIP shape: the same number, a different chapter. Number-only identity treated this as a
  // retry and dropped the record while the file stayed on disk.
  assert.throws(() => appendChapters(s, [rec(15, 'b'.repeat(64))]), /number 15|collision/i,
    'a reused number with different content must refuse, not quietly no-op')
})

test('a reservation whose files never landed is released, not burned forever', () => {
  const s0 = freshSession('A')
  const r = reserve(s0, 'attempt-x', 3)
  assert.deepEqual(r.numbers, [1, 2, 3])
  const freed = releaseReservation(r.state, 'attempt-x')
  assert.equal(freed.reservations['attempt-x'], undefined, 'the key is gone')
  // Releasing must NOT make those numbers reusable: the burned-number rule exists so a file that
  // landed while a commit was lost can never be overwritten by a later chapter.
  const again = reserve(freed, 'attempt-y', 1)
  assert.deepEqual(again.numbers, [4], 'nextChapterNumber keeps the allocation; only the retry key is freed')
})

test('finalize scan: one manifest-less compaction does not block the others (#59 poison pill)', async () => {
  // The SAIP end state: cid-1 has no manifest (it was erased), cid-2 and cid-3 do. The scan must
  // report/contain the bad item and STILL finalize the later two.
  const { scanAndFinalize } = await import('../../src/engine-core.ts')
  assert.equal(typeof scanAndFinalize, 'function', 'the scan needs a pure, per-item-contained form to be testable at all')
  const summaries = [
    { compactionId: 'cid-1', summarySeq: 10, shadowedSeqs: [1, 2] },
    { compactionId: 'cid-2', summarySeq: 20, shadowedSeqs: [3, 4] },
  ]
  const state: SessionState = {
    ...freshSession('A'),
    reservations: { 'compaction:cid-2': [2] },
    plans: { 'cid-2': { number: 2, path: 'p2', title: 't2', summary: 's2' } },
  }
  const done: string[] = []
  const out = await scanAndFinalize(state, summaries, async (found) => { done.push(found.compactionId) })
  // The guarantee is NOT "both finalized" — cid-1 cannot be. It is "the later item still ran",
  // which is precisely what the bare loop lost: one erased manifest poisoned the queue forever.
  assert.deepEqual(done, ['cid-2'], 'the healthy item behind the bad one still finalized')
  assert.deepEqual(out.skipped, [{ compactionId: 'cid-1', reason: 'no-manifest' }], 'the bad item is NAMED, not swallowed')
})

test('the dead reservation checker is wired, not dead code (#59)', async () => {
  const core = await import('../../src/engine-core.ts')
  assert.equal(typeof core.assertReservationMatchesPlan, 'function')
  const src = await (await import('node:fs/promises')).readFile(new URL('../../src/engine.ts', import.meta.url), 'utf8')
  const wire = await (await import('node:fs/promises')).readFile(new URL('../../src/engine-core.ts', import.meta.url), 'utf8')
  assert.match(`${src}\n${wire}`.replace(/export function assertReservationMatchesPlan\(/, ''), /assertReservationMatchesPlan\(/,
    'the drift check that would have caught the SAIP clobber at commit time has zero callers')
})

test('an attempt that lands nothing releases its key; a partial landing keeps it (#59)', async () => {
  const { writeArchive } = await import('../../src/archive.ts')
  const { renderChapter } = await import('../../src/render.ts')
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'doing it' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ] as never[]
  const chapter = renderChapter(events as never, { title: 'T', summary: 's', startSeq: 0, endSeq: 3 }, { toolResultDeferFloorTokens: 200, chapterTokenTarget: 8000 } as never, [], [])
  const released: string[] = []
  const allocator = {
    async reserve() { return [7] },
    async release(key: string) { released.push(key) },
  }
  // A filesystem whose read-back always fails: the chapter is NOT citable, so zero records land.
  const fsStub = {
    async write() {}, async exists() { return false }, async read() { return undefined },
  }
  const out = await writeArchive({ fs: fsStub as never, allocator: allocator as never, storeRoot: '.dsh-chapters', rootSessionId: 'A', chapters: [chapter], attemptId: 'attempt-1' })
  assert.equal(out.records.length, 0, 'nothing landed')
  assert.deepEqual(released, ['attempt-1'], 'the attempt key was freed rather than left to accumulate')
  assert.ok(out.warnings.some((w) => w.includes('released')), 'and the release is reported, not silent')
})
