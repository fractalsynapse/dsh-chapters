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
import { execSync } from 'node:child_process'

/** @param {{workflow_runs?: Array<{event?: string, status?: string, conclusion?: string, updated_at?: string}>}} payload */
export function assessLiveness (payload, nowMs, maxAgeHours = 30) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : []
  // #491: ALIVE means the pipeline RAN and its REPORT stage produced. Cell failures are
  // version truths (the supported range includes broken host prereleases — named, correct,
  // permanent until the host fixes them); requiring conclusion==success would have the
  // sentinel scream forever at a fleet that is working perfectly. The failure mode this
  // fixes: an alarm that fires on truth trains everyone to ignore the alarm for the LIE —
  // a schedule that genuinely died.
  const healthy = (r) => r.status !== undefined && r.status !== 'completed'
    ? false
    : (r.reportJobOk === true || (r.reportJobOk === undefined && r.conclusion === 'success'))
  const candidates = runs.filter(healthy)
  if (candidates.length === 0) {
    const everRan = runs.some((r) => r.status === 'completed' || (r.conclusion && r.conclusion !== '-'))
    return {
      ok: false,
      reason: everRan
        ? 'no completed run produced its report stage — the sweep itself dies before assembling (or the report step is broken); check the newest run\'s assemble job'
        : 'no host-matrix run exists at all — the nightly has never executed (default-branch registration? disabled schedule?)',
    }
  }
  const newest = candidates
    .map((r) => Date.parse(String(r.updated_at ?? '')))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0]
  if (newest === undefined) return { ok: false, reason: 'healthy runs carry no readable timestamps' }
  const ageH = (nowMs - newest) / 3.6e6
  if (ageH > maxAgeHours) {
    const scheduled = candidates.filter((r) => r.event === 'schedule').length
    return {
      ok: false,
      reason: `last healthy sweep is ${String(Math.round(ageH))}h old (ceiling ${String(maxAgeHours)}h) — `
        + (scheduled === 0 ? 'and none of those ever came from a schedule event: cron never fired (registration? disabled workflow?)' : 'the most recent scheduled run never produced a report'),
    }
  }
  return { ok: true, reason: `last healthy sweep ${String(Math.round(ageH))}h ago (report stage produced; cell reds are version truths, not system deaths)` }
}

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
if (process.argv[1] !== undefined && process.argv[1].endsWith('nightly-liveness.mjs')) {
  const runsPath = arg('runs')
  if (runsPath === undefined || !fs.existsSync(runsPath)) {
    console.error('usage: node scripts/nightly-liveness.mjs --runs=<gh api workflow-runs json> [--no-enrich]')
    process.exit(2)
  }
  const payload = JSON.parse(fs.readFileSync(runsPath, 'utf8'))
  // #491: enrich each completed run with whether its REPORT stage produced.
  // Enrichment failure falls back to the conclusion-heuristic — never to a false ALIVE.
  if (arg('no-enrich') === undefined && Array.isArray(payload.workflow_runs)) {
    for (const r of payload.workflow_runs.slice(0, 10)) {
      try {
        const jobs = JSON.parse(execSync(`gh api repos/${process.env.GITHUB_REPOSITORY ?? ''}/actions/runs/${r.id}/jobs?per_page=50`, { encoding: 'utf8', timeout: 30_000 }))
        r.reportJobOk = (jobs.jobs ?? []).some((j) => String(j.name).startsWith('assemble') && j.conclusion === 'success')
      } catch { /* gh absent/unauthed (pure-function tests) — conclusion heuristic stands */ }
    }
  }
  const verdict = assessLiveness(payload, Date.now(), Number(arg('maxAgeHours') ?? '30'))
  console.log(`nightly-liveness: ${verdict.ok ? 'ALIVE' : 'DEAD'} — ${verdict.reason}`)
  process.exit(verdict.ok ? 0 : 1)
}
