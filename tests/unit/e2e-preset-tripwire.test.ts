/**
 * The preset tripwire (#56/#77) — the assertion that would have found tonight's bug in seconds.
 *
 * Nine red legs, three diagnosis agents, and roughly an evening of artifact archaeology, all
 * because a profile pin named a row id the host no longer mounts and nothing in the rig ever
 * asked what preset a session actually composed with. The rows here make that a five-second,
 * one-sentence failure at session creation, before any journey polls anything.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { agentPresetFromLog, presetMismatchMessage } from '../../tests/e2e/session.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

test('a real v4 header line yields the preset it names', () => {
  const header = JSON.stringify({ type: 'session', version: 4, id: 'session-x', cwd: '/w', isSeeded: false, delegationDepth: 0, agentPreset: 'chapters' })
  assert.equal(agentPresetFromLog(`${header}\n{"type":"user/message"}\n`), 'chapters')
})

test('the tonight shape — standard — is reported as standard, not swallowed', () => {
  const header = JSON.stringify({ type: 'session', version: 4, id: 'session-y', cwd: '/w', agentPreset: 'standard' })
  assert.equal(agentPresetFromLog(header + '\n'), 'standard')
  const msg = presetMismatchMessage('session-y', agentPresetFromLog(header + '\n'), 'chapters')
  assert.match(msg, /agentPreset="standard", not "chapters"/)
  assert.match(msg, /agent-preset-registry/, 'and it names the row id that has to be pinned')
  assert.match(msg, /selectedDefault: chapters/, 'with the key that actually selects it')
  assert.match(msg, /rig-preset-pin\.ts/, 'pointing at the mechanism, not at vibes')
})

test('a header without the field, or no header at all, is null — an unknown, never a guess', () => {
  assert.equal(agentPresetFromLog(JSON.stringify({ type: 'session', version: 4, id: 'z' })), null)
  assert.equal(agentPresetFromLog(''), null)
  assert.equal(agentPresetFromLog('not json\nstill not json\n'), null)
  assert.equal(agentPresetFromLog('{"type":"user/message"}\n{"type":"session","agentPreset":"chapters"}'), 'chapters',
    'the header need not be line 1, but the scan stays bounded to the head of the log')
})

test('newSessionWithTurn asserts the preset before returning — every journey inherits the precondition', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'session.ts'), 'utf8')
  const body = /export async function newSessionWithTurn[\s\S]*?\n}/.exec(src)?.[0] ?? ''
  assert.match(body, /assertChaptersPreset\(sid\)/, 'the call must be in the creation path, not in one spec')
  assert.ok(body.indexOf('assertChaptersPreset(sid)') > body.indexOf('return sid') - 200,
    'and it runs on the way out, after the durable log exists')
})
