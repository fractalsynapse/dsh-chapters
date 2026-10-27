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
  for (const needle of ['bash', 'read', 'create_goal', 'todo_write', 'web_fetch']) {
    assert.ok(text.includes(needle), `the message must name ${needle} so a reader knows which row went unregistered: ${text}`)
  }
  assert.match(text, /declared=\d+ registered=\d+/, 'it carries the counts, not just prose')
})

test('a profile that declares no tool rows is not held to a tool surface', () => {
  assert.equal(mountFault(['preset-chapters', 'llm-gate'], FULL), null, 'no declared tools → nothing to require')
  assert.equal(mountFault([], []), null, 'an empty profile and empty surface is not this check\'s business')
})
