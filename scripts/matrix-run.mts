/**
 * matrix-run — run THE REAL suites against one hat version, in isolation.
 *
 * The old `smoke`-only pass (one compose probe per version) answered "does a session
 * compose on this hat?" — which is one string on a menu. This answers the actual
 * question: swap the whole `@deepseek-ai/dsh-*` family to the version, run the real
 * suites (unit + integration, optionally the e2e legs), and emit a machine-readable
 * verdict. One invocation per version so CI runs them as a parallel matrix; the list
 * of versions comes from the registry, never from a human-edited list here.
 *
 *   node --experimental-strip-types --no-warnings scripts/matrix-run.mts \
 *        --version=0.2.1-rc.4 [--legs=unit+integration|+e2e] [--out=result.json]
 *
 * Also:
 *   node scripts/matrix-run.mts --list --json               # CI matrix source (registry ≥ 0.2.0)
 *   node scripts/matrix-run.mts --report [--readme]          # table from var/matrix-runs/*.json
 *
 * Restoring the family afterwards is the caller's business (CI workspaces are clean;
 * local callers run this inside a dedicated worktree). Exit 0 iff the selected legs
 * all passed for the version.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
process.chdir(ROOT)

// ---------------------------------------------------------------- semver helpers

function cmp(a: string, b: string): number {
  const pa = a.split('-'), pb = b.split('-')
  const na = pa[0].split('.').map(Number), nb = pb[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) { const d = (na[i] ?? 0) - (nb[i] ?? 0); if (d !== 0) return d }
  if (pa.length === 1 && pb.length === 1) return 0
  if (pa.length === 1) return 1   // release > prerelease
  if (pb.length === 1) return -1
  return pa[1].localeCompare(pb[1])
}

const argv = process.argv.slice(2)
const arg = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const flag = (name: string): boolean => argv.includes(`--${name}`)

// ---------------------------------------------------------------- --list: the matrix source (CI)

if (flag('list')) {
  const MIN = arg('min') ?? '0.2.0'
  const r = spawnSync('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json'], { encoding: 'utf8', timeout: 120_000 })
  if (r.status !== 0 || r.stdout === '') { console.error(`list failed: ${(r.stderr ?? '').slice(0, 200)}`); process.exit(2) }
  const raw = JSON.parse(r.stdout) as string | string[]
  const all = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x))
  const supported = all.filter((v) => cmp(v, MIN) >= 0).sort(cmp)
  const below = all.filter((v) => cmp(v, MIN) < 0).sort(cmp)
  const forced = arg('versions')
  const include = forced !== undefined && forced !== '' ? forced.split(',').map((s) => s.trim()) : supported
  const extra = arg('below') !== undefined && arg('below') !== '' ? arg('below')!.split(',').map((s) => s.trim()) : []
  const list = [...include, ...extra]
  if (flag('json')) console.log(JSON.stringify({ include: list.map((v) => ({ version: v })), below, supported: supported.length }))
  else console.log(list.join(','))
  process.exit(0)
}

// ---------------------------------------------------------------- --report: the README table

if (flag('report')) {
  const RUNS_DIR = arg('runs') ?? path.join(ROOT, 'var', 'matrix-runs')
  const files = fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')) : []
  const rows = files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8')) as {
        version: string; verdict: string; swap?: { ok: boolean; detail: string }
        legs?: { leg: string; ok: boolean; detail: string }[]; ts?: string
      }
    } catch { return null }
  }).filter((r): r is { version: string; verdict: string; swap?: { ok: boolean; detail: string }; legs?: { leg: string; ok: boolean; detail: string }[]; ts?: string } => r !== null)
    .sort((a, b) => cmp(a.version, b.version))
  const fmt = (r: { version: string; verdict: string; legs?: { leg: string; ok: boolean }[]; ts?: string }): string => {
    const cells = (r.legs ?? []).map((l) => `${l.leg}:${l.ok ? '✅' : '❌'}`).join(' ')
    const verdict = r.verdict === 'pass' ? '✅ supported' : r.verdict === 'untestable' ? '❓ untestable' : `❌ ${r.verdict}`
    return `| ${r.version} | ${verdict} | ${cells || '—'} | ${(r.ts ?? '').slice(0, 10) || '—'} |`
  }
  const table = [
    '| DSH host version | Verdict | Real-leg results | Last run (UTC) |',
    '|---|---|---|---|',
    ...rows.map(fmt),
  ].join('\n')
  if (rows.length === 0) { console.error(`report: no result files in ${RUNS_DIR}`); process.exit(2) }
  if (flag('readme')) {
    const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    const B = '<!-- versions:begin -->', E = '<!-- versions:end -->'
    const b = md.indexOf(B), e = md.indexOf(E)
    if (b < 0 || e < 0) { console.error('report: README.md lacks the versions:begin/end markers'); process.exit(2) }
    const stamp = `> Regenerated by the \`de-de\` workflow on ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC — real test-suite legs per version with the whole \`@deepseek-ai/dsh-*\` family swapped. Verdicts from REAL runs, not compose probes.`
    const next = md.slice(0, b + B.length) + `\n\n${stamp}\n\n${table}\n\n` + md.slice(e)
    fs.writeFileSync(path.join(ROOT, 'README.md'), next)
    console.log(`report: README.md updated with ${String(rows.length)} version rows`)
  } else {
    console.log(table)
  }
  process.exit(0)
}

// ---------------------------------------------------------------- one-version invocation

const version = arg('version')
if (version === undefined || version === '') { console.error('matrix-run: --version=<v> is required'); process.exit(2) }
const LEGS = (arg('legs') ?? 'unit+integration').split('+').map((s) => s.trim()).filter((s) => s !== '')
const OUT = arg('out') ?? path.join('var', 'matrix-runs', `result-${version}.json`)
const LEG_TIMEOUT_MS = Number((arg('timeoutMs') ?? '1800000').replace(/_/g, ''))

// ---------------------------------------------------------------- what family to swap

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>
}
const family = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
  .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  .map(([name]) => name)
if (family.length === 0) { console.error('matrix-run: no @deepseek-ai/dsh* family in the package.json — wrong tree?'); process.exit(2) }

// ---------------------------------------------------------------- swap the family

function swap(): { ok: boolean; detail: string } {
  const spec = family.map((name) => `${name}@${version}`)
  const r = spawnSync('npm', ['i', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', ...spec],
    { encoding: 'utf8', timeout: 900_000 })
  if (r.status !== 0) {
    return { ok: false, detail: `npm i exit ${String(r.status)}: ${(r.stderr ?? '').replace(/\n/g, ' ').slice(0, 300)}` }
  }
  const got = spawnSync('npm', ['ls', '@deepseek-ai/dsh', '--depth=0', '--json'], { encoding: 'utf8', timeout: 60_000 })
  try {
    const j = JSON.parse(got.stdout) as { dependencies?: Record<string, { version?: string }> }
    const v = j.dependencies?.['@deepseek-ai/dsh']?.version
    if (v !== version) return { ok: false, detail: `asked ${version}, tree carries ${String(v)}` }
  } catch { /* npm ls noise — the install exit was the authority */ }
  return { ok: true, detail: `swapped ${String(family.length)} family packages to ${version}` }
}

// ---------------------------------------------------------------- run the real legs

interface LegResult { leg: string; ok: boolean; ms: number; detail: string }
const legs: LegResult[] = []

function runLeg(leg: string): void {
  const t0 = Date.now()
  let ok = false, detail = ''
  if (leg === 'unit' || leg === 'integration' || leg === 'unit+integration') {
    const r = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: LEG_TIMEOUT_MS })
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    const counts = (re: RegExp): number => { const m = out.match(re); return m === null ? -1 : Number(m[1]) }
    const pass = counts(/^# pass (\d+)$/m), fail = counts(/^# fail (\d+)$/m), todo = counts(/^# todo (\d+)$/m)
    ok = r.status === 0 && fail === 0
    detail = `pass ${String(pass)} / fail ${String(fail)} / todo ${String(todo)}`
    if (!ok) {
      const first = out.match(/^not ok \d+ - .*/m)
      detail += first != null ? ` — ${first[0].slice(0, 240)}` : ` — exit ${String(r.status)}`
    }
  } else if (leg === 'e2e') {
    const r = spawnSync('npm', ['run', 'test:e2e:replay'], { encoding: 'utf8', timeout: LEG_TIMEOUT_MS })
    ok = r.status === 0
    detail = ok ? 'replay legs passed' : `test:e2e:replay exit ${String(r.status)}`
  } else {
    ok = false; detail = `unknown leg ${leg}`
  }
  legs.push({ leg, ok, ms: Date.now() - t0, detail })
}

const result = {
  version,
  family: family.length,
  swap: { ok: false, detail: 'not attempted' },
  legs,
  verdict: 'fail',
  ts: new Date().toISOString(),
}

result.swap = swap()
if (result.swap.ok) for (const leg of LEGS) runLeg(leg)
const passed = result.swap.ok
  && LEGS.length > 0 && legs.length === LEGS.length && legs.every((l) => l.ok)
result.verdict = result.swap.ok
  ? (legs.every((l) => l.ok) ? 'pass' : 'fail')
  : 'untestable'

fs.mkdirSync(path.dirname(path.resolve(ROOT, OUT)), { recursive: true })
fs.writeFileSync(path.resolve(ROOT, OUT), JSON.stringify(result, null, 2) + '\n')
for (const l of legs) console.log(`  [${l.leg}] ${l.ok ? 'PASS' : 'FAIL'} (${String(Math.round(l.ms / 1000))}s) — ${l.detail}`)
console.log(`${version}: ${result.verdict} — ${result.swap.detail}; ${legs.map((l) => `${l.leg}:${l.ok ? 'pass' : 'fail'}`).join(' ')}`)
process.exit(passed ? 0 : 1)
