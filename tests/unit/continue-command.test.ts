/**
 * `/chapters-continue` — the human-pulled DOOR for a continuation
 * (docs/plans-carriage.md § 15).
 *
 * Why this exists: a continuation child could previously be created only by the MODEL
 * calling `chapters_continue`, which means the browser plane could never cover the
 * continuation shape — and a tape that froze the model's own ranges broke on a second
 * machine (30 vs 29). `/chapters-fork` already proved the answer: derive the ranges in
 * the plugin, need no model, freeze no machine-specific number. Both doors now come from
 * ONE builder, so these rows also pin the thing that matters most — that they cannot
 * drift into two implementations of archive semantics.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { buildChaptersTools } from '../../src/tools.ts'
import { freshSession, type SessionState } from '../../src/registry.ts'
import type { SessionEventLike } from '../../src/types.ts'

const CONFIG = {
  artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
  continuationBudgetRatio: 0.25, fallbackPreset: 'chapters',
}

const PLAN = '# Carry the plan into children\n\n## Goal\nEvery continuation keeps the operative plan.\n\n## Tests\nCommand-level rows like these.\n'
const APPROVE = '{"approved":true} Plan approved — plan mode exited; carry out the plan starting with your next step.'

const msg = (seq: number, role: 'user' | 'assistant', text = `message ${seq} ${'filler words '.repeat(20)}`): SessionEventLike =>
  ({ type: `${role}/message`, seq, time: 0, surfaceOp: 'append', data: { id: `m${seq}`, role, source: { kind: 'user' }, content: [{ type: 'text', text }] } }) as SessionEventLike
const turnEnd = (seq: number): SessionEventLike => ({ type: 'turn/end', seq, data: { turn: seq } } as SessionEventLike)
const mode = (seq: number, active: boolean): SessionEventLike => ({ type: 'plan/mode', seq, data: { active } } as SessionEventLike)
// The callId has to MATCH on both sides: pairing a submission to its verdict is the
// product's job, and an earlier version of this fixture used `c${seq}` here and a
// hardcoded 'c2' below — so the verdict never paired and the product honestly reported
// PENDING. A fixture that silently mis-pairs is a test that proves the wrong thing.
const PLAN_CALL_ID = 'c4'
const planCall = (seq: number): SessionEventLike => ({ type: 'tool/call', seq, data: { callId: PLAN_CALL_ID, name: 'exit_plan_mode', arguments: { plan: PLAN } } } as SessionEventLike)
const verdict = (seq: number, text: string): SessionEventLike => ({
  type: 'tool/result', seq, data: { message: { source: { kind: 'tool', callId: PLAN_CALL_ID }, content: [{ type: 'tool-result', toolCallId: PLAN_CALL_ID, isError: false, content: [{ type: 'text', text }] }] } },
} as SessionEventLike)

/**
 * Two shapes, and the difference between them is the whole product question:
 *  - APPROVED: verdict logged, mode flipped off, plan sits BELOW the ceiling → archived.
 *  - PENDING:  review still open, mode still active, plan ABOVE the ceiling → the live
 *    and un-stored case, which is exactly when a child must be seeded and told to wait.
 */
const approvedSession = (): SessionEventLike[] => [
  msg(0, 'user'), msg(1, 'assistant'), turnEnd(2),
  mode(3, true), planCall(4), verdict(5, APPROVE), mode(6, false), msg(7, 'assistant'), turnEnd(8),
]
const pendingSession = (): SessionEventLike[] => [
  msg(0, 'user'), msg(1, 'assistant'), turnEnd(2),
  mode(3, true), planCall(4),
]

function world(events: SessionEventLike[]) {
  const tmp = path.join(os.tmpdir(), `chapters-cont-${Math.random().toString(36).slice(2)}`)
  const states = new Map<string, SessionState>()
  const created: Array<{ sessionId: string; seed: Array<Record<string, unknown>> & object; notice: string }> = []
  const ctx = {
    get: () => undefined,
    sessionProjections: { stateOf: (_s: unknown, key: string) => (key === 'agentPreset' ? 'chapters' : undefined) },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 65536 } }) },
    agents: {
      create: async (req: Record<string, unknown>) => {
        const seed = req.seed as Array<Record<string, unknown>>
        const notice = ((seed[0]?.data as Record<string, never>)?.content as Array<{ text?: string }>)?.[0]?.text ?? ''
        created.push({ sessionId: String(req.sessionId), seed: seed[0] ?? {}, notice })
        // record the full seed shape for the mode-event rows
        ;(created[created.length - 1] as { seedTypes: string[] }).seedTypes = seed.map((e) => String(e.type))
        return { dispose: async () => {} }
      },
    },
    logger: { warn: () => {} },
  }
  const store = {
    get: async (id: string) => states.get(id) ?? freshSession(id),
    put: async (id: string, s: SessionState) => { states.set(id, s) },
    mutate: async (id: string, fn: (s: SessionState) => SessionState) => { const n = fn(states.get(id) ?? freshSession(id)); states.set(id, n); return n },
  }
  const caller = { id: 'caller-1', options: { provider: 'local', model: 'm' }, session: { id: 'caller-1', header: { cwd: tmp }, snapshotEvents: () => events } }
  const built = buildChaptersTools(ctx as never, store as never, CONFIG as never)
  return { built, caller, states, created, tmp }
}

const run = (door: 'forkCommand' | 'continueCommand', w: ReturnType<typeof world>, rawInput = '') =>
  w.built[door].handler({ agent: w.caller as never, rawInput })

test('both deterministic doors are registered, and only the intent differs', () => {
  const w = world(approvedSession())
  assert.equal(w.built.forkCommand.name, 'chapters-fork')
  assert.equal(w.built.continueCommand.name, 'chapters-continue')
  assert.notEqual(w.built.continueCommand.description, w.built.forkCommand.description, 'a human reads the difference')
})

test('continue carries the directive; fork on the SAME session carries nothing (decision 3, human door)', async () => {
  const a = world(approvedSession())
  const r = await run('continueCommand', a, 'Keep going')
  assert.equal((r as { kind: string }).kind, 'success', JSON.stringify(r))
  const contNotice = a.created[0]!.notice
  assert.match(contNotice, /^## Active plan$/m, 'the continuation gets the directive section')
  assert.match(contNotice, /ACTIVE PLAN: "Carry the plan into children" — APPROVED/)
  assert.match(contNotice, /plan document: \.dsh-chapters/, 'and it cites the searchable plan document')
  assert.equal(contNotice.includes('## Finding things'), true, 'the retrieval verbs ride along (0.1.12)')

  const b = world(approvedSession())
  const r2 = await run('forkCommand', b, 'New direction')
  assert.equal((r2 as { kind: string }).kind, 'success')
  const branchNotice = b.created[0]!.notice
  assert.equal(branchNotice.includes('Active plan'), false, 'a branch gets zero directive bytes')
  assert.equal(branchNotice.includes('ACTIVE PLAN'), false)
})

test('NO machine-specific number is frozen: the two doors archive identically', async () => {
  const a = world(approvedSession()); const b = world(approvedSession())
  await run('continueCommand', a); await run('forkCommand', b)
  const ca = a.states.get('caller-1')!, cb = b.states.get('caller-1')!
  assert.deepEqual(ca.chapters.map((c) => [c.startSeq, c.endSeq, c.title]), cb.chapters.map((c) => [c.startSeq, c.endSeq, c.title]),
    'same events in ⇒ same ranges and titles — the archive is a function of the log, not of which door pulled it')
  assert.deepEqual(ca.chapters.map((c) => c.plans?.map((p) => `${p.seq}:${p.status}`)), cb.chapters.map((c) => c.plans?.map((p) => `${p.seq}:${p.status}`)),
    'and the plan facts recorded are the same')
})

test('a session still planning gets seeded through the human door — the live-and-un-stored case', async () => {
  const w = world(pendingSession())
  const r = await run('continueCommand', w, 'Hold the plan')
  assert.equal((r as { kind: string }).kind, 'success', JSON.stringify(r))
  const child = w.created[0]! as { seedTypes: string[]; notice: string }
  assert.deepEqual(child.seedTypes, ['user/message', 'plan/mode'], 'the child carries its OWN plan/mode fact (invariant 2 amendment)')
  assert.match(child.notice, /Plan mode is ACTIVE in this session/, 'and is told the directive is live, not history')
  assert.match(child.notice, /PENDING/, 'the unanswered plan is named as unanswered')
  // The plan sits ABOVE the ceiling (unfinished turn) ⇒ named as un-stored, never silently dropped.
  assert.match(child.notice, /NOT ARCHIVED|not archived|parent log seq/, 'live plan reported as un-stored: ' + child.notice.slice(child.notice.indexOf('Active plan'), child.notice.indexOf('Active plan') + 260))
})

test('the approved case is NOT seeded — approving exits plan mode (measured, not assumed)', async () => {
  const w = world(approvedSession())
  await run('continueCommand', w)
  const child = w.created[0]! as { seedTypes: string[] }
  assert.deepEqual(child.seedTypes, ['user/message'], 'one synthetic event: the child implements, it is not gated')
})

test('a plan-less session through the human door hands over prose, not a phantom directive', async () => {
  const plain = [msg(0, 'user'), msg(1, 'assistant'), turnEnd(2)]
  const w = world(plain)
  const r = await run('continueCommand', w)
  assert.equal((r as { kind: string }).kind, 'success')
  const notice = w.created[0]!.notice
  assert.equal(notice.includes('Active plan'), false, 'zero plan bytes when there is no plan')
  assert.match(notice, /ask the user what to carry on with|do NOT re-plan from recall/, 'and the handoff says what to do without a directive')
})

test('refusals name the door, so a red run cannot be attributed to the wrong command', async () => {
  const empty = [msg(0, 'user')] // no turn/end ⇒ nothing to archive
  const w = world(empty)
  const r = await run('continueCommand', w)
  assert.equal((r as { kind: string }).kind, 'error')
  assert.match((r as { text: string }).text, /^chapters-continue: /, JSON.stringify(r))
})
