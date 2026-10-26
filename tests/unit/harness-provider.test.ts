/**
 * The harness-native rig route, as rows — because the last three times a routing decision lived only in boot
 * code, it silently pointed a leg at the wrong model and still reported green (#54 measured six of eight
 * projects SKIPPING because the probe asked port 8080 while distilling against a remote endpoint).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeRoute, harnessProviderPatch, readEnvFile, resolveKey, routeFromProfile } from '../../tests/e2e/harness-provider.ts'

const PROFILE = `- id: llm-pi-ai
  config:
    providers:
      qwen-token-plan:
        models:
          - id: qwen3.8-flash
            contextWindow: 196608
        apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY
- id: agent-default-model
  config:
    provider: qwen-token-plan
    model: qwen3.8-flash
`

test('the route is read from a real profile shape, and an unreadable one returns null', () => {
  const r = routeFromProfile(PROFILE)
  assert.ok(r)
  assert.equal(r.id, 'qwen-token-plan')
  assert.equal(r.model, 'qwen3.8-flash')
  assert.equal(r.apiKeyEnv, 'QWEN_TOKEN_PLAN_API_KEY')
  assert.equal(r.baseURL, undefined, 'our own profile names no baseURL — the host plugin resolves it')
  assert.equal(routeFromProfile('- id: something-else\n'), null, 'no default-model row is not a guess, it is a null')
  assert.equal(routeFromProfile(PROFILE.replace('apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY\n', '')), null,
    'a provider without an apiKeyEnv cannot be used by a throwaway home — refuse rather than assume a key')
})

test('the key resolves from the parent env first, then the untracked file, then NEVER a fallback', () => {
  const env = resolveKey({ QWEN_TOKEN_PLAN_API_KEY: 'abc123' }, null, 'QWEN_TOKEN_PLAN_API_KEY')
  assert.equal(env.source, 'env')
  assert.equal(env.key, 'abc123')

  const file = resolveKey({}, 'export QWEN_TOKEN_PLAN_API_KEY="xyz789"\nOTHER=1\n', 'QWEN_TOKEN_PLAN_API_KEY')
  assert.equal(file.source, 'file', 'the maintainer asked for the file path to work even when env is available')
  assert.equal(file.key, 'xyz789', 'quotes stripped, no shell ever executed')

  const none = resolveKey({}, null, 'QWEN_TOKEN_PLAN_API_KEY')
  assert.equal(none.key, null, 'NO substitution: not localhost, not a skip, not a silent local route')
  assert.match(none.remedy ?? '', /.dshdev-local\/e2e\.env/)
  assert.ok(!JSON.stringify(none).includes('xyz789'))
})

test('readEnvFile parses without executing anything (#54 class: never `source` a secret file)', () => {
  const parsed = readEnvFile('export A=1\nB = "two words"\n# comment\nC=x; rm -rf /\n')
  assert.equal(parsed.A, '1')
  assert.equal(parsed.B, 'two words')
  assert.equal(parsed.C, 'x; rm -rf /', 'values are data — a shell metacharacter must never run')
  assert.equal(parsed['comment'], undefined)
})

test('the profile block keeps the pinned stress window — the regime is the point', () => {
  const patch = harnessProviderPatch({ id: 'qwen-token-plan', model: 'qwen3.8-flash', apiKeyEnv: 'QWEN_TOKEN_PLAN_API_KEY' }, 32000)
  assert.match(patch, /contextWindow: 32000/, 'a hosted 196K window would swallow the 33K prompt and the overflow trigger would never fire')
  assert.match(patch, /apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY/)
  assert.match(patch, /provider: qwen-token-plan\n    model: qwen3\.8-flash/)
  assert.ok(!patch.includes('localhost:8080'), 'the harness-native route must not smuggle the old local block back in')
  assert.ok(!patch.includes('baseURL'), 'no baseURL is emitted when the profile has none — the host plugin resolves it')
})

test('the terminal line describes the route without ever printing the credential', () => {
  const line = describeRoute({ id: 'qwen-token-plan', model: 'qwen3.8-flash', apiKeyEnv: 'QWEN_TOKEN_PLAN_API_KEY' },
    { key: 'super-secret-value', source: 'env', remedy: null }, 'record')
  assert.ok(!line.includes('super-secret-value'), `the secret must not reach the log: ${line}`)
  assert.match(line, /\[provider\] qwen-token-plan\/qwen3\.8-flash/)
  assert.match(line, /18 chars from env/, 'length and source: enough to diagnose, nothing to leak')
  const missing = describeRoute({ id: 'p', model: 'm', apiKeyEnv: 'K' }, { key: null, source: null, remedy: 'r' }, 'live')
  assert.match(missing, /K: MISSING/, 'a missing key is stated on the line, not hidden behind a skip')
})
