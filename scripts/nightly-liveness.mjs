#!/usr/bin/env node
/**
 * #455 — the nightly-liveness sentinel.
 *
 * GitHub silently never schedules a workflow that is not on the default branch, and a
 * disabled/failing nightly is otherwise invisible until someone re-reads a README stamp
 * and squints. This sentinel runs INSIDE the CI workflow (which IS registered), asks the
 * Actions API for the host-matrix workflow's actual runs, and goes red when no SUCCESSFUL
 * sweep is younger than the ceiling — turning "the nightly is dead" from a discovered
 * mystery into yesterday's red check.
 *
 * The judgment is a pure function; the CLI just wires it to a JSON payload
 * (`gh api .../actions/workflows/host-matrix.yml/runs > runs.json`).
 */
import fs from 'node:fs'

/** @param {{workflow_runs?: Array<{event?: string, status?: string, conclusion?: string, updated_at?: string}>}} payload */
export function assessLiveness (payload, nowMs, maxAgeHours = 30) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : []
  const successes = runs.filter((r) => r.conclusion === 'success')
  if (successes.length === 0) return { ok: false, reason: 'no successful host-matrix run exists at all — the nightly has never completed' }
  const newest = successes
    .map((r) => Date.parse(String(r.updated_at ?? '')))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0]
  if (newest === undefined) return { ok: false, reason: 'successful runs carry no readable timestamps' }
  const ageH = (nowMs - newest) / 3.6e6
  if (ageH > maxAgeHours) {
    const scheduled = successes.filter((r) => r.event === 'schedule').length
    return {
      ok: false,
      reason: `last successful sweep is ${String(Math.round(ageH))}h old (ceiling ${String(maxAgeHours)}h) — `
        + (scheduled === 0
          ? 'and NO success ever came from a schedule event: the nightly never fired (default-branch registration? disabled workflow?)'
          : 'the most recent scheduled run failed or never completed'),
    }
  }
  return { ok: true, reason: `last successful sweep ${String(Math.round(ageH))}h ago` }
}

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
if (process.argv[1] !== undefined && process.argv[1].endsWith('nightly-liveness.mjs')) {
  const runsPath = arg('runs')
  if (runsPath === undefined || !fs.existsSync(runsPath)) {
    console.error('usage: node scripts/nightly-liveness.mjs --runs=<gh api workflow-runs json>')
    process.exit(2)
  }
  const verdict = assessLiveness(JSON.parse(fs.readFileSync(runsPath, 'utf8')), Date.now(), Number(arg('maxAgeHours') ?? '30'))
  console.log(`nightly-liveness: ${verdict.ok ? 'ALIVE' : 'DEAD'} — ${verdict.reason}`)
  process.exit(verdict.ok ? 0 : 1)
}
