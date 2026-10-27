/**
 * Session ids must be derived from the directory BASENAME, and children keep their prefix (#56).
 *
 * This is a regression I introduced today: `sessDirs()` was corrected to return absolute paths (it used to
 * return bare names, which every caller then resolved against the process cwd), and two consumers still did
 * `dir.startsWith('ch-')`. A full path never starts with `ch-`, so `sessIdsWithPrefix('ch-')` returned nothing
 * and `findSessionIdWhoseLogContains('## Active plan', 'ch-')` returned null — while the continuation child
 * existed on disk WITH the plan carried in its seed (verified by reading the log by hand). The plans leg then
 * failed its 240s poll for a child that was there the whole time: a false red about the product, produced by
 * the rig's own read.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { sessionIdFromDir } from '../../tests/e2e/session.ts'

test('a parent dir yields its uuid, a child keeps its prefix', () => {
  assert.equal(sessionIdFromDir('/tmp/home/sessions/--ws--/session-262bc719'), '262bc719')
  assert.equal(sessionIdFromDir('/tmp/home/sessions/--ws--/ch-016ebe73'), 'ch-016ebe73',
    'children are filtered BY prefix everywhere in the specs; stripping it makes them undiscoverable')
  assert.equal(sessionIdFromDir('/tmp/home/sessions/--ws--/sub-abcdef'), 'sub-abcdef')
})

test('no consumer compares a full path against a session prefix again', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../tests/e2e/session.ts'), 'utf8')
  assert.doesNotMatch(src, /dir\.startsWith\('ch-'\)/,
    'a path never starts with `ch-` — derive through sessionIdFromDir instead')
  assert.doesNotMatch(src, /d\.startsWith\('ch-'\)/,
    'same defect in the other consumer: map through the helper, not against the raw entry')
})

/**
 * Session identity comparison must tolerate the durable prefix (#56, measured under coverage).
 *
 * `prompt` aborted with `identity mismatch: dir claims session session-2ba8d72e…, spec targets 2ba8d72e…` —
 * the two strings are the SAME session, one spelled with the host's durable `session-` prefix and one without.
 * The guard I wrote to catch "the spec is watching another session" was instead firing on a spelling, so it
 * produced a false red for the very leg that exercises the bar.
 */
test('identity comparison ignores the durable session- prefix but not a different session', async () => {
  const { sameSessionId } = await import('../../tests/e2e/session.ts')
  assert.ok(sameSessionId('session-2ba8d72e-21dc-473d-ad84-739d21f5df82', '2ba8d72e-21dc-473d-ad84-739d21f5df82'),
    'the host writes the prefix into the log; the view does not carry it')
  assert.ok(sameSessionId('2ba8d72e-21dc-473d-ad84-739d21f5df82', 'session-2ba8d72e-21dc-473d-ad84-739d21f5df82'),
    'and the rule is symmetric')
  assert.ok(!sameSessionId('session-2ba8d72e-21dc-473d-ad84-739d21f5df82', 'ch-2ba8d72e-21dc-473d-ad84-739d21f5df82'),
    'a child id is a DIFFERENT session — the guard must still fire')
  assert.ok(!sameSessionId('session-aaaa', 'bbbb'), 'unrelated ids are never equal')
  assert.ok(!sameSessionId(null, 'bbbb'), 'a missing header is not a match (nor a mismatch to throw on)')
})
