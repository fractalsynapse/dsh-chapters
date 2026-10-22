/**
 * The repair engine's pure core (#60).
 *
 * Design rule, from docs/architecture.md § Repair: repair re-derives knowledge from the durable log
 * through the SAME save core, and it NEVER edits a chapter body or a log byte. So the logic that
 * decides what is wrong is pure and testable without a host — `audit()` compares the registry against
 * the files against the log, and `supersedeChapter()`/the journal decide what a mutation means. The L1
 * runner that touches the filesystem is covered in tests/integration/repair-apply.test.ts.
 *
 * Every expectation here traces to a defect measured in `/home/adrian/Projects/saip` (see
 * var/saip-audit/SAIP-CHAPTERS-AUDIT-2026-10-22.md), not to an imagined failure mode.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { audit, supersedeChapter, journalEntryInverse, type RepairFileSet } from '../../src/repair.ts'
import { freshSession, appendChapters, type ChapterRecord, type SessionState } from '../../src/registry.ts'

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const rec = (n: number, over: Partial<ChapterRecord> = {}): ChapterRecord => ({
  number: n,
  path: `.dsh-chapters/S/chapters/${String(n).padStart(3, '0')}-chapter-${n}.md`,
  title: `Chapter ${n}`, summary: 's', startSeq: (n - 1) * 10, endSeq: n * 10 - 1,
  topics: ['x'], messages: 5, sha256: `sha${n}`.padEnd(64, '0'), estimatedTokens: 1000, artifacts: [],
  ...over,
})
/** A row whose bookkeeping is CONSISTENT by construction (counter above every spent number), so a
 *  finding means a real defect and not a bad fixture — the audit rightly flagged my first version. */
const state = (chapters: ChapterRecord[], over: Partial<SessionState> = {}): SessionState => ({
  ...freshSession('S'),
  chapters,
  nextChapterNumber: Math.max(0, ...chapters.map((c) => c.number)) + 1,
  ...over,
})
/** Everything exists, nothing is hollow — the clean case must report NOTHING, not free warnings. */
const cleanFiles = (chapters: ChapterRecord[]): RepairFileSet => ({
  exists: (p) => chapters.some((c) => c.path === p),
  bytes: (p) => (chapters.find((c) => c.path === p)?.messages ?? 0) > 0 ? 4000 : 0,
  shaMatches: (p, sha) => chapters.find((c) => c.path === p)?.sha256 === sha,
  chapterPaths: chapters.map((c) => c.path),
  artifactPaths: chapters.flatMap((c) => c.artifacts.map((a) => a.path)),
  emptyArtifactPaths: chapters.flatMap((c) => c.artifacts.filter((a) => a.bytes === 0).map((a) => a.path)),
})

test('a clean registry reports no findings at all', () => {
  const cs = [rec(1), rec(2)]
  const out = audit({ sessionId: 'S', state: state(cs), files: cleanFiles(cs), log: { turnEndSeqs: [9, 19], collections: cs.map((c) => ({ from: c.startSeq, to: c.endSeq })) } as never })
  assert.deepEqual(out.findings, [], `expected silence, got ${JSON.stringify(out.findings.map((f) => f.class))}`)
})

test('hollow chapters are found: messages 0 with events, and the empty-hash artifact', () => {
  const husk = rec(6, { messages: 0, artifacts: [{ path: '.dsh-chapters/S/artifacts/e3/e3b0c442.txt', sha256: EMPTY_SHA, bytes: 0 }] })
  const out = audit({ sessionId: 'S', state: state([husk]), files: { ...cleanFiles([husk]), emptyArtifactPaths: ['.dsh-chapters/S/artifacts/e3/e3b0c442.txt'] }, log: { turnEndSeqs: [59], collections: [] } as never })
  const classes = out.findings.map((f) => f.class)
  assert.ok(classes.includes('hollow-payload'), `hollow chapter must be found: ${classes}`)
  assert.ok(classes.includes('empty-artifact'), `0-byte blob must be found: ${classes}`)
  assert.equal(out.findings.find((f) => f.class === 'hollow-payload')!.remedy, 'reread-span')
})

test('a completed turn covered by no chapter is a gap finding with its numbers', () => {
  const cs = [rec(1, { startSeq: 0, endSeq: 9 }), rec(2, { startSeq: 30, endSeq: 39 })]
  const out = audit({
    sessionId: 'S', state: state(cs), files: cleanFiles(cs),
    log: { turnEndSeqs: [9, 19, 29, 39], collections: [{ from: 0, to: 9 }, { from: 30, to: 39 }] } as never,
  })
  const gap = out.findings.find((f) => f.class === 'never-archived-span')
  assert.ok(gap, `the 10..29 hole must be reported: ${out.findings.map((f) => f.class)}`)
  assert.match(gap!.detail, /10[^\d]*29|10-29|10\.\.29/, `detail carries the seqs: ${gap!.detail}`)
  assert.equal(gap!.remedy, 'reread-span')
})

test('an orphan file, a reused number and counter drift are each found', () => {
  const cs = [rec(1), rec(1, { number: 1, path: '.dsh-chapters/S/chapters/001-other.md', sha256: 'ff'.padEnd(64, 'f') })]
  const state0 = state(cs, { nextChapterNumber: 1 })
  const files = { ...cleanFiles(cs), chapterPaths: [...cs.map((c) => c.path), '.dsh-chapters/S/chapters/099-unlisted.md'] }
  const out = audit({ sessionId: 'S', state: state0, files, log: { turnEndSeqs: [], collections: [] } as never })
  const classes = out.findings.map((f) => f.class)
  assert.ok(classes.includes('duplicate-number'), `two records on one number: ${classes}`)
  assert.ok(classes.includes('orphan-file'), 'a file no record cites: unregistered knowledge')
  assert.ok(classes.includes('countervalue-drift'), `nextChapterNumber 1 under spent numbers: ${classes}`)
})

test('a ghost plan manifest and an unreleased reservation are bookkeeping findings', () => {
  const cs = [rec(1)]
  const out = audit({
    sessionId: 'S',
    state: state(cs, { plans: { 'ghost-key': { number: 9, path: '.dsh-chapters/S/chapters/009-never-landed.md', title: 'T', summary: 's' } }, reservations: { 'att-1': [7] } }),
    files: cleanFiles(cs), log: { turnEndSeqs: [], collections: [] } as never,
  })
  const classes = out.findings.map((f) => f.class)
  assert.ok(classes.includes('ghost-plan-manifest'), classes.join(','))
  assert.ok(classes.includes('unreleased-reservation'), classes.join(','))
  assert.equal(out.findings.find((f) => f.class === 'unreleased-reservation')!.remedy, 'release-reservation')
})

test('a promised chapter file that is missing is a dead-citation to MATERIALIZE, never to delete', () => {
  const cs = [rec(1)]
  const promised = '.dsh-chapters/S/chapters/020-time-sampled.md'
  const out = audit({
    sessionId: 'S',
    // the REAL manifest shape (src/registry.ts): `chapters` are the bullets already handed the host
    state: state(cs, { plans: { 'cmp-1': { number: 1, path: cs[0]!.path, title: 'T', summary: 's', chapters: [{ number: 20, path: promised, title: 'Time sampled', summary: 's' }] } } }),
    // every file exists EXCEPT the promised one — that is the dead citation
    files: { ...cleanFiles(cs), exists: (p: string) => p !== promised },
    log: { turnEndSeqs: [], collections: [] } as never,
  })
  const dead = out.findings.filter((f) => f.class === 'dead-citation')
  assert.equal(dead.length, 1, JSON.stringify(out.findings.map((f) => f.class)))
  assert.equal(dead[0]!.remedy, 'materialize-chapter',
    'the checkpoint already handed the host this text; satisfaction is the only honest repair (#60)')
  assert.match(dead[0]!.detail, /020-time-sampled/, 'and it names the path and the number')
})

test('test litter is classified as report-only, never auto-quarantined', () => {
  const cs = [rec(1, { title: 'Probe — a test name' })]
  const out = audit({
    sessionId: 'S',
    state: state(cs),
    files: { ...cleanFiles(cs), roots: ['.dsh-chapters/probe-root'] },
    log: { turnEndSeqs: [], collections: [] } as never,
  })
  const litter = out.findings.find((f) => f.class === 'test-litter')
  assert.ok(litter, 'litter must be REPORTED even when nothing is decided automatically')
  assert.equal(litter!.remedy, 'report-only', 'deleting another rig\'s data is not this repair\'s call')
})

test('supersedeChapter marks the old record and stamps the new one, touching nothing else', () => {
  const old = rec(6)
  let s = state([old, rec(1)])
  const fresh = rec(11, { startSeq: old.startSeq, endSeq: old.endSeq })
  s = supersedeChapter(s, 6, [fresh], 'hollow-payload')
  const before = s.chapters.find((c) => c.number === 6)!
  assert.equal(before.status, 'superseded', 'the husk stops being knowledge')
  assert.equal(before.supersededBy, 11, 'and names what replaced it')
  const after = s.chapters.find((c) => c.number === 11)!
  assert.equal(after.repairs?.[0]?.class, 'hollow-payload')
  assert.equal(after.repairs?.[0]?.over, 6)
  assert.equal(s.chapters.length, 3, 'nothing deleted')
  assert.deepEqual(s.chapters.find((c) => c.number === 1)!.topics, ['x'], 'untouched records are untouched')
})

test('a superseded chapter leaves every derived layer; a legacy record never does (#60)', async () => {
  const { isActiveChapter } = await import('../../src/registry.ts')
  const s = supersedeChapter(state([rec(6), rec(1)]), 6, [rec(11, { startSeq: 50, endSeq: 59 })], 'hollow-payload')
  const old = s.chapters.find((c) => c.number === 6)!
  assert.equal(isActiveChapter(old), false, 'the husk is no longer knowledge')
  assert.equal(isActiveChapter(rec(3)), true, 'a record with no status field (every legacy archive) stays active')
  // the two derived layers that read registry chapters must go through the ONE predicate — a second
  // hand-written filter is how #52 shipped zero rules to delegated subagents, and how a repaired husk
  // would keep being cited and re-annotated forever.
  const continueSrc = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../src/continue-core.ts', import.meta.url), 'utf8'))
  assert.match(continueSrc, /priorRecords\.push\(\.\.\.st\.chapters\.filter\(isActiveChapter\)\)/,
    'the TOC feed must use isActiveChapter')
  const enrichSrc = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../src/enrich-wire.ts', import.meta.url), 'utf8'))
  assert.match(enrichSrc, /\.status !== 'superseded'/, 'the enrichment queue must skip superseded rows')
  assert.ok(!continueSrc.match(/function .*superseded/) , 'and no door may reimplement the predicate')
})

test('a journal entry knows how to undo itself', () => {
  const wrote = journalEntryInverse({ kind: 'write', path: 'a.md', beforeSha: null, afterSha: 'x' })
  assert.equal(wrote.undo, 'remove', 'a new file is undone by removing it')
  const quar = journalEntryInverse({ kind: 'quarantine', path: 'b.md', beforeSha: 'y', afterSha: 'y', to: '.repair-quarantine/b.md' })
  assert.equal(quar.undo, 'restore-from-quarantine', 'a quarantine is undone by moving the bytes back')
  const reg = journalEntryInverse({ kind: 'registry', path: 'row', beforeSha: 'old', afterSha: 'new' })
  assert.equal(reg.undo, 'restore-registry-rev', 'and a registry change records the rev it replaced')
})

test('an audit that cannot list files SAYS so instead of reporting no orphans (#60)', async () => {
  const { audit } = await import('../../src/repair.ts')
  const cs = [rec(1)]
  const files = { ...cleanFiles(cs), canScan: false }
  const out = audit({ sessionId: 'S', state: state(cs), files, log: { turnEndSeqs: [9], collections: [{ from: 0, to: 9 }] } as never })
  assert.deepEqual(out.findings, [], 'nothing is claimed to be wrong')
  assert.deepEqual(out.blindSpots, ['orphan-file', 'test-litter'],
    'and the classes it could not check are named — the host port has no readdir')
  const scanned = audit({ sessionId: 'S', state: state(cs), files: { ...cleanFiles(cs), canScan: true }, log: { turnEndSeqs: [9], collections: [{ from: 0, to: 9 }] } as never })
  assert.deepEqual(scanned.blindSpots, [], 'a port that CAN scan reports no blind spots')
})
