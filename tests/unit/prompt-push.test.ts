/**
 * #194 rows: the push transport's pure core. The seams are probe-measured facts
 * (spikes/push-probe/FINDINGS.md); these rows keep the code honest to them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROMPT_RECORD_TYPE, PROMPT_PROJECTION_KEY, promptRecordPayload, foldPromptRecord,
  promptProjectionDefinition, resolvePushWriter,
} from '../../src/prompt-push.ts'

const facts = { status: 'ready' as const, text: 'ship it', turnSeq: 7, error: '', intent: 'worker-step' as const, goalRevision: null, autorun: 'disarmed' as const, at: 't1' }

test('the payload is versioned and carries the bar\'s durable facts verbatim', () => {
  const p = promptRecordPayload(facts)
  assert.equal(p.v, 1)
  assert.equal(p.status, 'ready')
  assert.equal(p.turnSeq, 7)
  assert.deepEqual({ ...p, v: undefined }, { ...facts, v: undefined })
})

test('the fold is last-wins for our records and blind to everything else', () => {
  const one = promptRecordPayload(facts)
  const two = promptRecordPayload({ ...facts, status: 'failed', error: 'boom', at: 't2' })
  assert.equal(foldPromptRecord(null, { type: PROMPT_RECORD_TYPE, data: one }), one)
  assert.equal(foldPromptRecord(one, { type: PROMPT_RECORD_TYPE, data: two }), two, 'a newer record replaces the whole state')
  assert.equal(foldPromptRecord(two, { type: 'turn/end', data: {} }), two, 'host events are not ours')
  assert.equal(foldPromptRecord(two, { type: PROMPT_RECORD_TYPE, data: { v: 2, status: 'ready' } }), two, 'a future version never folds into a lie')
  assert.equal(foldPromptRecord(two, null), two)
})

test('the projection definition is shaped like the host exemplar and folds through the same function', () => {
  const def = promptProjectionDefinition() as { key: string; init: () => unknown; apply: (s: unknown, e: unknown) => unknown; wire: { view: (s: unknown) => unknown }; stateVersion: number }
  assert.equal(def.key, PROMPT_PROJECTION_KEY)
  assert.equal(def.init(), null)
  const folded = def.apply(null, { type: PROMPT_RECORD_TYPE, data: promptRecordPayload(facts) })
  assert.deepEqual(folded, promptRecordPayload(facts))
  assert.equal(def.wire.view(folded), folded, 'the client sees the payload whole')
  assert.equal(def.stateVersion, 1)
})

test('resolvePushWriter: the host-anchored recipe, and every failure degrades to null — never a throw', async () => {
  const ok = await resolvePushWriter({
    anchor: '/host/bin/dsh',
    requireFn: () => ({ resolve: (spec) => { assert.equal(spec, '@deepseek-ai/dsh-session'); return '/host/node_modules/@deepseek-ai/dsh-session/lib/index.js' } }),
    importFn: async () => ({ appendPluginRecord: (session, type, data) => { assert.equal(type, PROMPT_RECORD_TYPE); return 42 } }),
  })
  assert.ok(ok !== null, 'a resolving host yields a writer')
  assert.equal(ok!.append({ id: 's' }, promptRecordPayload(facts)), true)

  const logs: string[] = []
  const absent = await resolvePushWriter({
    anchor: '/host/bin/dsh',
    requireFn: () => ({ resolve: () => '/old/dsh-session.js' }),
    importFn: async () => ({}),
    log: (m) => { logs.push(m) },
  })
  assert.equal(absent, null, 'a pre-0.2.1 host has no export — null, and the log says why')
  assert.match(logs[0]!, /absent/)

  const threw = await resolvePushWriter({ anchor: '/x', requireFn: () => { throw new Error('cannot resolve') } })
  assert.equal(threw, null, 'a resolution failure is a fallback, not a crash')

  const badAppend = await resolvePushWriter({
    anchor: '/host/bin/dsh',
    requireFn: () => ({ resolve: () => '/host/dsh-session.js' }),
    importFn: async () => ({ appendPluginRecord: () => { throw new Error('Receiver must be an instance of class Session') } }),
  })
  assert.ok(badAppend !== null)
  assert.equal(badAppend!.append({}, promptRecordPayload(facts)), false, 'a rejected append reports false; the row write already landed and the confirm-pull covers the gap')
})
