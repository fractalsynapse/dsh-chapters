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
  assert.match(v.reason, /never executed|never completed/)
})

test('#455: only-failures is DEAD — no success, however many runs', () => {
  const v = assessLiveness({ workflow_runs: [run({ conclusion: 'failure' }), run({ conclusion: 'cancelled' })] }, NOW)
  assert.equal(v.ok, false)
  assert.match(v.reason, /never executed|no completed run produced|never produced its report/)
})

test('#455: successes that were never scheduled are called out — registration, not luck', () => {
  const v = assessLiveness({ workflow_runs: [run({ event: 'workflow_dispatch', updated_at: '2026-11-18T20:00:00Z' })] }, NOW)
  assert.equal(v.ok, false)
  assert.match(v.reason, /never fired/)
})

test('#491: honest-red ledger with a produced report is ALIVE — version truths are not system deaths', () => {
  const v = assessLiveness({ workflow_runs: [run({ conclusion: 'failure', reportJobOk: true })] }, NOW)
  assert.equal(v.ok, true, v.reason)
})

test('#491: a run that completed but whose report stage never produced is DEAD — the pipeline is broken even when cells run', () => {
  const v = assessLiveness({ workflow_runs: [run({ conclusion: 'failure', reportJobOk: false })] }, NOW)
  assert.equal(v.ok, false)
  assert.match(v.reason, /report/)
})

test('#491: stale-but-honest is still stale — the truth does not buy immunity from the ceiling', () => {
  const v = assessLiveness({ workflow_runs: [run({ conclusion: 'failure', reportJobOk: true, updated_at: '2026-11-18T20:00:00Z' })] }, NOW)
  assert.equal(v.ok, false)
  assert.match(v.reason, /h old \(ceiling 30h\)/)
})

// #511/#513: the CLI's own eyes — bare flags parse, and failed enrichment declares itself.
import { spawnSync } from 'node:child_process'
import fsTmp from 'node:fs'
import osTmp from 'node:os'
import pathTmp from 'node:path'
import urlTmp from 'node:url'

const scriptPath = urlTmp.fileURLToPath(new URL('../../scripts/nightly-liveness.mjs', import.meta.url))
const failOnlyPayload = () => {
  const dir = fsTmp.mkdtempSync(pathTmp.join(osTmp.tmpdir(), 'nl-'))
  const f = pathTmp.join(dir, 'runs.json')
  fsTmp.writeFileSync(f, JSON.stringify({
    workflow_runs: [{ id: 1, event: 'schedule', status: 'completed', conclusion: 'failure', updated_at: new Date().toISOString() }],
  }))
  return f
}

test('#513: with gh-failing enrichment the heuristic verdict still prints AND the blindness is named', () => {
  const f = failOnlyPayload()
  const r = spawnSync(process.execPath, [scriptPath, `--runs=${f}`], {
    encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' }, timeout: 60_000,
  })
  assert.match(r.stdout + r.stderr, /DEAD/, 'heuristic: no verified-successful run reads DEAD (never a false ALIVE)')
  assert.match(r.stderr, /job lookups failed/, 'but the run says it could NOT verify the report stage (#513)')
}, 90_000)

test('#511: the BARE --no-enrich flag the usage documents actually disables enrichment', () => {
  const f = failOnlyPayload()
  const r = spawnSync(process.execPath, [scriptPath, `--runs=${f}`, '--no-enrich'], {
    encoding: 'utf8', timeout: 60_000,
  })
  assert.match(r.stdout + r.stderr, /DEAD/)
  assert.ok(!r.stderr.includes('job lookups failed'), 'no enrichment attempted ⇒ no blindness note — the flag was honored')
}, 90_000)
