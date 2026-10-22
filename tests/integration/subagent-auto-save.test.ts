/**
 * ACCEPTANCE (issue #47): a settling subagent becomes searchable knowledge —
 * chapters written, registry committed, lineage frontmatter stamped — with NO
 * compaction and NO model. This is the door-5 journey through the REAL pipeline
 * (saveSession → composeChapters → renderChapter → writeArchive → commitChapters)
 * with the host seam stubbed to the shapes pinned by spikes/subagent-end/FINDINGS.md.
 *
 * Also pins the two load-bearing decisions:
 *   - ONE builder: /chapters-save and auto-save archive byte-identically from the
 *     same log (the repo's established refusal of two implementations that drift).
 *   - enrichment is QUEUED, never run-now, per settlement.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { wireSubagentAutoSave } from '../../src/auto-save.ts'
import { buildChaptersTools } from '../../src/tools.ts'
import { freshSession, type SessionState } from '../../src/registry.ts'
import { buildLocalCorpus, rankEntries } from '../../src/search.ts'
import type { SessionEventLike } from '../../src/types.ts'
import { withMutate } from '../fake-store.ts'

const CONFIG = {
  artifactStoreRoot: '.dsh-chapters',
  chapterTokenTarget: 8000,
  toolResultDeferFloorTokens: 200,
  continuationBudgetRatio: 0.25,
  fallbackPreset: 'chapters',
  mergeThreshold: 0.3,
  chapterLimit: 8000,
}

const MARK = 'ZEPHYR-MARKER-77'

/** One completed turn authored through the same event shapes the real kernel writes. */
function turnEvents(turn: number, text: string): SessionEventLike[] {
  const lo = (turn - 1) * 5
  return [
    { type: 'turn/start', seq: lo, data: { turn } },
    { type: 'user/message', seq: lo + 1, data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `task ${turn}` }] } },
    { type: 'assistant/message', seq: lo + 2, data: { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: `${text} ${MARK}-T${turn}` }] } } },
    { type: 'step/end', seq: lo + 3, data: { turn, step: 1 } },
    { type: 'turn/end', seq: lo + 4, data: { turn, reason: { kind: 'completed' } } },
  ] as unknown as SessionEventLike[]
}

interface WorldOpts {
  events?: SessionEventLike[]
  childHeader?: Record<string, unknown>
}

function makeWorld(opts: WorldOpts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-save-'))
  const states = new Map<string, SessionState>()
  const store = withMutate({
    get: async (id: string): Promise<SessionState> => states.get(id) ?? freshSession(id),
    put: async (id: string, st: SessionState): Promise<void> => { states.set(id, st) },
  }) as never
  const schedules: Array<[string, string]> = []
  const enrichRuns: string[] = []
  const warnings: string[] = []
  const childId = 'child-1'
  const events = opts.events ?? [...turnEvents(1, 'reading the paper'), ...turnEvents(2, 'summarizing findings')]
  const header = { id: childId, cwd: tmp, parentSession: 'parent-1', origin: 'subagent', agentPreset: 'chapters', ...(opts.childHeader ?? {}) }
  const session = {
    id: childId,
    header,
    snapshotEvents: () => events,
  }
  const live = new Map<string, unknown>([[childId, { agent: { session } }]])
  const ctx = {
    get: (name: string): unknown =>
      name === 'agents' ? { get: (id: string) => live.get(id) } : undefined,
    logger: { warn: (m: string) => { warnings.push(m) } },
  }
  const listener = wireSubagentAutoSave(ctx as never, store, {
    presetId: 'chapters',
    ...CONFIG,
    scheduler: { schedule: (cwd: string, reason: string) => { schedules.push([cwd, reason]) } },
    enrich: { runNow: async (cwd?: string) => { enrichRuns.push(cwd ?? ''); return { processed: 0, remaining: 0 } } },
  } as never)
  return { tmp, store, states, schedules, enrichRuns, warnings, listener, events, childId }
}

const drain = () => new Promise((r) => setTimeout(r, 120))

test('acceptance: subagent end → verbatim chapters with lineage frontmatter, no compaction, no child', async () => {
  const w = makeWorld()
  w.listener({ id: w.childId, runId: 'r1', provider: 'spawn', stopReason: 'completed' })
  await drain()

  const state = w.states.get('child-1')
  assert.ok(state !== undefined, 'registry state committed')
  assert.ok(state!.chapters.length >= 1, `chapters recorded (got ${state?.chapters.length})`)
  assert.equal(state!.rootSession, 'child-1', 'the child is its OWN root — no linkChild into the parent lineage')
  assert.equal(state!.parentSession, null, 'ancestry untouched')

  const rec = state!.chapters[0]!
  const file = path.join(w.tmp, rec.path)
  assert.ok(fs.existsSync(file), `chapter file on disk at ${rec.path}`)
  const md = fs.readFileSync(file, 'utf8')
  const head = md.slice(0, md.indexOf('\n---\n', 4))
  assert.match(head, /subagent: true/, 'lineage declares membership')
  assert.match(head, /parentSession: "parent-1"/, 'and the parent id, from the durable header')
  assert.match(md, new RegExp(MARK + '-T1'), 'verbatim child text')

  // the archive is SEARCHABLE through the local door — the whole point of #47.
  // The index carries title/topics/summary (the body is retrieved by `read` on
  // the cited path, which the assertion above already proves verbatim), so the
  // query targets the indexed surface and the hit must name the child's tree.
  const { entries, summaries } = buildLocalCorpus(path.join(w.tmp, '.dsh-chapters'))
  assert.ok(entries.length >= 1, 'corpus sees the child chapter')
  const hit = rankEntries(entries, summaries, ['task'], Date.now(), null, 0, 400)
  assert.ok(hit.total >= 1, 'an indexed-term query finds the child chapter')
  assert.match(hit.results[0]!.path, /child-1/, 'the citation points into the CHILD tree')

  // sync is scheduled (chapters must travel); enrichment is NOT run per child
  assert.equal(w.schedules.length, 1)
  assert.equal(w.schedules[0]![0], w.tmp)
  assert.match(w.schedules[0]![1], /autoSave/, `reason names the door (${w.schedules[0]![1]})`)
  assert.equal(w.enrichRuns.length, 0, 'NEVER runNow per settlement — a fanout must not hammer the annotator')
})

test('idempotent: the same settled span re-settling adds nothing', async () => {
  const w = makeWorld()
  w.listener({ id: w.childId })
  await drain()
  const first = w.states.get('child-1')!.chapters.length
  const files = fs.readdirSync(path.join(w.tmp, '.dsh-chapters', 'child-1', 'chapters')).sort()
  w.listener({ id: w.childId }) // continuable child settles again, nothing new said
  await drain()
  assert.equal(w.states.get('child-1')!.chapters.length, first, 'no duplicate records')
  const after = fs.readdirSync(path.join(w.tmp, '.dsh-chapters', 'child-1', 'chapters')).sort()
  assert.deepEqual(after, files, 'no new files — the watermark held')
})

test('growth: a re-woken child with a new turn archives ONLY the new span', async () => {
  const w = makeWorld({ events: turnEvents(1, 'first leg') })
  w.listener({ id: w.childId })
  await drain()
  const rec1 = w.states.get('child-1')!.chapters[0]!
  const file1 = path.join(w.tmp, rec1.path)
  const bytes1 = fs.readFileSync(file1, 'utf8')

  // extend the SAME log with a second completed turn, then settle again
  ;(w.events as SessionEventLike[]).push(...turnEvents(2, 'second leg'))
  w.listener({ id: w.childId })
  await drain()

  const state = w.states.get('child-1')!
  assert.equal(state.chapters.length, 2)
  assert.equal(state.chapters[1]!.startSeq, rec1.endSeq + 1, 'new chapter starts after the watermark')
  assert.equal(fs.readFileSync(file1, 'utf8'), bytes1, 'the earlier chapter file was never rewritten')
})

test('gate: a non-chapters child settles and nothing is written', async () => {
  const w = makeWorld({ childHeader: { agentPreset: 'standard' } })
  w.listener({ id: w.childId })
  await drain()
  assert.equal(w.states.get('child-1'), undefined, 'no registry state touched')
  assert.equal(fs.existsSync(path.join(w.tmp, '.dsh-chapters')), false, 'no store tree at all')
})

test('gate: an interrupted child with zero completed turns archives nothing and says nothing loud', async () => {
  const w = makeWorld({ events: [{ type: 'user/message', seq: 1, data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] } }] as never })
  w.listener({ id: w.childId })
  await drain()
  assert.equal(w.states.get('child-1'), undefined)
  assert.equal(w.warnings.length, 0, 'a child that never completed a turn is a quiet skip, not an error')
})

test('refused: the durable arm reads payload-less records → no chapter, no number spent (#58)', async () => {
  // The host's listEvents returns SessionEventRecord — {sessionId, seq, type, time, surface} and
  // NO data. That is the shape that produced 12 hollow chapters. The stub is now the HOST's shape,
  // not ours: a fixture fatter than the host is how this shipped (see docs/verify.md § Door 5).
  const w = makeWorld()
  const records = w.events.map((e) => ({ sessionId: 'child-1', seq: e.seq, type: e.type, time: e.time ?? 0, surface: 'current' }))
  const tmp = w.tmp
  const store = withMutate({
    get: async (id: string): Promise<SessionState> => w.states.get(id) ?? freshSession(id),
    put: async (id: string, st: SessionState): Promise<void> => { w.states.set(id, st) },
  }) as never
  const warns: string[] = []
  const ctx = {
    get: (name: string): unknown => name === 'agents'
      ? { get: () => undefined }
      : name === 'sessionQuery'
        ? {
          // exactly verb 1: metadata only
          listEvents: async () => records,
          // and verb 2, unused by this row: payload-bearing, proves the refusal is shape-driven
          readSession: async () => ({ session: { id: 'child-1', cwd: tmp, parentSession: 'parent-1', origin: 'subagent', agentPreset: 'chapters' }, events: records }),
          listSessions: async () => [{ header: { id: 'child-1', cwd: tmp, parentSession: 'parent-1', origin: 'subagent', agentPreset: 'chapters' } }],
        }
        : undefined,
    logger: { warn: (m: string) => { warns.push(m) }, info: () => {} },
  }
  const listener = wireSubagentAutoSave(ctx as never, store, { presetId: 'chapters', ...CONFIG } as never)
  listener({ id: 'child-1' })
  await new Promise((r) => setTimeout(r, 250))
  const st = w.states.get('child-1')
  assert.equal(st?.chapters.length ?? 0, 0, 'a payload-less read must NOT produce a chapter record')
  assert.equal(st?.nextChapterNumber ?? 1, 1, 'and must not spend a chapter number — a spent number is a poisoned watermark')
  assert.equal(fs.existsSync(path.join(tmp, '.dsh-chapters', 'child-1', 'chapters')), false, 'no chapter file, and no tree created for one')
  assert.ok(warns.some((x) => /payloadless|no conversation|not archived/i.test(x)), `the skip must be LOUD, got: ${JSON.stringify(warns)}`)
})

test('durable arm: the payload-bearing readSession archives a disposed continuable child (#58)', async () => {
  // A continuable child is disposed BEFORE subagent/end (host-subagent-seam F4), so this arm is
  // not an edge case — in the field it is the only one that ever runs.
  const w = makeWorld()
  const tmp = w.tmp
  const store = withMutate({
    get: async (id: string): Promise<SessionState> => w.states.get(id) ?? freshSession(id),
    put: async (id: string, st: SessionState): Promise<void> => { w.states.set(id, st) },
  }) as never
  const ctx = {
    get: (name: string): unknown => name === 'agents'
      ? { get: () => undefined } // handle disposed at emit
      : name === 'sessionQuery'
        ? {
          readSession: async () => ({
            session: { id: 'child-1', cwd: tmp, parentSession: 'parent-1', origin: 'subagent', agentPreset: 'chapters' },
            events: w.events,
          }),
          listSessions: async () => [{ header: { id: 'child-1', cwd: tmp, parentSession: 'parent-1', origin: 'subagent', agentPreset: 'chapters' } }],
        }
        : undefined,
    logger: { warn: () => {}, info: () => {} },
  }
  const listener = wireSubagentAutoSave(ctx as never, store, { presetId: 'chapters', ...CONFIG } as never)
  listener({ id: 'child-1' })
  await new Promise((r) => setTimeout(r, 250))
  const st = w.states.get('child-1')
  assert.ok((st?.chapters.length ?? 0) >= 1, 'the durable arm archived the settled span')
  const md = fs.readFileSync(path.join(tmp, st!.chapters[0]!.path), 'utf8')
  assert.match(md, new RegExp(MARK + '-T1'), 'with real bytes, not an unknown/0 B shell')
  assert.doesNotMatch(md, /\*\*unknown\*\*/, 'and no unrecognised-event noise')
})

test('lineage by design: the child keeps its OWN tree, and is reachable via the search door (#58 re-check)', async () => {
  // An earlier draft of this fix called linkChild() on door 5. Both justifications for it were
  // then measured and rejected, and this row is the reason: (a) buildIndex walks ANCESTORS, so a
  // child added to the parent's lineage still appears in no parent TOC — no reach gained;
  // (b) rootSession IS the store directory, so the link would move every child chapter into the
  // parent's tree — layout broken for nothing. What DOES make a settled child reachable is the
  // local search door, which walks all trees: that is the assertion here.
  const w = makeWorld()
  w.states.set('parent-1', { ...freshSession('parent-1'), parentSession: null, rootSession: 'parent-1' })
  w.listener({ id: w.childId, runId: 'r1', provider: 'spawn', stopReason: 'completed' })
  await drain()
  const st = w.states.get('child-1')
  assert.equal(st?.rootSession, 'child-1', 'own root = own tree (the #47 decision, re-verified)')
  assert.equal(st?.parentSession, null, 'registry ancestry untouched; the parent-child fact lives in the chapter frontmatter, from the kernel header')
  const rec = st!.chapters[0]!
  assert.ok(rec.path.includes('/child-1/chapters/'), `chapters stayed in the child tree: ${rec.path}`)
  // reachable: buildLocalCorpus walks every tree under the store root, so a settled child is
  // searchable from any session in the workspace — including from the parent's own continuation.
  const { entries } = buildLocalCorpus(path.join(w.tmp, '.dsh-chapters'))
  assert.ok(entries.some((e) => e.path.includes('child-1')), 'the child chapter is in the search corpus')
})

test('depth 2: a grandchild (its parent is a continuation child) archives through the same door', async () => {
  const w = makeWorld()
  w.states.set('ch-parent', { ...freshSession('ch-parent'), parentSession: null, rootSession: 'ch-parent' })
  const events = [...turnEvents(1, 'extracting internals'), ...turnEvents(2, 'reporting line refs')]
  const header = { id: 'grand-1', cwd: w.tmp, parentSession: 'ch-parent', origin: 'subagent', agentPreset: 'chapters' }
  const session = { id: 'grand-1', header, snapshotEvents: () => events }
  const states = w.states
  const store = withMutate({
    get: async (id: string): Promise<SessionState> => states.get(id) ?? freshSession(id),
    put: async (id: string, st: SessionState): Promise<void> => { states.set(id, st) },
  }) as never
  const ctx = {
    get: (name: string): unknown => name === 'agents' ? { get: () => ({ agent: { session } }) } : undefined,
    logger: { warn: () => {}, info: () => {} },
  }
  const listener = wireSubagentAutoSave(ctx as never, store, { presetId: 'chapters', ...CONFIG } as never)
  listener({ id: 'grand-1' })
  await drain()
  const st = states.get('grand-1')
  assert.ok((st?.chapters.length ?? 0) >= 1, 'grandchild archived')
  assert.equal(st?.rootSession, 'grand-1', 'own tree at depth 2 as well')
  const md = fs.readFileSync(path.join(w.tmp, st!.chapters[0]!.path), 'utf8')
  assert.match(md, /parentSession: "ch-parent"/, 'lineage from the header at depth 2')
})

test('warnings survive: door 5 logs the renderer-no-output warning instead of discarding it (#58)', async () => {
  // writeArchive already computes "N event(s) rendered no output"; door 5 used to return
  // {archived, skipped} and drop the array. That discarded string is why this ran for days.
  const warns: string[] = []
  const out = { archived: 1, skipped: null as string | null, warnings: ['x.md: 42 event(s) rendered no output (seqs 0, 1, 2)'] }
  const fmt = (o: typeof out): string[] => o.warnings.map((x) => `subagent auto-save: ${x}`)
  warns.push(...fmt(out))
  assert.match(warns.join('\n'), /rendered no output/, 'the warning text must reach the logger')
})

test('ONE BUILDER: /chapters-save on the same log archives byte-identically', async () => {
  // door 3 and door 5 must produce the same bytes for the same log — same subagentOf,
  // same events, same config; two worlds, compared on disk.
  const auto = makeWorld()
  auto.listener({ id: auto.childId })
  await drain()
  const autoRec = auto.states.get('child-1')!.chapters[0]!
  const autoMd = fs.readFileSync(path.join(auto.tmp, autoRec.path), 'utf8')

  const saveEvents = [...turnEvents(1, 'reading the paper'), ...turnEvents(2, 'summarizing findings')]
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'save-door-'))
  const states2 = new Map<string, SessionState>()
  const store2 = withMutate({
    get: async (id: string) => states2.get(id) ?? freshSession(id),
    put: async (id: string, s: SessionState) => { states2.set(id, s) },
  }) as never
  const caller = {
    id: 'child-1',
    options: {},
    session: {
      id: 'child-1',
      header: { cwd: tmp2, parentSession: 'parent-1', origin: 'subagent', agentPreset: 'chapters' },
      snapshotEvents: () => saveEvents,
    },
  }
  const ctx2 = {
    get: () => undefined,
    sessionProjections: { stateOf: (_s: unknown, k: string) => (k === 'agentPreset' ? 'chapters' : undefined) },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 65536 } }) },
    agents: { create: async () => ({ dispose: async () => {} }) },
    logger: { warn: () => {} },
  }
  const built = buildChaptersTools(ctx2 as never, store2 as never, { ...CONFIG } as never)
  const res = await built.saveCommand.handler({ agent: caller as never, rawInput: '' })
  assert.equal(res.kind, 'success')
  const saveRec = states2.get('child-1')!.chapters[0]!
  const saveMd = fs.readFileSync(path.join(tmp2, saveRec.path), 'utf8')
  assert.equal(autoMd, saveMd, 'identical logs archive to identical bytes through either door')
})
