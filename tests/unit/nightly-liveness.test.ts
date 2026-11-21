/**
 * #455 — the liveness sentinel's judgment, unit-tested against fake Actions payloads.
 * Mutation-proven family: every state a dead nightly can produce must redden, and a
 * healthy one must not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessLiveness } from '../../scripts/nightly-liveness.mjs'

const NOW = Date.parse('2026-11-20T12:00:00Z')
const run = (over) => ({ event: 'schedule', status: 'completed', conclusion: 'success', updated_at: '2026-11-20T06:00:00Z', ...over })

test('#455: a fresh successful sweep is ALIVE', () => {
  const v = assessLiveness({ workflow_runs: [run({})] }, NOW)
  assert.equal(v.ok, true, v.reason)
})

test('#455: a 40h-old success is DEAD — named, with its hours', () => {
  const v = assessLiveness({ workflow_runs: [run({ updated_at: '2026-11-18T20:00:00Z' })] }, NOW)
  assert.equal(v.ok, false)
  assert.match(v.reason, /40h old \(ceiling 30h\)/)
})

test('#455: never-run is DEAD and says the schedule never fired', () => {
  const v = assessLiveness({ workflow_runs: [] }, NOW)
  assert.equal(v.ok, false)
  assert.match(v.reason, /never completed/)
})

test('#455: only-failures is DEAD — no success, however many runs', () => {
  const v = assessLiveness({ workflow_runs: [run({ conclusion: 'failure' }), run({ conclusion: 'cancelled' })] }, NOW)
  assert.equal(v.ok, false)
  assert.match(v.reason, /no successful host-matrix run/)
})

test('#455: successes that were never scheduled are called out — registration, not luck', () => {
  const v = assessLiveness({ workflow_runs: [run({ event: 'workflow_dispatch', updated_at: '2026-11-18T20:00:00Z' })] }, NOW)
  assert.equal(v.ok, false)
  assert.match(v.reason, /never fired/)
})
