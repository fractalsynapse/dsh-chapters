/**
 * Plans in the continuation notice (docs/plans-carriage.md § 4/§ 5): the block is
 * composed from what the archive carries plus what the caller's live tail still
 * holds, it is MEASURED by the budget gate, and it contributes exactly zero bytes
 * to a session that never entered plan mode.
 *
 * Fakes only — no harness, no fs, no cordis (the same L0 seam as continue.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  archiveWatermark, archivedPlanRows, livePlanRows, preflight, refusalResult, runContinue, runFork,
  type ContinueConfig, type ContinuePorts,
} from '../../src/continue-core.ts'
import { freshSession, appendChapters } from '../../src/registry.ts'
import type { ChapterRecord } from '../../src/archive.ts'
import type { SessionEventLike } from '../../src/types.ts'
import type { SessionState } from '../../src/registry.ts'
import type { ArchiveFs } from '../../src/archive.ts'

const CONFIG: ContinueConfig = {
  artifactStoreRoot: '.dsh-chapters',
  chapterTokenTarget: 8000,
  toolResultDeferFloorTokens: 200,
  continuationBudgetRatio: 0.25,
  fallbackPreset: 'chapters',
  mergeThreshold: 0.3,
  chapterLimit: 8000,
}

const PLAN = '# Carry the plan\n\n## Goal\nSurvive a continuation.\n\n## Tests\nRun them.\n'
const APPROVE = '{"approved":true} Plan approved — plan mode exited; carry out the plan starting with your next step.'

const msg = (seq: number, role: 'user' | 'assistant', text: string): SessionEventLike => ({
  type: `${role}/message`, seq, time: 0, surfaceOp: 'append',
  data: { id: `m${seq}`, role, source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const turnEnd = (seq: number): SessionEventLike => ({ type: 'turn/end', seq, data: { turn: seq } })
const planCall = (seq: number, plan = PLAN, callId = `c${seq}`): SessionEventLike => ({
  type: 'tool/call', seq, data: { callId, name: 'exit_plan_mode', arguments: { plan } },
})
const verdict = (seq: number, callId: string, text = APPROVE, isError = false): SessionEventLike => ({
  type: 'tool/result', seq,
  data: {
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, isError, content: [{ type: 'text', text }] }],
    },
  },
})

/**
 * A session that planned, was approved, and closed the turn — plus an optional
 * OPEN tail (a second submission with no verdict) living above the ceiling.
 */
const session = (opts: { liveTailPlan?: boolean; modeFlip?: boolean; approvedExit?: boolean } = {}): SessionEventLike[] => {
  const evs: SessionEventLike[] = [
    msg(0, 'user', 'design the feature'),
    ...(opts.modeFlip !== false ? [{ type: 'plan/mode', seq: 1, data: { active: true } } as SessionEventLike] : []),
    planCall(2),
    verdict(3, 'c2'),
    msg(4, 'assistant', 'plan approved'),
    turnEnd(5),
    msg(6, 'user', 'now implement it'),
    msg(7, 'assistant', 'working'),
    turnEnd(8),
  ]
  if (opts.approvedExit) evs.push({ type: 'plan/mode', seq: 8.5, data: { active: false } } as SessionEventLike)
  if (opts.liveTailPlan) evs.push(planCall(9, '# Second plan\n\n## Goal\nMore.\n'))
  return evs
}

const RANGES = [{ title: 'Planning', summary: 'one chapter', startSeq: 0, endSeq: 8 }]

class FakeFs implements ArchiveFs {
  files = new Map<string, string>()
  async write(path: string, content: string) { this.files.set(path, content) }
  async read(path: string) { return this.files.get(path) }
  async exists(path: string) { return this.files.has(path) }
}

const harness = (opts: {
  events?: SessionEventLike[]
  states?: Record<string, SessionState>
  budget?: { windowTokens: number | null; headerBoundTokens: number | null }
} = {}) => {
  const fs = new FakeFs()
  const states = new Map(Object.entries(opts.states ?? {}))
  let idCount = 0
  const created: Array<{ sessionId: string; noticeEvent: SessionEventLike; modeEvents: SessionEventLike[] }> = []
  const ports: ContinuePorts = {
    readCallerEvents: async () => opts.events ?? session(),
    getState: async (id) => states.get(id) ?? freshSession(id),
    putState: async (id, s) => { states.set(id, s) },
    mutateState: async (id, fn) => { states.set(id, fn(states.get(id) ?? freshSession(id))) },
    fs: () => fs,
    budgetProbe: async () => opts.budget ?? { windowTokens: 131072, headerBoundTokens: 13000 },
    newId: () => `id-${++idCount}`,
    createChild: async (input) => { created.push(input) },
    now: () => 0,
  }
  const notice = () => {
    const ev = created[0]?.noticeEvent
    const sections = (ev?.data as { source?: { sections?: { text?: string }[] } })?.source?.sections
    return sections?.[0]?.text ?? ''
  }
  return { ports, fs, created, notice, states }
}

const continueWith = async (
  ports: ContinuePorts,
  config: ContinueConfig = CONFIG,
  events: SessionEventLike[] = session(),
) => await runContinue(ports, {
  callerSessionId: 'call-1', callerPreset: 'chapters', title: 'T',
  handoffNote: 'carry on', chapters: RANGES, toolResultOverrides: [],
}, config)

// ------------------------------------------------------------------ the block

test('an archived plan is called out in the child notice with its chapter and artifact', async () => {
  const h = harness()
  const result = await continueWith(h.ports)
  assert.ok(result.ok, result.reason)
  const text = h.notice()
  assert.match(text, /^## Active plan$/m)
  assert.match(text, /ACTIVE PLAN: "Carry the plan" — APPROVED/)
  assert.match(text, /ch\. 1 \.dsh-chapters\/call-1\/chapters\//, 'cited to its chapter, numbered like the chapter list')
  assert.match(text, /full text: \.dsh-chapters\/call-1\/artifacts\/[0-9a-f]{2}\/[0-9a-f]{64}\.txt/, 'a path the child can actually open')
  assert.match(text, /do NOT re-plan from recall/i)
})

test('the plan artifact file is really written, byte-for-byte, before the notice cites it', async () => {
  const h = harness()
  const result = await continueWith(h.ports)
  const fact = (result.chapters !== undefined ? h.states.get('call-1')?.chapters[0]?.plans?.[0] : undefined)
  assert.ok(fact, 'the chapter record carries the plan fact')
  const row = /full text: (\S+\.txt)/.exec(h.notice())?.[1]
  assert.ok(row)
  const stored = h.fs.files.get(row!)
  assert.equal(stored, PLAN.trim(), 'the cited path holds every byte of the plan')
  assert.equal(h.fs.files.size, [...h.fs.files.keys()].filter((k) => k.startsWith('.dsh-chapters/')).length)
})

test('a plan still in an open turn is carried as NOT ARCHIVED — and named as unapproved', async () => {
  const h = harness({ events: session({ liveTailPlan: true }) })
  const result = await continueWith(h.ports, CONFIG, session({ liveTailPlan: true }))
  assert.ok(result.ok, result.reason)
  const text = h.notice()
  assert.match(text, /ACTIVE PLAN: "Second plan" — PENDING/)
  assert.match(text, /NOT ARCHIVED — parent log seq 9 only/)
  assert.match(text, /do NOT implement it/i)
})

test('mode folded from the log: the child is told it starts outside plan mode', async () => {
  const h = harness()
  await continueWith(h.ports)
  assert.match(h.notice(), /Plan mode is ACTIVE in this session — the directive above is live/)
})

test('a session that never planned gets ZERO plan bytes in its notice (verify.md P8)', async () => {
  const plain = [msg(0, 'user', 'hi'), msg(1, 'assistant', 'yo'), turnEnd(2)]
  const h = harness({ events: plain })
  const result = await runContinue(h.ports, {
    callerSessionId: 'call-1', callerPreset: 'chapters', title: 'T', handoffNote: 'note',
    chapters: [{ title: 'Chat', summary: 's', startSeq: 0, endSeq: 2 }], toolResultOverrides: [],
  }, CONFIG)
  assert.ok(result.ok, result.reason)
  assert.ok(!h.notice().includes('## Active plan'), 'no header')
  assert.ok(!h.notice().includes('ACTIVE PLAN'), 'no call-out')
})

test('plansInNotice: false turns the block off entirely', async () => {
  const h = harness()
  await continueWith(h.ports, { ...CONFIG, plansInNotice: false })
  assert.ok(!h.notice().includes('## Active plan'), 'the knob is honest: zero bytes, not a stub')
})

test('chapters_fork carries the same plan facts — a sibling sees the decision too', async () => {
  const prior: ChapterRecord = {
    number: 1, path: '.dsh-chapters/root/chapters/001-plan.md', title: 'Planning', summary: 's',
    startSeq: 0, endSeq: 8, topics: [], sha256: 'x'.repeat(64), estimatedTokens: 10,
    artifacts: [{ path: '.dsh-chapters/root/artifacts/ab/abcdef.txt', sha256: 'a'.repeat(64), bytes: 100 }],
    plans: [{ seq: 2, status: 'approved', title: 'Carry the plan', sha256: 'a'.repeat(64), artifactPath: 'artifacts/ab/abcdef.txt', bytes: 100, estTokens: 25, resultSeq: 3 }],
    planMode: 'active',
  }
  const state = appendChapters(freshSession('call-1'), [prior])
  state.parentSession = 'root'
  const h = harness({ states: { 'call-1': state, root: freshSession('root') }, events: session() })
  const result = await runFork(h.ports, {
    callerSessionId: 'call-1', callerPreset: 'chapters', title: 'Branch', handoffNote: 'go',
  }, CONFIG)
  assert.ok(result.ok, result.reason)
  assert.match(h.notice(), /ACTIVE PLAN: "Carry the plan" — APPROVED/)
  assert.match(h.notice(), /full text: \.dsh-chapters\/root\/artifacts\/ab\/abcdef\.txt/, 'the record-qualified path, not the store-relative one')
})

// ------------------------------------------------------------------ measurement, never exemption

test('a continuation while plan mode is ACTIVE seeds the child with its own state event', async () => {
  const h = harness()
  const r = await continueWith(h.ports)
  assert.ok(r.ok, r.reason)
  const created = h.created[0]!
  assert.equal(created.modeEvents.length, 1, 'one synthetic mode event…')
  assert.deepEqual(
    { type: created.modeEvents[0]!.type, seq: created.modeEvents[0]!.seq, active: (created.modeEvents[0]!.data as { active: boolean }).active },
    { type: 'plan/mode', seq: 1, active: true },
    '…at seq 1, contiguous after the notice@0 (the shape the kernel was measured to accept)')
})

test('an APPROVED plan leaves plan mode, so nothing is seeded — the child implements', async () => {
  // Parent's log: mode on, plan, approval (which the host records as mode off) →
  // fold says inactive → no seed, and the notice never claims the gate is on.
  const events = session({ modeFlip: false, approvedExit: true })
  const h = harness({ events })
  const r = await continueWith(h.ports, CONFIG, events)
  assert.ok(r.ok, r.reason)
  assert.equal(h.created[0]!.modeEvents.length, 0, 'no seed for a session that already left plan mode')
})

test('a BRANCH never seeds plan mode, however active the parent was', async () => {
  const h = harness()
  const r = await runFork(h.ports, {
    callerSessionId: 'call-1', callerPreset: 'chapters', title: 'Branch', handoffNote: 'go', intent: 'branch',
  }, CONFIG)
  assert.ok(r.ok, r.reason)
  assert.equal(h.created[0]!.modeEvents.length, 0)
  assert.ok(!h.notice().includes('## Active plan'), 'and it gets no call-out either')
})

test('planSeedMode: false turns seeding off without touching the call-out', async () => {
  const h = harness()
  const r = await continueWith(h.ports, { ...CONFIG, planSeedMode: false })
  assert.ok(r.ok, r.reason)
  assert.equal(h.created[0]!.modeEvents.length, 0)
  assert.match(h.notice(), /ACTIVE PLAN:/, 'the directive still travels as text')
})

test('the plans block is COUNTED by the budget gate — no measurement exemption (verify.md P5)', async () => {
  // Measure both variants of the SAME archive, then set the allowance between them:
  // the plan-carrying continuation must REFUSE where the plan-less one fits. That is
  // only possible if the block's bytes are in the number the gate checks.
  const wide = harness()
  await continueWith(wide.ports)
  const withPlans = estimateTokensOf(wide.notice())
  const narrow = harness()
  await continueWith(narrow.ports, { ...CONFIG, plansInNotice: false })
  const withoutPlans = estimateTokensOf(narrow.notice())
  assert.ok(withPlans > withoutPlans, `the block adds bytes (${withoutPlans} → ${withPlans}) and is not cosmetic`)

  const remaining = 131072 - 13000
  const ratio = (withoutPlans + 2) / remaining
  let refusal = null
  try {
    await continueWith(harness({ budget: { windowTokens: 131072, headerBoundTokens: 13000 } }).ports, {
      ...CONFIG, continuationBudgetRatio: ratio,
    })
  } catch (error) {
    refusal = refusalResult(error)
  }
  assert.ok(refusal, 'refused, not clipped')
  assert.match(refusal.reason ?? '', /continuation over budget: notice ~\d+ tokens > allowance \d+/, 'refuse WITH the numbers')
  assert.equal(refusal.budget?.usedTokens, withPlans)
  assert.ok((refusal.budget?.allowanceTokens ?? 0) < withPlans)

  // Same gate, block off: the identical archive now passes.
  const passes = await continueWith(
    harness({ budget: { windowTokens: 131072, headerBoundTokens: 13000 } }).ports,
    { ...CONFIG, plansInNotice: false, continuationBudgetRatio: ratio },
  )
  assert.ok(passes.ok, passes.reason)
})

/** chars/4, the same estimate the gate itself uses. */
const estimateTokensOf = (text: string): number => Math.ceil(text.length / 4)

// ------------------------------------------------------------------ row builders

test('archivedPlanRows cites the display chapter number, not the registry number', () => {
  const record: ChapterRecord = {
    number: 7, path: 'root/chapters/007-x.md', title: 'X', summary: 's', startSeq: 0, endSeq: 1,
    topics: [], sha256: 'y'.repeat(64), estimatedTokens: 5, artifacts: [],
    plans: [{ seq: 3, status: 'rejected', title: 'Nope', sha256: 'z'.repeat(64), artifactPath: 'artifacts/zz/z.txt', bytes: 10, estTokens: 3, resultSeq: 4 }],
  }
  const rows = archivedPlanRows([record], [{ number: 2, path: 'root/chapters/007-x.md', title: 'X', summary: 's', status: 'ok' }])
  assert.equal(rows[0]!.chapterNumber, 2, 'display numbering of the TOC the child reads')
  assert.equal(rows[0]!.status, 'rejected')
  assert.equal(rows[0]!.artifactPath, 'artifacts/zz/z.txt', 'falls back to the fact path when the record lists no artifact match')
})

test('livePlanRows takes only what sits above the watermark', () => {
  const rows = livePlanRows(session({ liveTailPlan: true }), 8)
  assert.deepEqual(rows.map((r) => r.seq), [9])
  assert.equal(rows[0]!.status, 'pending')
})

test('the watermark is the highest archived seq (0 for an empty archive)', () => {
  assert.equal(archiveWatermark([]), 0)
  const r = (endSeq: number): ChapterRecord => ({
    number: 1, path: `p${endSeq}`, title: 't', summary: 's', startSeq: 0, endSeq, topics: [],
    sha256: 'q'.repeat(64), estimatedTokens: 1, artifacts: [],
  })
  assert.equal(archiveWatermark([r(3), r(11), r(7)]), 11)
})
