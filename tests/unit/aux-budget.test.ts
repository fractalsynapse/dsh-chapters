/**
 * One auxiliary completion budget, configured not hardcoded (#50, 2026-10-21).
 *
 * Measured on the token-plan route the plugin actually talks to: `max_tokens` is
 * NOT enforced there (a 64-token cap still produced 113 tokens with
 * `finish_reason: stop`), and usage itemizes
 * `completion_tokens_details.reasoning_tokens`. So the ceiling is advisory on this
 * provider and strictly load-bearing on any other — which is why it is a config key
 * with a number that covers reasoning (annotation + mining answers ran 1.1K–3.2K),
 * and why no call site is allowed to keep a literal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ENRICH_MAX_TOKENS_DEFAULT } from '../../src/enrich.ts'

test('the default covers reasoning tokens, not just the visible answer', () => {
  assert.equal(ENRICH_MAX_TOKENS_DEFAULT, 4000)
  // the measured worst case this round was 3,237 completion tokens on one chapter
  assert.ok(ENRICH_MAX_TOKENS_DEFAULT > 3237, 'a ceiling below the observed usage would truncate')
})

test('no auxiliary call site hardcodes a token budget anymore', () => {
  // the rule is "no hardcoded tunables"; these three literals (900/900/600) were the
  // whole spread of budgets the plugin was sending, with the mining output unaccounted
  for (const file of ['src/index.ts', 'src/engine.ts']) {
    const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    assert.ok(!/maxTokens:\s*900\b/.test(src), `${file} still hardcodes maxTokens: 900`)
    assert.ok(!/maxTokens:\s*600\b/.test(src), `${file} still hardcodes maxTokens: 600`)
    assert.ok(!/#auxComplete\([^)]*,\s*900\)/.test(src), `${file} still passes a literal to the aux completion`)
    assert.match(src, /enrichmentMaxTokens|ENRICH_MAX_TOKENS_DEFAULT/, `${file} must read the configured ceiling`)
  }
})

test('the ceiling is a config key on both planes, with one shared default', () => {
  const host = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8')
  assert.match(host, /enrichmentMaxTokens: Schema\.number\(\)\.default\(ENRICH_MAX_TOKENS_DEFAULT\)/,
    'host plane key exists and defaults from the shared constant')
  const realm = fs.readFileSync(path.join(process.cwd(), 'src/engine.ts'), 'utf8')
  assert.match(realm, /enrichmentMaxTokens: z\.number\(\)\.step\(1\)\.min\(400\)\.default\(ENRICH_MAX_TOKENS_DEFAULT\)/,
    'the realm row declares it too, so a preset can raise it per profile')
})
