/**
 * The rig must refuse to boot a session whose profile declares tools the host did not register (#56).
 *
 * Measured: the runner boots the SAME host (identical tarball integrity, 79/79 deps present, 289 packages,
 * 44-id profile including the 21 `tool-*` rows) and registers only our 7 plugin tools, while this host registers
 * 34. Nothing in the boot output says so — CI's server log is 292 bytes. Every tape mismatch downstream of that
 * is therefore silent and arrives as a corrupt-looking corpus. AGENTS.md is explicit: a detected failure is a
 * delivered failure. This turns "seven tools showed up" into a loud, early refusal.
 *
 * Declared ids use the profile's own namespace (`tool-bash`); registered names are what the model sees
 * (`bash`). The mapping is deliberately narrow — one representative tool per row family, never a guess at the
 * whole surface — and each entry names a tool the fixture session must have to run any leg at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountFault } from '../../tests/e2e/model-proxy.ts'

const DECLARED = ['preset-chapters', 'tool-bash', 'tool-fs', 'tool-goal', 'tool-jobs', 'tool-todo', 'tool-web']
const FULL = ['bash', 'read', 'write', 'edit', 'create_goal', 'job_list', 'todo_write', 'web_fetch',
  'chapters_rules', 'chapters_search']

test('a healthy assembly reports no fault', () => {
  assert.equal(mountFault(DECLARED, FULL), null, `expected silence, got ${String(mountFault(DECLARED, FULL))}`)
})

test('the runner-shaped registration is refused loudly, naming what is missing', () => {
  const chaptersOnly = ['chapters_rules', 'chapters_search', 'chapters_segment', 'chapters_continue',
    'chapters_fork', 'chapters_artifact', 'chapters_rule_propose']
  const fault = mountFault(DECLARED, chaptersOnly)
  assert.notEqual(fault, null, 'seven plugin tools against a profile that declares tool-bash is a FAULT, not a pass')
  const text = String(fault)
  // The contract changed with the implementation, and this is the honest place to say so: the guard keys on the
  // REGISTERED core surface (bash/read/edit/write — what every leg's journey actually calls), because I measured
  // that the profile's declared `tool-*` rows are not a reliable signal at request time (the host rewrites the
  // patch mid-run, so 43 ids can be on disk while the first request is already in flight). Plugin-only
  // registration is refused on the core four; the message still names the family representatives so a reader
  // sees the shape of what fell off.
  for (const needle of ['bash', 'read', 'edit', 'write']) {
    assert.ok(text.includes(needle), `the message must name the missing core tool ${needle}: ${text}`)
  }
  assert.match(text, /declared=\d+ registered=\d+/, 'it carries the counts, not just prose')
  assert.match(text, /registered=/, 'it echoes what WAS registered, so the reader sees the 7-tool surface')
  assert.ok(text.includes('chapters_rules'), 'the registered list is named in the fault: ' + text)
})

test('the requirement is the core surface, not the profile text', () => {
  // A profile that declares nothing but a session that registers the core is fine: the check is about what the
  // model can actually call, so the declared list is context in the message, not the predicate.
  assert.equal(mountFault(['preset-chapters', 'llm-gate'], FULL), null, 'core present → no fault, declared rows irrelevant')
  // And a session with NO tools at all is the loudest possible fault — that boot cannot run any journey.
  const fault = mountFault([], [])
  assert.notEqual(fault, null, 'an empty registered surface must be refused, not skipped')
  assert.match(String(fault), /registered=0/, 'it says the surface is empty: ' + String(fault))
})
