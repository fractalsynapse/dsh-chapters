/**
 * THE rig's regime, in one table.
 *
 * Why a module and not `playwright.config.ts` per-project `env`: Playwright applies project `env`
 * to WORKERS, and the object handed to `globalSetup` exposes neither the filtered selection with
 * its env (measured: `config.projects` is the unfiltered 11, `env` absent on the entries,
 * `filteredProjects[0].env` undefined) — so a boot that read the config's pins silently used
 * defaults while the specs saw pins. Record and replay then booted DIFFERENT realms: tonight that
 * surfaced as replay MISSes whose requests carried arrival stubs the tapes never recorded.
 *
 * Both consumers read this table: the config builds each project's `env` from it, and
 * `globalSetup` looks up the selected project (from `fullConfig.argv`) and applies it to
 * `process.env` before booting. An explicit command-line value still wins, so a leg can be
 * re-tuned without editing the table.
 */
export interface RigPin {
  port: number
  threshold: string
  floor?: string
  enrich?: boolean
  noAuxModel?: boolean
  /** #130 experiment: suppress ONLY the plot-elicitation aux call, leaving pressure relief live. */
  noElicitedPlot?: boolean
  /** The provider's `maxRetries` for this leg. Absent means the rig's deterministic 0. Set only where a leg's
   * own assertions depend on the host re-issuing a refused request — and as a NUMBER, never by deleting the
   * `retryPolicy` block, which the host requires present (measured: deleting it broke boot readiness, #56). */
  maxRetries?: number
  /** The Suggested Next Step bar exists ONLY where a defining model is configured. This
   * leg's boot turns that switch on; every other leg leaves it off, so `OFF` is the default realm and
   * no unrelated leg can acquire a bar and start asserting on pixels nobody asked for (#113). */
  prompt?: boolean
}

export const RIG_PINS: Record<string, RigPin> = {
  // Threshold 0.5, not 0.75 (#129): this leg's journey DEPENDS on a checkpoint existing — its capture's first
  // main request already carries one — and at 0.75 the crossing was decided by a few hundred bytes of
  // machine-specific header (workspace path length, `clientTimeZone: UTC` vs a named zone, the GUI port in the
  // injected URL). That is a coin flip: the same corpus compacted on one host and not the other, and the FIRST main
  // request then had different shapes ([system,user] vs [system,checkpoint,assistant,tool]), which is what every
  // `divergeAt=msg2` miss on this leg reduces to. A margin wide enough to fire on both machines is the
  // determinism; pinning `noAuxModel` instead would delete the behavior the leg exists to measure.
  // #130 matrix cell: relief must stay live (the leg's fork door comes from a real continuation) while the
  // plot aux turn is suppressed, because that turn is what CI issues and this host does not. 0.5 + suppression
  // hangs the boot; 0.75 is the ratio the committed corpus was captured at.
  suite: { port: 41731, threshold: '0.75', noElicitedPlot: true },
  // heavy's post-compaction turn needs the host to re-issue a refused request: with retries suppressed it
  // dies at step 4 (`STILL-HERE` never answers), with them it passes in ~53s. Declared as a pin, not a global.
  heavy: { port: 41733, threshold: '0.9', floor: '1000000', maxRetries: 3 },
  arrival: { port: 41732, threshold: '0.9', floor: '500' },
  enrich: { port: 41734, threshold: '0.9', enrich: true , noAuxModel: true },
  fanout: { port: 41736, threshold: '0.75' },
  rules: { port: 41735, threshold: '0.9' , noAuxModel: true },
  fork: { port: 41737, threshold: '0.75' , noAuxModel: true },
  plans: { port: 41738, threshold: '0.99', noAuxModel: true },
  // The bar's own leg: its own port (one journey, one boot) and a 32K-friendly threshold like
  // its neighbours. Nothing about it is special beyond `prompt: true`.
  prompt: { port: 41739, threshold: '0.9', prompt: true , noAuxModel: true },
  // The OFF half of the same switch, on its own port. Without it the negative assertion could only ever skip
  // (it lived in the project that turns the feature ON), which is a test that cannot fail — the exact shape of
  // vacuous green this repo keeps being bitten by (#113, and #54 before it).
  'prompt-off': { port: 41740, threshold: '0.9', noAuxModel: true },
}

/** The env Playwright hands the project's workers — derived, never hand-copied. */
export function rigEnv(project: string): Record<string, string> {
  const p = RIG_PINS[project]
  if (p === undefined) return {}
  const env: Record<string, string> = { E2E_TAPE: project, E2E_PORT: String(p.port), E2E_THRESHOLD: p.threshold }
  if (p.floor !== undefined) env.E2E_FLOOR = p.floor
  if (p.prompt === true) env.E2E_PROMPT = '1'
  if (p.enrich === true) env.E2E_ENRICH = '1'
  if (p.noAuxModel === true) env.E2E_NO_AUX_MODEL = '1'
  if (p.noElicitedPlot === true) env.E2E_NO_PLOT = '1'
  if (p.maxRetries !== undefined) env.E2E_MAX_RETRIES = String(p.maxRetries)
  return env
}

/** Which project did this invocation ask for? `--project=x` or `--project x`, last wins. */
export function projectFromArgv(argv: readonly string[] | undefined): string | null {
  let name: string | null = null
  for (let i = 0; i < (argv?.length ?? 0); i += 1) {
    const a = argv![i]
    const eq = a.startsWith('--project=') ? a.slice('--project='.length) : null
    if (eq !== null && eq !== '') name = eq
    else if (a === '--project' && i + 1 < argv!.length) name = argv![i + 1]
  }
  return name
}

/**
 * Apply the table to `process.env` for a boot. Explicit env wins — that is how one leg gets
 * re-tuned from the command line — and an unknown project name leaves the environment alone so a
 * dev invocation (`--project=explore-dev`) keeps its existing behavior instead of being silently
 * re-pinned.
 */
export function applyRigEnv(project: string | null): RigPin | null {
  if (project === null) return null
  const p = RIG_PINS[project]
  if (p === undefined) return null
  // ONE derivation, not two lists. This function used to hand-enumerate E2E_TAPE/E2E_PORT/E2E_THRESHOLD/
  // E2E_FLOOR/E2E_ENRICH/E2E_NO_AUX_MODEL while `rigEnv` derived the same set for Playwright's project env —
  // so when the bar's leg added `prompt: true` I updated one and missed the other, the boot never set
  // `promptModel`, the dock row never rendered, and a rig wiring bug wore the exact costume of an unverified
  // product feature. Deriving from `rigEnv` makes a new pin key impossible to half-wire.
  const derived = rigEnv(project)
  for (const [key, value] of Object.entries(derived)) {
    if (process.env[key] === undefined) process.env[key] = value
  }
  return p
}
