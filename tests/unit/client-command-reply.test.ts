// #590 rows: the command reply extraction, excerpt bounds, and host-card suppression.
// Event fixtures are the MAINTAINER'S LIVE LOG shapes (session-30472e9d, 2026-11-27T10:10-10:11):
// command/run {commandId,name,args}, command/done {commandId,kind,text} — one predicate per
// decision means these rows grade the same function the dock renders with.
import test from 'node:test'
import assert from 'node:assert/strict'
import { lastCommandReply, excerptOf, hostCardShowsReply, EXCERPT_CHARS } from '../../src/client/command-reply.ts'

const run = (seq: number, id: string, name: string, args: string) => ({ type: 'command/run', seq, time: 1, data: { commandId: id, name, args } })
const done = (seq: number, id: string, kind: string, text: string) => ({ type: 'command/done', seq, time: 2, data: { commandId: id, kind, text } })

test('#590: the newest exchange wins, paired by commandId — the live report byte-for-byte', () => {
  const events = [
    run(1, 'cmd-4c3bd485-1', 'chapters-prompt', ' status'),
    done(2, 'cmd-4c3bd485-1', 'success', 'suggested next step: ready'),
    run(3, 'cmd-4c3bd485-3', 'chapters-enrich', ' report'),
    done(4, 'cmd-4c3bd485-3', 'success', 'enrichment: manual, model qwen-token-plan/qwen3.8-flash · mining qwen-token-plan/qwen3.8-max (dedicated)\npending: 0 chapter(s)'),
  ]
  const r = lastCommandReply(events)
  assert.ok(r !== null)
  assert.equal(r.line, '/chapters-enrich report')
  assert.equal(r.kind, 'success')
  assert.match(r.text, /pending: 0 chapter\(s\)/)
  assert.equal(r.seq, 4)
})

test('#590: a run with no done is RUNNING — the answer to "did it hang?"', () => {
  const r = lastCommandReply([run(9, 'cmd-x-1', 'chapters-enrich', ' report')])
  assert.ok(r !== null)
  assert.equal(r.kind, 'running')
  assert.equal(r.line, '/chapters-enrich report')
})

test('#590: error kind survives; non-command events are transparent', () => {
  const events = [
    { type: 'assistant/message', seq: 1, time: 0, data: {} },
    run(2, 'c1', 'chapters-rule', ' model'),
    done(3, 'c1', 'error', 'no knowledge repository is linked'),
    { type: 'turn/end', seq: 4, time: 0, data: {} },
  ]
  const r = lastCommandReply(events)
  assert.ok(r !== null)
  assert.equal(r.kind, 'error')
  assert.match(r.text, /no knowledge repository/)
})

test('#590: a done whose run is absent still renders (line falls back, text is the truth)', () => {
  const r = lastCommandReply([done(5, 'ghost', 'success', 'orphan reply')])
  assert.ok(r !== null)
  assert.equal(r.line, '/command')
  assert.equal(r.text, 'orphan reply')
})

test('#590: excerpt bounds — flat, capped, ellipsis; full text untouched for expansion', () => {
  const long = `line one\n${'x'.repeat(400)}`
  const ex = excerptOf(long)
  assert.doesNotMatch(ex, /\n/, 'excerpts are single-line')
  assert.equal(ex.length, EXCERPT_CHARS + 1, 'cap plus ellipsis')
  assert.equal(excerptOf('short'), 'short')
})

test('#590: suppression — the host card already showing the reply hides the row; absence shows it', () => {
  const text = 'enrichment: manual, model qwen-token-plan/qwen3.8-flash · rule mining ON · pending: 0 chapter(s)'
  const ex = excerptOf(text)
  assert.equal(hostCardShowsReply(ex, { body: { innerText: `chat… ${text.slice(0, 80)} …rest` } }), true, 'host rendered it: no duplicate')
  assert.equal(hostCardShowsReply(ex, { body: { innerText: 'no cards here at all' } }), false, 'host hid it: the row is the fix')
  assert.equal(hostCardShowsReply('', undefined), false, 'running/empty never suppresses')
  assert.equal(hostCardShowsReply(ex, undefined), false, 'no document reads as not-shown: fail-visible')
})
