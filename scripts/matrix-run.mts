/**
 * matrix-run — run THE REAL suites against one hat version, in isolation.
 *
 * The old `smoke`-only pass (one compose probe per version) answered "does a session
 * compose on this hat?" — one string on a menu, not a meal. This answers the actual
 * question: swap the whole hat to the version, run the real suites (unit + integration,
 * optionally the e2e legs), and emit a machine-readable verdict. One invocation per
 * version so CI runs them as a parallel matrix; the list of versions comes from the
 * registry, never from a human-edited list here.
 *
 *   node --experimental-strip-types --no-warnings scripts/matrix-run.mts \
 *        --version=0.2.1-rc.4 [--legs=unit+integration|+e2e] [--out=result.json]
 *
 * Also:
 *   node scripts/matrix-run.mts --list --json               # CI matrix source (registry >= 0.2.0)
 *   node scripts/matrix-run.mts --report [--readme]          # table from var/matrix-runs/*.json
 *
 * The tree afterwards is modified (package.json rewritten); the caller owns the
 * cleanup — CI workspaces are clean, local callers run this inside a worktree.
 * Exit 0 iff the selected legs all passed for the version.
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
  // The floor is the VERSION LINE, prereleases included: the registry has no plain 0.2.0 —
  // the first release of that line IS 0.2.0-rc.1. Strict semver would sort 0.2.0-rc.1 BELOW
  // 0.2.0 and silently drop the floor line from its own block; the floor test therefore
  // compares the numeric base only.
  const base = (v: string): number[] => v.split('-')[0].split('.').map(Number)
  const atLeastLine = (v: string, min: string): boolean => {
    const a = base(v), b = base(min)
    for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d !== 0) return d > 0 }
    return true
  }
  const supported = all.filter((v) => atLeastLine(v, MIN)).sort(cmp)
  const below = all.filter((v) => !atLeastLine(v, MIN)).sort(cmp)
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
  interface Row { version: string; verdict: string; swap?: { ok: boolean; detail: string }
    legs?: { leg: string; ok: boolean; detail: string }[]; ts?: string }
  const rows = files.map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8')) as Row } catch { return null }
  }).filter((r): r is Row => r !== null && typeof r.version === 'string').sort((a, b) => cmp(a.version, b.version))
  if (rows.length === 0) { console.error(`report: no result files in ${RUNS_DIR}`); process.exit(2) }
  const fmt = (r: Row): string => {
    const cells = (r.legs ?? []).map((l) => `${l.leg}:${l.ok ? '✅' : '❌'}`).join(' ')
    const verdict = r.verdict === 'pass' ? '✅ supported' : r.verdict === 'untestable' ? '❓ untestable' : `❌ ${r.verdict}`
    return `| ${r.version} | ${verdict} | ${cells || '—'} | ${(r.ts ?? '').slice(0, 10) || '—'} |`
  }
  const table = [
    '| DSH host version | Verdict | Real-leg results | Last run (UTC) |',
    '|---|---|---|---|',
    ...rows.map(fmt),
  ].join('\n')
  if (flag('readme')) {
    const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    const B = '<!-- versions:begin -->', E = '<!-- versions:end -->'
    const b = md.indexOf(B), e = md.indexOf(E)
    if (b < 0 || e < 0) { console.error('report: README.md lacks the versions:begin/end markers'); process.exit(2) }
    const stamp = `> Regenerated by the version-sweep workflow on ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC — real test-suite legs per version with the whole hat family re-resolved. Verdicts from REAL runs, not compose probes.`
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

// ---------------------------------------------------------------- swap the family

type Pkgj = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

function familyMissing(): Map<string, string> {
  // Every @deepseek-ai package some installed @deepseek-ai package needs, which the tree
  // does not have. Newer hat lines are 100+ packages modular — dependents name packages
  // the OLD line never had, and --legacy-peer-deps never installs peers; this walk closes
  // the gap at the depender's own range (sub-versions like cordis-plugin-* are NOT the hat
  // version, and pinning them to it dies ETARGET).
  const missing = new Map<string, string>()
  let famDirs: string[] = []
  try { famDirs = fs.readdirSync('node_modules/@deepseek-ai') } catch { return missing }
  for (const d of famDirs) {
    let p: Pkgj
    try { p = JSON.parse(fs.readFileSync(`node_modules/@deepseek-ai/${d}/package.json`, 'utf8')) as Pkgj } catch { continue }
    for (const map of [p.dependencies, p.peerDependencies]) {
      for (const [dep, range] of Object.entries(map ?? {})) {
        if (!dep.startsWith('@deepseek-ai/')) continue
        if (fs.existsSync(`node_modules/${dep}`)) continue
        if (missing.has(dep)) continue
        if (range.startsWith('workspace:')) continue // monorepo-internal: not installable, and not the point
        if (range === '*') missing.set(dep, dep.startsWith('@deepseek-ai/dsh') ? version : range)
        else missing.set(dep, range)
      }
    }
  }
  return missing
}

function swap(): { ok: boolean; detail: string } {
  const pkgPath = 'package.json'
  const original = fs.readFileSync(pkgPath, 'utf8')
  const pkgj = JSON.parse(original) as Pkgj
  // The family SET differs between lines (measured: 0.2.0-rc.1 never published
  // dsh-experimental-client-ui-cot-translation; 0.2.1-rc.1 never published dsh-web-deepseek-api).
  // Pin every package.json name to the target version and npm dies ETARGET on a name that old
  // line never had — which is a fact about OUR manifest's vintage, not about the block. Check
  // each name's publication at the target version first; pin what exists, unpin what does not
  // (the closure walk pulls whatever the version's own graph actually carries).
  let changed = 0
  const droppedNames: string[] = []
  for (const deps of [pkgj.dependencies ?? {}, pkgj.devDependencies ?? {}]) {
    for (const name of Object.keys(deps)) {
      if (!(name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))) continue
      const seen = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', timeout: 90_000 })
      if (seen.status === 0 && (seen.stdout ?? '').trim() !== '') { deps[name] = version; changed++ }
      else { delete deps[name]; droppedNames.push(name) }
    }
  }
  ;(pkgj.dependencies ??= {})['@deepseek-ai/dsh'] = version
  changed++
  if (changed === 1) { fs.writeFileSync(pkgPath, original); return { ok: false, detail: 'no @deepseek-ai/dsh* family in package.json — wrong tree?' } }
  fs.writeFileSync(pkgPath, JSON.stringify(pkgj, null, 2) + '\n')
  const tryInstall = (extra: string[]): ReturnType<typeof spawnSync> =>
    spawnSync('npm', ['install', '--no-audit', '--no-fund', ...extra], { encoding: 'utf8', timeout: 900_000 })
  let r = tryInstall([])
  let flagUsed = 'default resolver'
  if (r.status !== 0) {
    // peer-strict resolution trips where an exact independent sub-version peer conflicts;
    // legacy-peer-deps is the fallback, and the family-missing walk below then closes the
    // peers it skipped. Stated in the detail so the block stays honest about how it ran.
    r = tryInstall(['--legacy-peer-deps'])
    flagUsed = 'legacy-peer-deps fallback'
  }
  if (r.status !== 0) {
    fs.writeFileSync(pkgPath, original)
    return { ok: false, detail: `npm install exit ${String(r.status)}: ${(r.stderr ?? '').replace(/\n/g, ' ').slice(0, 300)}` }
  }
  // Close the family to closure — newer lines are 100+ packages and npm dedup+legacy-peer
  // installs none of the peers. Bounded at 5 passes; a hat line whose closure never settles
  // is itself a result, but never a silently-broken block.
  let closed = 0
  for (let pass = 0; pass < 5; pass++) {
    const missing = familyMissing()
    if (missing.size === 0) { closed = pass; break }
    const add = [...missing].map(([n, range]) => `${n}@${range}`)
    // NO --no-save here: a later install prunes no-save additions it does not know about,
    // so the five passes would each delete the last one's peers and never settle. Saving makes
    // them real direct dependencies — the tree is disposable (worktree / clean CI workspace).
    const rr = tryInstall(['--legacy-peer-deps', ...add])
    if (rr.status !== 0) {
      return { ok: false, detail: `closure exit ${String(rr.status)} for ${add.slice(0, 3).join(' ')} (${add.length} pkgs): ${(rr.stderr ?? '').replace(/\n/g, ' ').slice(0, 220)}` }
    }
    closed = 5
  }
  // ZOD INSTANCE ALIGNMENT (issue #449): the compile dies TS2379 when the host's own packages
  // pin zod EXACTLY (storage-domain/sdk-protocol/llm pin 4.4.3 from 0.2.1-alpha.3, 4.6.6 from
  // 0.2.2-rc.5) while our root range floats to something newer — npm then nests a second zod
  // under the host package and the two instances are structurally incompatible under
  // exactOptionalPropertyTypes at the schema boundary in src/store.ts. Testing "against the
  // version" means resolving the tree the way that version itself resolves it: when nested
  // zod copies exist and every host exact pin agrees, re-pin the ROOT zod to the consensus
  // and re-install. When host pins CONFLICT with each other, no root can satisfy them — the
  // nesting is intrinsic to that version and is recorded as such, never hidden by an
  // alignment that would lie about the tree.
  let alignNote = ''
  {
    const nested: string[] = []
    for (const fam of fs.readdirSync('node_modules/@deepseek-ai')) {
      const nestedZod = `node_modules/@deepseek-ai/${fam}/node_modules/zod/package.json`
      if (fs.existsSync(nestedZod)) {
        try { nested.push(JSON.parse(fs.readFileSync(nestedZod, 'utf8')).version as string) } catch { /* unreadable copy */ }
      }
    }
    if (nested.length > 0) {
      const pins = new Map<string, number>()
      for (const fam of fs.readdirSync('node_modules/@deepseek-ai')) {
        let q: Pkgj & { dependencies?: Record<string, string> }
        try { q = JSON.parse(fs.readFileSync(`node_modules/@deepseek-ai/${fam}/package.json`, 'utf8')) as typeof q } catch { continue }
        const z = q.dependencies?.zod
        if (typeof z === 'string' && /^\d+\.\d+\.\d+$/.test(z)) pins.set(z, (pins.get(z) ?? 0) + 1)
      }
      if (pins.size === 1) {
        const target = [...pins.keys()][0]!
        try {
          const rootVer = JSON.parse(fs.readFileSync('node_modules/zod/package.json', 'utf8')).version as string
          if (rootVer !== target) {
            const fresh = JSON.parse(fs.readFileSync('package.json', 'utf8')) as Pkgj
            ;(fresh.dependencies ??= {})['zod'] = target
            fs.writeFileSync('package.json', JSON.stringify(fresh, null, 2) + '\n')
            const ai = tryInstall([])
            alignNote = ai.status === 0
              ? `; aligned root zod ${rootVer} -> ${target} (every host exact pin agrees — one instance, the version's own resolution)`
              : `; alignment install FAILED (exit ${String(ai.status)}): ${(ai.stderr ?? ai.stdout ?? '').replace(/\n/g, ' ').slice(0, 160)}`
          } else alignNote = `; zod already ${target} at root (single instance)`
        } catch { alignNote = '; nested zod found but root copy unreadable' }
      } else {
        alignNote = `; CONFLICTING host zod pins ${[...pins.keys()].join(' / ')} — no root version satisfies all, nesting is intrinsic to this version`
      }
    }
  }
  let ok = false, detail = ''
  try {
    const got = JSON.parse(fs.readFileSync('node_modules/@deepseek-ai/dsh/package.json', 'utf8')) as { version?: string }
    ok = got.version === version
    detail = ok ? `re-resolved ${String(changed)} direct entries to ${version} (${flagUsed}, closed in ${String(closed)} pass${closed === 1 ? '' : 'es'}${droppedNames.length > 0 ? `; ${String(droppedNames.length)} manifest names not published at this version left unpinned` : ''}${alignNote})`
      : `asked ${version}, tree carries ${String(got.version)}`
  } catch { detail = `asked ${version}, no @deepseek-ai/dsh after install (${flagUsed})` }
  return { ok, detail }
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
    // Node's test summary lines in BOTH formats seen this session: spec reporter `\u2139 pass N`
    // (what Node 24 prints without a TTY here) and TAP `# pass N`. A regex that matches
    // neither reads -1, and -1 turned a 4-failure run into an unparseable one — the counts
    // are part of the verdict, not decoration.
    const counts = (word: string): number => { const m = out.match(new RegExp('(?:\\u2139|#) ' + word + ' (\\d+)', 'm')); return m === null ? -1 : Number(m[1]) }
    const pass = counts('pass'), fail = counts('fail'), todo = counts('todo')
    ok = r.status === 0 && fail === 0
    detail = `pass ${String(pass)} / fail ${String(fail)} / todo ${String(todo)}`
    if (!ok) {
      // Name the failing rows in the verdict (spec reporter prints '✖ <name>'; TAP prints
      // 'not ok N - <name>'). A red cell that names its rows is a finding; a red cell that
      // only says 'exit 1' is a mystery the next reader re-investigates from zero.
      const names = [...out.matchAll(/(?:^|\n)\s*(?:✖|not ok \d+ - )([^\n(]{4,120})/gm)].map((m) => m[1]!.trim())
        .filter((n) => !/^failing tests/.test(n)).slice(0, 4)
      detail += names.length > 0 ? ` — failing: ${names.join(' | ')}` : ` — exit ${String(r.status)}`
    }
  } else if (leg === 'e2e') {
    const r = spawnSync('npm', ['run', 'test:e2e:replay'], { encoding: 'utf8', timeout: LEG_TIMEOUT_MS })
    ok = r.status === 0
    detail = ok ? 'replay legs passed' : `test:e2e:replay exit ${String(r.status)}`
  } else if (leg === 'e2e-live') {
    const r = spawnSync('npm', ['run', 'test:e2e:live'], { encoding: 'utf8', timeout: LEG_TIMEOUT_MS })
    ok = r.status === 0
    detail = ok ? 'live legs passed' : `test:e2e:live exit ${String(r.status)}`
  } else {
    ok = false; detail = `unknown leg ${leg}`
  }
  legs.push({ leg, ok, ms: Date.now() - t0, detail })
}

const result = {
  version,
  swap: { ok: false, detail: 'not attempted' },
  legs,
  verdict: 'fail',
  ts: new Date().toISOString(),
}

// Mark the cell for the suite itself: rows that guard the REPO's pin consistency
// (root devDeps vs e2e lock vs corpus record) are about the pinned world, not about
// plugin compatibility with this version — in a matrix cell they would fire as false
// reds, so they skip BY NAME (never silently, never vacuously — normal runs are
// unaffected because the variable is absent outside a cell).
process.env.DSH_MATRIX_VERSION = version
result.swap = swap()
if (result.swap.ok && LEGS.length > 0) {
  // Tests read the BUILT surface (lib/*.js — gitignored); a fresh workspace without a
  // build fails on ENOENT lib/tools.js, which says nothing about the hat version. The tsc
  // half of `npm run build` produces it; the tsdown client bundle is not needed here and
  // OOMs on newer module graphs — run the compiler, not the bundler.
  const b = spawnSync(process.execPath, ['--max-old-space-size=12288', './node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { encoding: 'utf8', timeout: 900_000 })
  if (b.status !== 0) {
    // A build that fails AFTER a clean version re-resolve is a REAL result for the version —
    // the compile itself is one of the tests. It is recorded as the `build` leg failing (with
    // the compiler's head), never as an 'untestable' block; the tests would only echo it.
    const head = `${b.stdout ?? ''}\n${b.stderr ?? ''}`.split('\n').filter((l) => /error TS\d+/.test(l))[0] ?? ''
    result.legs.push({ leg: 'build', ok: false, ms: 0, detail: `exit ${String(b.status)}${head !== '' ? ` — ${head.slice(0, 220)}` : ''}` })
    result.verdict = 'fail'
  }
}
if (result.swap.ok && !result.legs.some((l) => l.leg === 'build' && !l.ok)) for (const leg of LEGS) runLeg(leg)
const buildFailed = legs.some((l) => l.leg === 'build' && !l.ok)
const passed = result.swap.ok && !buildFailed && LEGS.length > 0 && legs.filter((l) => l.leg !== 'build').length === LEGS.length && legs.every((l) => l.ok)
result.verdict = result.swap.ok ? (passed ? 'pass' : 'fail') : 'untestable'

fs.mkdirSync(path.dirname(path.resolve(ROOT, OUT)), { recursive: true })
fs.writeFileSync(path.resolve(ROOT, OUT), JSON.stringify(result, null, 2) + '\n')
for (const l of legs) console.log(`  [${l.leg}] ${l.ok ? 'PASS' : 'FAIL'} (${String(Math.round(l.ms / 1000))}s) — ${l.detail}`)
console.log(`${version}: ${result.verdict} — ${result.swap.detail}; ${legs.map((l) => `${l.leg}:${l.ok ? 'pass' : 'fail'}`).join(' ')}`)
process.exit(passed ? 0 : 1)
