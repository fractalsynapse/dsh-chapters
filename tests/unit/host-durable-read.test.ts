/**
 * Host-drift gate for the DURABLE READ seam (issue #58).
 *
 * Door 5 reads a settling child's log from disk when its live handle is gone — which, for a
 * *continuable* child, is always (see `host-subagent-seam.test.ts` F4). That arm was built on
 * `sessionQuery.listEvents`, and `listEvents` does not return events: it returns
 * `SessionEventRecord`, which is deliberately payload-less metadata. The renderer cannot tell —
 * `data` is optional on our own input type, so `ev.data ?? {}` turns a metadata row into a
 * structurally valid, semantically EMPTY chapter, and the archive commits.
 *
 * So this file pins the two things nothing else did:
 *   D1  the shape of each durable-read verb, read from the host's own published types and source
 *       (NOT reimplemented here — the host-seed-contract precedent: read the kernel's intent).
 *   D2  that OUR code reads through the payload-bearing verb, and that our input type makes a
 *       payload-less row impossible to pass.
 *
 * D1 rows are RUN/SKIP-named: an unresolvable host means unmeasured, never silently green.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const require_ = createRequire(import.meta.url)

/** Resolve one file from an installed host package, walking to the profile-global tree. */
function readHost(pkg: string, rel: string): { text: string } | { missing: string } {
  const candidates = [`${pkg}/${rel}`, path.join(process.env.HOME ?? '', 'node_modules', pkg, rel)]
  for (const p of candidates) {
    try {
      return { text: fs.readFileSync(require_.resolve(p), 'utf8') }
    } catch { /* next candidate */ }
  }
  return { missing: `${pkg}/${rel} not resolvable from this machine` }
}

const queryTypes = readHost('@deepseek-ai/dsh-session-query', 'lib/types/types.d.ts')
const queryImpl = readHost('@deepseek-ai/dsh-session-query', 'lib/index.js')
const sessionImpl = readHost('@deepseek-ai/dsh-session', 'lib/index.js')
const skip = (r: { text?: string; missing?: string }): string | false =>
  (r.text !== undefined ? false : `SKIP — ${r.missing}`)

const named = (r: { text?: string }, what: string): string =>
  `${r.text !== undefined ? 'RUN' : 'SKIP'} — ${what}`

// ---------------------------------------------------------------- D1: the host's shapes

test(named(queryTypes, 'listEvents returns SessionEventRecord, which has NO data field'), { skip: skip(queryTypes) }, () => {
  assert.ok(queryTypes.text !== undefined)
  const at = queryTypes.text.indexOf('interface SessionEventRecord')
  assert.ok(at >= 0, 'SessionEventRecord renamed — re-derive which verb is metadata before trusting any read')
  const body = queryTypes.text.slice(at, at + 700)
  const record = body.slice(0, body.indexOf('}') + 1)
  assert.doesNotMatch(record, /\bdata\b/,
    'the host put data back on SessionEventRecord: listEvents would become a viable archive input and this gate should be re-read, not deleted')
  assert.match(record, /seq:/, 'F: SessionEventRecord lost seq — our shape expectation needs re-deriving')
  assert.match(record, /type:/, 'F: SessionEventRecord lost type — same')
  assert.match(record, /surface:/, 'F: SessionEventRecord lost surface — same')
})

test(named(queryTypes, 'the host still calls listEvents a lightweight metadata list'), { skip: skip(queryTypes) }, () => {
  assert.ok(queryTypes.text !== undefined)
  // the doc comment is the fact a reader skipped in 2026-10-18; pinning the wording is
  // deliberate: if the host rewords it to promise payloads, our assumption is re-opened.
  assert.match(queryTypes.text, /List lightweight raw-log event records|Lightweight metadata for one event/,
    'the host stopped describing these records as lightweight — re-measure the verb before using it as an archive input')
})

test(named(queryImpl, 'readSession is the payload-bearing durable read'), { skip: skip(queryImpl) }, () => {
  assert.ok(queryImpl.text !== undefined)
  const at = queryImpl.text.indexOf('async readSession(sessionId)')
  assert.ok(at >= 0, 'readSession renamed — find the verb that returns whole events before door 5 has no durable arm at all')
  const body = queryImpl.text.slice(at, at + 600)
  assert.match(body, /events:\s*loaded\.events\.map\(snapshotSessionEvent\)/,
    'readSession no longer snapshot-clones full events — door 5 would be archiving something else')
  assert.match(body, /session:\s*structuredClone\(loaded\.header\)/,
    'readSession no longer returns the header — the gate (origin/agentPreset) would need a second call again')
})

test(named(queryImpl, 'listEvents is still built from analyzeEventLog records'), { skip: skip(queryImpl) }, () => {
  assert.ok(queryImpl.text !== undefined)
  const at = queryImpl.text.indexOf('async listEvents(sessionId)')
  assert.ok(at >= 0, 'listEvents renamed: re-check D1 — if it became payload-bearing, widen the type gate instead of leaving this row stale')
  assert.match(queryImpl.text.slice(at, at + 240), /eventRecords\(/, 'listEvents no longer routes through eventRecords')
  const builder = queryImpl.text.indexOf('function eventRecords')
  assert.ok(builder >= 0)
  assert.match(queryImpl.text.slice(builder, builder + 240), /analyzeEventLog\(sessionId, events\)\.records/,
    'eventRecords no longer returns analyzeEventLog().records — re-read its shape before using it')
})

test(named(sessionImpl, 'snapshotSessionEvent preserves the payload (structuredClone)'), { skip: skip(sessionImpl) }, () => {
  assert.ok(sessionImpl.text !== undefined)
  const at = sessionImpl.text.indexOf('function snapshotSessionEvent')
  assert.ok(at >= 0, 'snapshotSessionEvent renamed — D1 readSession row must be re-derived')
  assert.match(sessionImpl.text.slice(at, at + 400), /structuredClone\(event\)/,
    'the snapshot stopped cloning the full event, so readSession may no longer be payload-bearing')
})

// ---------------------------------------------------------------- D2: our side

test('our code reads the durable log through the payload-bearing verb, never listEvents', () => {
  const src = fs.readFileSync(new URL('../../src/auto-save.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /\bsq\.listEvents\s*\(|listEvents\(sessionId\)/,
    'door 5 reads listEvents again: that verb returns SessionEventRecord (no data) and produces a hollow chapter that commits silently (#58)')
  assert.match(src, /readSession/,
    'door 5 lost its durable read entirely — a disposed continuable child would then be skipped, not archived')
})

test('SessionEventLike makes a payload-less row impossible to pass', () => {
  const src = fs.readFileSync(new URL('../../src/types.ts', import.meta.url), 'utf8')
  const at = src.indexOf('interface SessionEventLike')
  assert.ok(at >= 0, 'SessionEventLike renamed — this gate has to follow it, not rot')
  const body = src.slice(at, src.indexOf('}', at))
  assert.doesNotMatch(body, /\bdata\?\s*:/,
    '`data` is optional again: that optionality is exactly what let a listEvents record type-check as an event (#58). Keep it required.')
  assert.match(body, /\bdata:\s*Record<string, unknown>/, 'data must be a required payload record')
})
