/**
 * The tool wrappers' plan surface (docs/plans-carriage.md § 5): `chapters_segment`
 * reports the facts the model needs to place ranges around a decision — the
 * submissions, their verdicts, their sizes, and which of them CANNOT be archived
 * yet — without ever asking the model to author chapter text (invariant 4).
 *
 * Same L0 wrapper harness as tests/unit/tools-surface.test.ts: real tool defs,
 * fake agent, real registry domain over an in-memory table.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildChaptersTools } from '../../src/tools.ts'
import { makeDomainStore } from '../../src/store.ts'

type Ev = { seq: number; type: string; data: Record<string, unknown> }
const ev = (seq: number, type: string, data: Record<string, unknown> = {}): Ev => ({ seq, type, data })
const human = (seq: number, text: string): Ev =>
  ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
const asst = (seq: number, text: string): Ev =>
  ev(seq, 'assistant/message', { data: undefined, ...{ content: [{ type: 'text', text }], source: { kind: 'user' } } } as never)
const turnEnd = (seq: number): Ev => ev(seq, 'turn/end', {})
const planCall = (seq: number, plan: string, callId = `c${seq}`): Ev =>
  ev(seq, 'tool/call', { callId, name: 'exit_plan_mode', arguments: { plan } })
const verdict = (seq: number, callId: string, text: string, isError = false): Ev => ({
  seq, type: 'tool/result',
  data: {
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, isError, content: [{ type: 'text', text }] }],
    },
  },
}) as unknown as Ev

const PLAN = '# Carry the plan into chapters\n\n## Goal\nOne approved plan, one surviving continuation.\n'
const APPROVE = '{"approved":true} Plan approved — plan mode exited; carry out the plan starting with your next step.'

function world(events: Ev[]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-tools-'))
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => {
    let m = tables.get(name)
    if (m === undefined) { m = new Map(); tables.set(name, m) }
    return {
      get: (k: string) => m!.get(k),
      put: async (k: string, v: unknown) => { m!.set(k, v) },
      entries: () => m!.entries(),
      get size() { return m!.size },
    }
  }
  const store = makeDomainStore({ table, close: async () => {} } as never)
  const caller = {
    id: 'sess-plan',
    options: { provider: 'local', model: 'qwen-test' },
    session: { id: 'sess-plan', header: { cwd: tmp }, snapshotEvents: () => events },
  }
  const ctx = {
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 32000 } }) },
    agents: { get: () => ({ followup: (_m?: unknown) => {} }), create: async () => ({ followup: (_m?: unknown) => {}, dispose: async () => {} }) },
    get: () => undefined,
    sessionProjections: { stateOf: () => 'chapters' },
    logger: { info: () => undefined, warn: () => undefined },
  }
  const config = {
    artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
    continuationBudgetRatio: 0.25, fallbackPreset: 'chapters', mergeThreshold: 0.3, chapterLimit: 8000,
  }
  const built = buildChaptersTools(ctx as never, store, config as never)
  return { built, exec: { agent: caller }, tmp }
}

test('segment reports the plan and its verdict — facts, never text, never gauges (#330)', async () => {
  const { built, exec } = world([
    human(0, 'design the carriage feature'),
    ev(1, 'plan/mode', { active: true }),
    planCall(2, PLAN),
    verdict(3, 'c2', APPROVE),
    asst(4, 'approved'),
    turnEnd(5),
  ])
  const r = await built.segment.execute({} as never, exec as never) as Record<string, unknown>
  assert.equal(r.ok, true)
  assert.equal(r.modeActive, true, 'the folded log state, not a guess')
  const plans = r.plans as Array<Record<string, unknown>>
  assert.equal(plans.length, 1)
  assert.equal(plans[0]!.seq, 2)
  assert.equal(plans[0]!.status, 'approved')
  assert.equal(plans[0]!.resultSeq, 3)
  assert.equal(plans[0]!.title, 'Carry the plan into chapters')
  // #330: the plan row carries FACTS (seq/status/outline/verdict) — the size numbers
  // (bytes/estimatedTokens) left the model-visible payload with the rest of the gauges.
  assert.ok(!('bytes' in plans[0]!) && !('estimatedTokens' in plans[0]!), 'no size gauges on plan rows')
  assert.deepEqual(plans[0]!.outline, ['Goal'])
  assert.match(String(plans[0]!.verdict), /approved/i)
  assert.ok(Array.isArray(r.livePlans) && (r.livePlans as unknown[]).length === 0, 'nothing above the ceiling')
  assert.match(String(r.planHint), /topic boundary/, 'the hint explains what the facts are for')
})

test('a plan in an OPEN turn is reported as live and named as unarchivable (verify.md P6)', async () => {
  const { built, exec } = world([
    human(0, 'design it'), ev(1, 'plan/mode', { active: true }), planCall(2, PLAN), verdict(3, 'c2', APPROVE),
    turnEnd(4),
    human(5, 'now plan the rollback'),
    planCall(6, '# Rollback plan\n\n## Goal\nUndo safely.\n'),
  ])
  const r = await built.segment.execute({} as never, exec as never) as Record<string, unknown>
  assert.equal((r.plans as unknown[]).length, 1, 'the closed-turn plan is archivable')
  const live = r.livePlans as Array<Record<string, unknown>>
  assert.equal(live.length, 1)
  assert.equal(live[0]!.seq, 6)
  assert.equal(live[0]!.status, 'pending', 'no verdict exists yet — said, not implied')
  assert.equal(r.archiveCeiling, 4)
})

test('a plan-less session sees NO plan keys it would have to reason about (verify.md P8)', async () => {
  const { built, exec } = world([human(0, 'just talk'), asst(1, 'ok'), turnEnd(2)])
  const r = await built.segment.execute({} as never, exec as never) as Record<string, unknown>
  assert.deepEqual(r.plans, [])
  assert.deepEqual(r.livePlans, [])
  assert.equal(r.modeActive, null, 'unknown, never a lying false')
  assert.equal('planHint' in r, false, 'the hint appears only when there is a plan to place')
})

test('an unrelated tool call is not a plan, even when its arguments name one', async () => {
  const { built, exec } = world([
    ev(0, 'tool/call', { callId: 'b1', name: 'bash', arguments: { command: 'grep exit_plan_mode src' } }),
    turnEnd(1),
  ])
  const r = await built.segment.execute({} as never, exec as never) as Record<string, unknown>
  assert.deepEqual(r.plans, [])
})
