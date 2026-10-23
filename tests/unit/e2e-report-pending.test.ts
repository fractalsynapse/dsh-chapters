/**
 * The durable half of the enrich report assertion (#56).
 *
 * The leg failed a DOM text poll while the command it was polling for had provably run: the
 * session log contained `…· last: enrichment batch: 1/1 chapter(s)\npending: 0 chapter(s)` as a
 * `command/done`. On 0.2.x the conversation surface virtualizes, so "not on screen" is not
 * "not recorded" — and a gate that cannot tell those apart stops being a gate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { commandResultSaysPending } from '../../tests/e2e/session.ts'

const done = (text: string): string => JSON.stringify({
  type: 'command/done', seq: 26, data: { commandId: 'c-1', kind: 'success', text },
})

test('a recorded report with a pending count satisfies the claim', () => {
  const log = [done('enrichment: manual · last: enrichment batch: 1/1 chapter(s)\npending: 0 chapter(s)')].join('\n')
  assert.equal(commandResultSaysPending(log), true)
})

test('other command results do not — the predicate is about the report, not any text', () => {
  assert.equal(commandResultSaysPending(done('prompt model: OFF (unset)')), false,
    'the ghost status chatter contains no pending count')
  assert.equal(commandResultSaysPending(done('enrichment: processed 1 chapter(s); 0 pending')), true,
    'the run verb reports the same fact in another shape, and both count')
  assert.equal(commandResultSaysPending(''), false, 'no log is not a pass')
  assert.equal(commandResultSaysPending(JSON.stringify({ type: 'user/message', data: { message: { content: 'pending: whatever the human typed' } } })), false,
    'a human message must not satisfy a claim about a command result')
  // the shape that actually failed in the field, with the newline JSON-escaped inside the string
  assert.equal(commandResultSaysPending(JSON.stringify({ type: 'command/done', data: { text: 'enrichment: manual\npending: 0 chapter(s)' } })), true,
    'a real report whose pending count arrives after an escaped newline must count')
})
