/**
 * The fixture provider row must ALWAYS carry `retryPolicy`, with a per-leg count — never an omitted block (#56).
 *
 * Measured today: making retries a per-leg opt-in by DROPPING the block broke boot readiness outright —
 * `LEG=fork MODE=replay E2E_HOST_RETRIES=1` died with `e2e boot failed within 120070ms waited`, the host's log
 * a single plugin line and no URL, while the same leg boots in ~21s without the variable. The generated YAML
 * parses fine either way, so this is not syntax: the host needs the field present, and a rig that removes a
 * required field to express a regime difference produces exactly the failure I then spent a round blaming on
 * heavy's tape.
 *
 * The regime is a NUMBER on a block that is always there.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { RIG_PINS, rigEnv } from '../../tests/e2e/rig-pins.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

test('every leg keeps the retryPolicy block and states its own count', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'boot.ts'), 'utf8')
  assert.match(src, /retryPolicy:\\n\s*mode: normal\\n\s*maxRetries: \$\{/,
    'maxRetries must be an interpolated value inside a block that is always emitted')
  assert.doesNotMatch(src, /E2E_HOST_RETRIES === '1' \? '' :/,
    'no branch may DELETE retryPolicy to express a regime — a required field is not a toggle')
})

test('heavy opts into host retries by count, and the rest stay deterministic at zero', () => {
  assert.equal(RIG_PINS.heavy.maxRetries, 3, 'heavy needs the host to re-issue a refused request')
  assert.equal(rigEnv('heavy', RIG_PINS.heavy).E2E_MAX_RETRIES, '3', 'the pin derives the env the boot reads')
  for (const leg of ['suite', 'arrival', 'fork', 'rules'] as const) {
    assert.equal(RIG_PINS[leg].maxRetries, undefined, `${leg} declares no opt-in`)
    assert.equal(rigEnv(leg, RIG_PINS[leg]).E2E_MAX_RETRIES, undefined, `${leg} emits no count`)
  }
  assert.equal(rigEnv('heavy', RIG_PINS.heavy).E2E_HOST_RETRIES, undefined,
    'the boolean knob is gone: a number on a present block is the only expression of this regime')
})
