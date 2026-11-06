/**
 * #319 part 3b — the restore door's two testable halves, BEFORE either exists (red-first):
 *   src/durable-log.ts  — the plugin-side raw decode of a session's durable log (the same
 *                         multi-frame technique the repair CLI proved on the maintainer's real
 *                         bytes: one ZSTD frame PER FLUSH, torn final line tolerated, highest
 *                         session.vN wins).
 *   src/restore.ts      — the pure handler: resolve the id, dry-run by default, repair through
 *                         the injected runRepair core, create through the injected createChild
 *                         seam; ambiguous/unknown ids refused, never guessed.
 * The tools.ts wiring is pinned separately (source-scan row) — the behavior lives here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

// ---------- durable-log: synthetic multi-frame, torn line, versioned files ----------
function writeLog(dir: string, version: number, frames: readonly string[]): void {
  fs.mkdirSync(dir, { recursive: true })
  const buf = frames.map((f) => zlib.zstdCompressSync(Buffer.from(f, 'utf8')))
  fs.writeFileSync(path.join(dir, `session.v${String(version)}.jsonl.zstd`), Buffer.concat(buf))
}

test('#319: decodeDurableLog reads across every zstd frame and tolerates a torn tail', async () => {
  const { decodeDurableLog } = await import('../../src/durable-log.ts')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-log-'))
  writeLog(home, 4, [
    JSON.stringify({ type: 'session', version: 4, id: 'ch-x', createdAt: 1, cwd: '/x', isSeeded: false, delegationDepth: 0 }) + '\n',
    JSON.stringify({ type: 'user/message', seq: 0, time: 2, data: { a: 1 } }) + '\n' + JSON.stringify({ type: 'turn/end', seq: 1, time: 3, data: {} }) + '\n',
    '{"type":"tool/result","seq":2,"tim', // torn final line — half a frame
  ])
  const out = decodeDurableLog(home)
  assert.ok(out !== null)
  assert.equal(out.header?.id, 'ch-x', 'the header record is separated from events')
  assert.deepEqual(out.events.map((e) => e.seq), [0, 1], 'both events from later frames arrive; the torn half-line is skipped')
})

test('#319: decodeDurableLog prefers the highest session.vN and answers null for a missing dir', async () => {
  const { decodeDurableLog } = await import('../../src/durable-log.ts')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-log2-'))
  writeLog(home, 3, [JSON.stringify({ type: 'session', version: 3, id: 'old' }) + '\n', JSON.stringify({ type: 'user/message', seq: 0, time: 1, data: {} }) + '\n'])
  writeLog(home, 4, [JSON.stringify({ type: 'session', version: 4, id: 'new' }) + '\n'])
  const out = decodeDurableLog(home)
  assert.equal(out?.header?.id, 'new', 'the kernel names versions; the highest wins, as the repair CLI does')
  assert.equal(decodeDurableLog(path.join(home, 'nope')), null)
})

// ---------- restore handler: resolution, dry-run default, refusal texts ----------
const mkDeps = (over: Partial<{
  rows: Record<string, { rev: number; chapters: unknown[] }>
  dirs: Record<string, { header: { cwd: string } | null; events: unknown[] } | null>
  repair: (id: string, dryRun: boolean) => Promise<string>
  create: (id: string) => Promise<string>
}> = {}) => {
  const calls: string[] = []
  const deps = {
    rows: () => over.rows ?? { 'ch-alpha': { rev: 1, chapters: [] }, 'ch-beta': { rev: 1, chapters: [] } },
    dirFor: (id: string) => (over.dirs !== undefined && id in over.dirs ? over.dirs[id] : { header: { cwd: '/w' }, events: [] }) as { header: { cwd?: string } | null } | null,
    repair: over.repair ?? (async (id: string, dry: boolean) => { calls.push(`repair:${id}:${String(dry)}`); return dry ? '2 finding(s) would be re-derived' : 're-derived 2' }),
    create: over.create ?? (async (id: string) => { calls.push(`create:${id}`); return 'ch-fresh' }),
    log: (line: string) => { calls.push(line) },
  }
  return { deps, calls }
}

test('#319: restore resolves exact ids, repairs DRY by default, and only creates on apply', async () => {
  const { runRestoreHandler } = await import('../../src/restore.ts')
  const { deps, calls } = mkDeps()
  const r1 = await runRestoreHandler(deps, 'ch-alpha', [])
  assert.match(r1, /dry-run/, 'the default names itself')
  assert.ok(calls.includes('repair:ch-alpha:true') && !calls.some((c) => c.startsWith('create:')), 'no writes, no child without the word')
  calls.length = 0
  const r2 = await runRestoreHandler(deps, 'ch-alpha', ['apply'])
  assert.ok(calls.includes('repair:ch-alpha:false') && calls.includes('create:ch-alpha'), 'apply repairs then creates')
  assert.match(r2, /ch-fresh/, 'the new child id is reported')
})

test('#319: unknown ids are refused with candidates; ambiguous prefixes are refused with BOTH matches', async () => {
  const { runRestoreHandler } = await import('../../src/restore.ts')
  const { deps } = mkDeps()
  assert.match(await runRestoreHandler(deps, 'ch-zzz', []), /no session matches/, 'unknown: refused, and says so')
  assert.match(await runRestoreHandler(deps, 'ch-', ['apply']), /ambiguous/, 'shared prefix: the word apply never rescues a guess')
  assert.match(await runRestoreHandler(deps, 'ch-', ['apply']), /ch-alpha/)
  assert.match(await runRestoreHandler(deps, 'ch-', ['apply']), /ch-beta/)
})

test('#319: a target whose durable log is missing/unparsable is refused without touching anything', async () => {
  const { runRestoreHandler } = await import('../../src/restore.ts')
  const { deps, calls } = mkDeps({ dirs: { 'ch-alpha': null } })
  assert.match(await runRestoreHandler(deps, 'ch-alpha', ['apply']), /NO durable log/, 'the ONLY source of truth is missing — say it, write nothing')
  assert.equal(calls.filter((c) => c.startsWith('repair:') || c.startsWith('create:')).length, 0)
})

test('#319: the wiring exists — tools.ts registers the command, and it lives OUTSIDE the anchor surface', async () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'tools.ts'), 'utf8')
  assert.match(src, /makeRestoreCommand\(\{/, 'tools.ts wires the factory with its machine seams')
  assert.doesNotMatch(src, /name: 'chapters-restore'/, 'the human-facing command text is NOT in a prompt-surface file (anchor #156: commands never reach the model)')
  const cmd = fs.readFileSync(path.join(process.cwd(), 'src', 'restore-command.ts'), 'utf8')
  assert.match(cmd, /text = await runRestoreHandler\(\{/, 'the command delegates to the tested handler')
  assert.match(cmd, /chapters-restore: \$\{String\(\(error as Error\)/, 'seam refusals are delivered as error text, not thrown stacks')
})

// ---- continueFromRestored: the SHARED tail, mirrored on purpose (#319) ----------
import { continueFromRestored, type ContinuePorts, type ContinueConfig } from '../../src/continue-core.ts'
import { freshSession } from '../../src/registry.ts'

const RC: ContinueConfig = {
  artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
  continuationBudgetRatio: 0.25, fallbackPreset: 'chapters',
}
const mkPorts = (over: { budget?: { windowTokens: number | null; headerBoundTokens?: number }; createFails?: boolean } = {}) => {
  const live = new Map<string, ReturnType<typeof freshSession>>()
  const t = { ...freshSession('ch-target'), rootSession: 'ch-target' }
  live.set('ch-target', t)
  const created: { id: string; notice: string }[] = []
  const ports = {
    readCallerEvents: async () => [],
    getState: async (id: string) => structuredClone(live.get(id) ?? freshSession(id)),
    putState: async (id: string, s: unknown) => { live.set(id, s as never) },
    mutateState: async (id: string, fn: (s: never) => never) => { live.set(id, fn(live.get(id) as never)) },
    fs: () => ({}) as never,
    budgetProbe: async () => ({ windowTokens: over.budget?.windowTokens ?? 131072, headerBoundTokens: over.budget?.headerBoundTokens ?? 13000 }),
    newId: (() => { let n = 9000; return () => String(n += 1) })(),
    createChild: async (i: { sessionId: string; noticeEvent: { data: { content: { text: string }[] } } }) => {
      if (over.createFails === true) throw new Error('kernel refusal')
      created.push({ id: i.sessionId, notice: i.noticeEvent.data.content[0]!.text })
      return { warnings: [] }
    },
    now: () => 5,
  }
  return { ports: ports as unknown as ContinuePorts, live, created }
}

test('#319: continueFromRestored births a child through the SAME pieces and links it to the TARGET', async () => {
  const { ports, live, created } = mkPorts()
  const out = await continueFromRestored(ports, RC, 'ch-target')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.ok(out.ok)
  assert.equal(created.length, 1)
  assert.match(created[0]!.notice, /Created by chapters-restore/, 'the handoff names its own origin')
  const childRow = live.get(out.childId)
  assert.ok(childRow !== undefined, 'the child row is committed')
  assert.equal(childRow.parentSession, 'ch-target', 'linkChild routes to the restored session, not the caller')
  assert.equal(childRow.rootSession, 'ch-target')
})

test('#319: over-budget refuses with NUMBERS and states the repair survived; a kernel refusal is a reason, never a throw', async () => {
  const tight = mkPorts({ budget: { windowTokens: 16000, headerBoundTokens: 15000 } })
  const r1 = await continueFromRestored(tight.ports, RC, 'ch-target')
  assert.equal(r1.ok, false)
  assert.match(r1.reason ?? '', /over budget/, 'measured refusal')
  assert.match(r1.reason ?? '', /REPAIRED/, 'the repair is not undone by a budget miss')
  const faily = mkPorts({ createFails: true })
  const r2 = await continueFromRestored(faily.ports, RC, 'ch-target')
  assert.equal(r2.ok, false)
  assert.match(r2.reason ?? '', /kernel refusal/)
})

test('#319: findDurableLogDir walks the kernel\u2019s own layout (slug dirs, both id spellings) and answers null otherwise', async () => {
  const { findDurableLogDir } = await import('../../src/durable-log.ts')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-base-'))
  const dir = path.join(base, '--home-x-Projects-p--', 'ch-deadbeef')
  writeLog(dir, 4, [JSON.stringify({ type: 'session', version: 4, id: 'ch-deadbeef' }) + '\n'])
  assert.equal(findDurableLogDir('ch-deadbeef', base), dir)
  assert.equal(findDurableLogDir('ch-nope', base), null)
  assert.equal(findDurableLogDir('ch-deadbeef', path.join(base, 'absent')), null)
})
