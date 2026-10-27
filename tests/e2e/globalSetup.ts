import { bootE2eServer, rigStoreRoot, ROOT, type Pins } from './boot.ts'
import { applyRigEnv, projectFromArgv } from './rig-pins.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { routeFromProfile } from './harness-provider.ts'

/**
 * The preset row that makes the Suggested Next Step bar exist.
 *
 * It was hard-coded to `local/qwen3.8-flash-next` — the tracked seed's fixture route — which is correct
 * right up until the rig boots on the maintainer's real provider, where that route does not exist and the
 * bar silently never renders: a leg that fails because its own switch pointed at a model the boot cannot
 * resolve looks exactly like a leg that fails because the feature is broken. Resolved from the boot's route
 * instead, so the row can only ever name something the host actually has.
 */
function promptModelForBoot(): string {
  // Which model the Suggested Next Step bar may ask, per MODE — and the two answers differ, which is the point.
  //
  // In record/replay/heal the auxiliary call goes through the rig's TAPE PROXY, and the proxy is the only thing
  // that speaks `openai-completions` here: the host's own LLM service answers `no adapter registered for provider
  // "qwen-token-plan"` when asked to route that provider directly (measured via the bar's own error path, which is
  // the reason `hostStreamFailure` exists). So the row names the proxy's route — `local/<fixture>` — and the proxy
  // translates it to the ambient provider's real model (E2E_UPSTREAM_MODEL, derived in boot.ts from the live
  // profile). The model that answers is still the maintainer's; the ROUTE the plugin may name is the proxy's.
  //
  // In `live` there is no proxy: the plugin must name the provider route itself, so the ambient route is correct
  // there and only there.
  const override = process.env.E2E_PROMPT_MODEL
  if (override !== undefined && override !== '') return override
  if ((process.env.E2E_MODEL ?? 'replay') === 'live') {
    const candidates = [process.env.E2E_AMBIENT_PROFILE,
      path.join(os.homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')].filter((c): c is string => c !== undefined && c !== '')
    for (const profile of candidates) {
      let route = null
      try { route = routeFromProfile(fs.readFileSync(profile, 'utf8')) } catch { continue }
      if (route !== null) {
        console.log(`[e2e] live leg: bar route = ${route.id}/${route.model} (from ${profile})`)
        return `${route.id}/${route.model}`
      }
    }
    console.warn('[e2e] live leg found no ambient provider route; falling back to the fixture route')
  }
  console.log('[e2e] bar route = local/qwen3.8-flash-next — the tape proxy translates this to the ambient '
    + "provider's real model, because the host LLM service has no adapter for that provider directly")
  return 'local/qwen3.8-flash-next'
}
import { installRigFaultGuard, RIG_FAULT_PATTERN, REPLAY_MISS_PATTERN } from './rig-fault.ts'

/** Is this invocation replay (strict) rather than record/heal? The mode is decided by the runner, not guessed. */
function modeIsReplay(): boolean {
  return (process.env.E2E_MODEL ?? '') === 'replay' && process.env.E2E_TAPE_FALLBACK !== '1'
}

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
  if (process.env.E2E_PROMPT === '1') pins.promptModel = promptModelForBoot()
  const floor = process.env.E2E_FLOOR
  if (floor !== undefined) pins.toolResultArtifactTokens = floor
  // #108: watch the miss journal for a RIG fault and stop the leg outright. The pins already answer 503 in
  // milliseconds, but a refused request leaves the browser waiting for UI that cannot render — measured on CI
  // run 40151570099 at 22+ minutes with the pins firing. Exiting here is the difference between "proxy fast"
  // and "run fast": the diagnosis lands in the log, the remaining specs do not burn their timeouts, and no
  // one reads a locator failure as a product bug.
  // The SAME root the boot uses for `journalPath` (boot.ts:315) — importing ROOT instead of recomputing it is
  // the difference between watching the journal the proxy writes and watching a path that exists nowhere.
  const journal = path.join(ROOT, 'var', 'e2e-tape-misses.log')
  // Late-bound: the guard is installed BEFORE the boot so a stale fault cannot slip a leg past it, yet it
  // must stop a server that does not exist at install time. `bootStop` fills in the instant the boot
  // returns — and is AWAITED, because an abort that leaves the host on the leg's port makes the next leg
  // die of "port already in use": a rig fault must never manufacture a flake (#108).
  let bootStop: (() => Promise<void>) | null = null
  const guard = installRigFaultGuard({
    journal,
    getStopBoot: () => bootStop,
    exit: (code) => { process.exit(code) },
    // In replay a miss means the journey left the recording, so it is fatal for THIS leg — the tape was
    // supposed to answer everything. In record and heal a miss is the mechanism working (forward live, append),
    // so the pattern is added only for replay, and `heavy` can never again pass the chain with two misses in
    // the journal the way it did on 2026-10-26.
    // `E2E_MISS_FATAL=0` is a DIAGNOSTIC switch only: the guard's default stays fatal in replay, because a leg
  // that passes while its tape missed requests is the false green this rig was built to refuse. It exists so a
  // run can reach the SECOND miss and dump it — without it, the abort kills the process before the request
  // that actually matters is written out, and I cannot read bytes I never captured.
  ...(modeIsReplay() && process.env.E2E_MISS_FATAL !== '0' ? { pattern: new RegExp(`${RIG_FAULT_PATTERN.source}|${REPLAY_MISS_PATTERN.source}`) } : {}),
    log: (m) => { console.error(`\n${m}\n  journal: ${journal}`) },
  })

  const handle = await bootE2eServer(port, pins)
  bootStop = async () => { await handle.stop() }
  return async () => {
    guard()
    // Deliver the evidence BEFORE the home is deleted. The plugin writes its own diagnostics to
    // `<store-root>/diagnostics.log` (#61) and the store root is per-port inside the throwaway home, so every
    // leg has been destroying the only record of what its boot actually said — which is precisely the failure
    // this repo calls "a detected failure that was thrown away", now aimed at my own rig. Copied, not moved:
    // the boot still owns its file, and `var/` keeps the transcript.
    try {
      const src = path.join(rigStoreRoot(port), 'diagnostics.log')
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(ROOT, 'var', `e2e-diagnostics-${String(port)}.log`))
        console.log(`[e2e] diagnostics delivered → var/e2e-diagnostics-${String(port)}.log`)
      }
    } catch (error) {
      console.warn(`[e2e] could not deliver diagnostics: ${String((error as Error)?.message ?? error)}`)
    }
    await handle.stop()
  }
}
