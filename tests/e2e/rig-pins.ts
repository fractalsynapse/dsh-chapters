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
}

export const RIG_PINS: Record<string, RigPin> = {
  suite: { port: 41731, threshold: '0.75' },
  heavy: { port: 41733, threshold: '0.5', floor: '1000000' },
  arrival: { port: 41732, threshold: '0.9', floor: '500' },
  enrich: { port: 41734, threshold: '0.9', enrich: true },
  fanout: { port: 41736, threshold: '0.75' },
  rules: { port: 41735, threshold: '0.9' },
  fork: { port: 41737, threshold: '0.75' },
  plans: { port: 41738, threshold: '0.99', noAuxModel: true },
}

/** The env Playwright hands the project's workers — derived, never hand-copied. */
export function rigEnv(project: string): Record<string, string> {
  const p = RIG_PINS[project]
  if (p === undefined) return {}
  const env: Record<string, string> = { E2E_TAPE: project, E2E_PORT: String(p.port), E2E_THRESHOLD: p.threshold }
  if (p.floor !== undefined) env.E2E_FLOOR = p.floor
  if (p.enrich === true) env.E2E_ENRICH = '1'
  if (p.noAuxModel === true) env.E2E_NO_AUX_MODEL = '1'
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
  const set = (key: string, value: string): void => { if (process.env[key] === undefined) process.env[key] = value }
  set('E2E_TAPE', project)
  set('E2E_PORT', String(p.port))
  set('E2E_THRESHOLD', p.threshold)
  if (p.floor !== undefined) set('E2E_FLOOR', p.floor)
  if (p.enrich === true) set('E2E_ENRICH', '1')
  if (p.noAuxModel === true) set('E2E_NO_AUX_MODEL', '1')
  return p
}
