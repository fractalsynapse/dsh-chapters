import { bootE2eServer, type Pins } from './boot.ts'

/**
 * One server per CONFIG LOAD (proven lifecycle: project setupFiles die with
 * worker restarts — measured 2026-09-19). The two suites run as two
 * invocations with env pins: E2E_PORT / E2E_THRESHOLD / E2E_FLOOR.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const port = Number(process.env.E2E_PORT ?? '41731')
  const pins: Pins = {
    thresholdRatio: process.env.E2E_THRESHOLD ?? '0.75',
    // Deterministic acceptance: no boot may depend on the model's auxiliary calls
    // happening or not happening. Set per project in the test:e2e chain.
    ...(process.env.E2E_NO_AUX_MODEL === '1' ? { noAuxModel: true } : {}),
  }
  if (process.env.E2E_ENRICH === '1') pins.enrichment = true
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
