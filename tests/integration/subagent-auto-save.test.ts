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
  const store = {
    get: async (id: string): Promise<SessionState> => states.get(id) ?? freshSession(id),
    put: async (id: string, s: SessionState): Promise<void> => { states.set(id, s) },
  } as never
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

  // the archive is SEARCHABLE through the local door — the whole point of #47
  const { entries, summaries } = buildLocalCorpus(path.join(w.tmp, '.dsh-chapters'))
  assert.ok(entries.length >= 1, 'corpus sees the child chapter')
  const hit = rankEntries(entries, summaries, [MARK.toLowerCase()], Date.now(), null, 0, 400)
  assert.ok(hit.total >= 1, 'the marker query finds the child chapter')

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

test('fallback arm: handle disposed before the async read → durable listEvents still archives', async () => {
  const w = makeWorld()
  const durable = w.events
  // simulate the race: the live handle is gone, but the durable store has the log
  const tmp = w.tmp
  const states = w.states
  const store = {
    get: async (id: string) => states.get(id) ?? freshSession(id),
    put: async (id: string, s: SessionState) => { states.set(id, s) },
  } as never
  const ctx = {
    get: (name: string): unknown => name === 'agents'
      ? { get: () => undefined }
      : name === 'sessionQuery'
        ? {
          listEvents: async () => durable,
          listSessions: async () => [{ header: { id: 'child-1', cwd: tmp, parentSession: 'parent-1', origin: 'subagent', agentPreset: 'chapters' } }],
        }
        : undefined,
    logger: { warn: () => {} },
  }
  const listener = wireSubagentAutoSave(ctx as never, store, { presetId: 'chapters', ...CONFIG } as never)
  listener({ id: 'child-1' })
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(states.get('child-1') !== undefined, 'the durable arm saved the knowledge')
  assert.ok(states.get('child-1')!.chapters.length >= 1)
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
  const store2 = {
    get: async (id: string) => states2.get(id) ?? freshSession(id),
    put: async (id: string, s: SessionState) => { states2.set(id, s) },
  } as never
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
