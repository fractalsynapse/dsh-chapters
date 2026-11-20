/**
 * Pure support for the host-version matrix (#443).
 *
 * The harness moves constantly; the rig pins ONE version; the centrally installed app is a THIRD
 * thing nobody tests. The user directive: declared supported versions, each test environment in its
 * own isolated harness tree, and a sweep that NAMES where failures lie. Everything judgment-shaped
 * lives here so it can be unit-tested without a boot; the driver under `scripts/` only wires IO.
 *
 * The classifier's authority is the boot lines the plugin itself emits (src/preset.ts + src/index.ts,
 * the four states) plus today's measured incident classes: a BROKEN row line, the rig's own
 * below-floor refusal text, and the compose symptom (`new-session click never set
 * dsh.sessions.current`) that #437 left behind.
 */

/** Support floor of this plugin's preset realm — docs/contract.md § preset declaration rows. */
export const SUPPORT_FLOOR = '0.2.0'

const split = (v: string): { num: [number, number, number]; pre: string } => {
  const [base, pre = ''] = v.split('-', 2)
  const n = base.split('.').map((x) => Number(x) || 0)
  return { num: [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0], pre }
}

/** semver-with-prerelease `a >= b` (prerelease sorts BELOW its bare release, per semver). */
export function versionGe(a: string, b: string): boolean {
  const x = split(a); const y = split(b)
  for (let i = 0; i < 3; i++) {
    if ((x.num[i] ?? 0) !== (y.num[i] ?? 0)) return (x.num[i] ?? 0) > (y.num[i] ?? 0)
  }
  if (x.pre === y.pre) return true
  if (y.pre === '') return false // 0.2.0-rc.1 < 0.2.0
  if (x.pre === '') return true
  return x.pre.localeCompare(y.pre) >= 0
}

/** Series floor for the TARGET LIST: the product's `>= 0.2.0` claim counts the floor's own
 *  prereleases (the pinned host IS 0.2.0-rc.2), so the comparison is on the numeric base —
 *  semver ordering stays untouched in versionGe for everything else. */
export function atOrAboveFloor(v: string): boolean {
  const x = split(v).num
  const f = split(SUPPORT_FLOOR).num
  for (let i = 0; i < 3; i++) if (x[i] !== f[i]) return (x[i] ?? 0) > (f[i] ?? 0)
  return true
}

/** Registry versions JSON → the declared target list: every version at/above the floor,
 *  newest last, deduped; `includeBelowFloor` appends those (the matrix's negative controls). */
export function matrixTargets(versionsJson: string, opts: { includeBelowFloor?: string[] } = {}): string[] {
  let raw: unknown
  try { raw = JSON.parse(versionsJson) } catch { return [] }
  const list: string[] = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : typeof raw === 'string' ? [raw] : []
  const atFloor = [...new Set(list.filter((v) => atOrAboveFloor(v)))].sort((a, b) => (versionGe(a, b) ? 1 : -1))
  const below = [...new Set((opts.includeBelowFloor ?? []).filter((v) => !atOrAboveFloor(v)))]
  return [...atFloor, ...below]
}

export type BootState = 'registered' | 'pruned' | 'broken' | 'unsupported' | 'duplicate' | 'absent'

/**
 * The four-state boot verdict from the server log text the plugin wrote. Order matters: the
 * loud failure lines win over the quiet success lines, and a PRUNED registration (rows the host
 * never shipped — legitimate drift the guard drops NAMED) is a distinct state from success:
 * each dropped row is attributed in `dropped`.
 */
export function classifyBootState(logText: string): { state: BootState; dropped: string[] } {
  const dropped: string[] = []
  const dropLine = logText.match(/registered — dropped (\d+) row\(s\) this host cannot import: ([^\n—]+)/)
  if (dropLine !== null) {
    for (const part of (dropLine[2] ?? '').split(', ')) {
      const name = part.trim().match(/\(([^)]+)\)/)?.[1]
      if (name !== undefined) dropped.push(name)
    }
  }
  if (/DECLARED BUT BROKEN|refusing to compose|refused:/.test(logText) && /preset/i.test(logText)) return { state: 'broken', dropped }
  if (/cannot register preset declaration rows/.test(logText)) return { state: 'unsupported', dropped }
  if (/is also declared by another row/.test(logText)) return { state: 'duplicate', dropped }
  if (dropLine !== null) return { state: 'pruned', dropped }
  if (/registered as a declaration row/.test(logText)) return { state: 'registered', dropped }
  return { state: 'absent', dropped }
}

export type CellVerdict = 'pass' | 'fail-compose' | 'fail-broken-preset' | 'fail-unsupported' | 'fail-boot' | 'fail-install'

/** The sweep's per-cell verdict: install, boot, preset state and the compose fact in ONE named
 *  outcome. `composeError` is the probe's failure text; the #437 signature (a session that never
 *  becomes current under a BROKEN preset) gets its OWN verdict so the table says WHY. */
export function cellVerdict(cell: {
  installOk: boolean
  bootOk: boolean
  preset: BootState
  dropped: string[]
  composed: boolean
  composeError?: string
}): { verdict: CellVerdict; why: string } {
  if (!cell.installOk) return { verdict: 'fail-install', why: 'the isolated harness tree could not be installed' }
  if (!cell.bootOk) return { verdict: 'fail-boot', why: 'the host binary from this tree never produced a reachable server' }
  if (cell.preset === 'broken') return { verdict: 'fail-broken-preset', why: `DECLARED BUT BROKEN${cell.dropped.length > 0 ? ` — rows this host cannot activate: ${cell.dropped.join(', ')}` : ''}` }
  if (cell.preset === 'unsupported') return { verdict: 'fail-unsupported', why: 'the host cannot register preset declaration rows (below the 0.2.0 floor by design)' }
  if (cell.preset === 'absent' && !cell.composed) return { verdict: 'fail-boot', why: 'neither a preset boot line nor a composed session — the cell cannot be attributed' }
  if (cell.preset === 'absent') return { verdict: 'pass', why: 'composed with no loud preset failure — the healthy registration line is logger.info on the host log stream, not this pipe' }
  if (!cell.composed) return { verdict: 'fail-compose', why: `a new session never composed with the chapters preset${cell.composeError === undefined ? '' : `: ${cell.composeError}`}` }
  return { verdict: 'pass', why: cell.preset === 'pruned' ? `composed; rows pruned as unshipped: ${cell.dropped.join(', ')}` : 'composed' }
}

/** The rig's own below-floor refusal (bootE2eServer throws on a pin < 0.2.0) — recognized so a
 *  driver can report it as a verdict instead of a crash. */
export function isFloorRefusal(text: string): boolean {
  return /cannot register preset declaration rows[\s\S]*supports >= 0\.2\.0/.test(text)
}

/** Ports for matrix cells: a band SEPARATE from the rig (41731-41746) so a sweep and a leg can
 *  never share a home directory, a proxy, or an engine-errors sink. */
export const matrixPort = (index: number): number => 41900 + index
