import { bootE2eServer, type Pins } from './boot.ts'
import { applyRigEnv, projectFromArgv } from './rig-pins.ts'
import path from 'node:path'

/**
 * One server per CONFIG LOAD (proven lifecycle: project setupFiles die with
 * worker restarts — measured 2026-09-19). The two suites run as two
 * invocations with env pins: E2E_PORT / E2E_THRESHOLD / E2E_FLOOR.
 */
export default async function setup(fullConfig?: {
  projects?: { env?: Record<string, string> }[]
}): Promise<() => Promise<void>> {
  // #56: `playwright.config.ts` per-project `env` is now the ONE authority for the regime — but
  // globalSetup runs BEFORE Playwright applies that env to workers, so the boot used to read
  // defaults (port 41731, threshold 0.75) while the spec's worker saw the pins: record and replay
  // booted DIFFERENT realms, and replay failed as tape MISSes that looked like prompt drift.
  // Adopt the selected project's env here, without overwriting anything a developer set on the
  // command line — an explicit E2E_THRESHOLD still wins, which is how a leg gets re-tuned.
  // `config.projects` is the UNFILTERED list and its entries do not carry `env`; the selection
  // lives in `filteredProjects` (measured: 11 projects vs the one `--project` asked for).
  // #56: the boot's pins come from the rig table, selected by the invocation's `--project`.
  // `config.projects` is unfiltered and its entries carry no `env`, so reading the CONFIG here
  // silently gave defaults (port 41731, threshold 0.75) while workers saw the pins — record and
  // replay ran different realms and replay failed as tape MISSes that looked like prompt drift.
  const selected = projectFromArgv((fullConfig as { argv?: string[] } | undefined)?.argv)
  applyRigEnv(selected)
  // #90: the proxy can already journal WHICH entry served each request, but nothing ever set
  // `E2E_TAPE_HITS`, so a replay that matched an entry and still stalled was unanswerable from disk —
  // an instrument left switched off at the factory. Set it for every invocation (record simply never
  // writes a HIT line); per-project filenames keep one leg from overwriting another's journal.
  if (!process.env.E2E_TAPE_HITS) {
    const hitName = String(selected ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
    process.env.E2E_TAPE_HITS = path.resolve(import.meta.dirname, '..', '..', 'var', `e2e-tape-hits-${hitName}.log`)
  }
  const port = Number(process.env.E2E_PORT ?? '41731')
  const pins: Pins = {
    thresholdRatio: process.env.E2E_THRESHOLD ?? '0.75',
    // Deterministic acceptance: no boot may depend on the model's auxiliary calls
    // happening or not happening. Set per project in the test:e2e chain.
    ...(process.env.E2E_NO_AUX_MODEL === '1' ? { noAuxModel: true } : {}),
  }
  // #90: assigned in BOTH states. The enrich/heavy legs opt in explicitly; every other leg opts OUT, so
  // the idle-triggered ladder can never race the tape. Measured cause: `suite` replay missed on a
  // 1-message annotation request that the record run never made inside its window — replay is served
  // from tape and finishes in seconds, so an idle debounce that expired after teardown at record fires
  // mid-leg at replay. Identical product behavior, different tape, and a miss that looks like a matcher
  // bug. Leaving it unset would let the realm default (ON) decide, which is exactly the nondeterminism.
  pins.enrichment = process.env.E2E_ENRICH === '1'
  // #71: the ghost journey boots WITH a defining model — the profile's local
  // fixture route, served in replay/record by the tape proxy (the scripted
  // upstream's `suggest` arm mints it on record). Absent ⇒ the config row is
  // absent ⇒ the feature does not exist on that boot (the OFF-state test).
  if (process.env.E2E_PROMPT === '1') pins.promptModel = 'local/qwen3.8-flash-next'
  const floor = process.env.E2E_FLOOR
  if (floor !== undefined) pins.toolResultArtifactTokens = floor
  const handle = await bootE2eServer(port, pins)
  return async () => { await handle.stop() }
}
