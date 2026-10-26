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
            maxTokens: 131072
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

test('the patch COPIES the live provider block and edits only the regime — inventing keys was the bug', () => {
  const route = routeFromProfile(PROFILE)
  assert.ok(route)
  const patch = harnessProviderPatch(route, 32000)
  // The old synthesized shape added `api: openai-completions` and dropped the models list. The live profile
  // declares neither key because its endpoint is resolved by the host provider plugin; writing an `api:`
  // anyway gave the rig a provider that could not answer, which is the single cause behind the nine browser
  // legs that "failed" at missing doors, plan cards, and markers.
  assert.ok(!/^\s{8}api:/m.test(patch), 'no api: key unless the source has one')
  assert.ok(!/localhost:8080/.test(patch), 'and never the old local route smuggled back in')
  assert.match(patch, /contextWindow: 32000/, 'the stress regime is still pinned — that part is ours to edit')
  assert.match(patch, /maxTokens: 15000/, 'a declared maxTokens is pinned to the regime value')
  assert.match(patch, /contextWindow: \d+/, 'and the window is pinned, not dropped')
  assert.match(patch, /provider: qwen-token-plan\n {4}model: qwen3\.8-flash/)
  assert.ok(patch.includes(route.providerBlock.replace(/contextWindow: \d+/g, 'contextWindow: 32000').replace(/maxTokens: \d+/g, 'maxTokens: 15000')),
    'the provider block arrives byte-identical apart from the two regime numbers')
})

test('a source block that DOES carry api: and baseURL keeps them', () => {
  const withUrls = PROFILE.replace('        apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY',
    '        api: openai-completions\n        baseURL: http://example:9/v1\n        apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY')
  const route = routeFromProfile(withUrls)
  assert.ok(route)
  assert.equal(route.baseURL, 'http://example:9/v1')
  const patch = harnessProviderPatch(route, 32000)
  assert.match(patch, /api: openai-completions/, 'copying means copy — a real local-provider profile must survive intact')
  assert.match(patch, /baseURL: http:\/\/example:9\/v1/)
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
