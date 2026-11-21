/**
 * host-matrix — the sweep of #443: every supported harness version, installed in its OWN
 * isolated tree, booted with the plugin, and probed for the one user-visible fact a version
 * seam can break — does a new session COMPOSE. No cell touches `dev/dsh-host-lock` (the tape
 * corpus's authority stays), the repo `node_modules`, or the centrally installed app: each tree
 * is `var/host-matrix/<version>/`, its home is port-keyed, its sink is port-keyed. The registry
 * decides the list (overridable); the report is the support statement.
 *
 *   bash scripts/host-matrix.sh                     # every published >= 0.2.0
 *   bash scripts/host-matrix.sh --versions=0.2.0-rc.2,0.2.2-rc.5 --below=0.1.7-rc.2
 *
 * Exit: 0 iff every AT-FLOOR cell passes (pass or pass-with-pruned-rows). Below-floor controls
 * may fail-unsupported — that is the floor being real, and the line says so.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawnSync, execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
process.chdir(ROOT)

import type { BootState } from '../tests/e2e/host-matrix-support.ts'

const {
  matrixTargets, classifyBootState, cellVerdict, matrixPort, isFloorRefusal,
} = await import('../tests/e2e/host-matrix-support.ts')
const { bootE2eServer } = await import('../tests/e2e/boot.ts')
const { chromium } = await import('@playwright/test')

const argv = process.argv.slice(2)
const arg = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const MATRIX_DIR = path.join(ROOT, 'var', 'host-matrix')
const RESULTS = path.join(ROOT, 'var', 'host-matrix-results.jsonl')
const CELL_WATCHDOG_MS = 240_000

// ---------------------------------------------------------------- targets

function registryVersions(): string[] {
  const r = spawnSync('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json'], { encoding: 'utf8', timeout: 120_000 })
  if (r.status !== 0 || r.stdout === '') throw new Error(`npm view failed: ${(r.stderr ?? '').slice(0, 200)}`)
  const parsed = JSON.parse(r.stdout) as string | string[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

let targets: string[]
const forced = arg('versions')
if (forced === 'none') targets = []
else if (forced !== undefined && forced !== '') {
  targets = forced.split(',').map((s) => s.trim())
} else {
  targets = matrixTargets(JSON.stringify(registryVersions()))
}
const belowArg = arg('below')
if (belowArg !== undefined && belowArg !== '') targets = [...targets, ...belowArg.split(',').map((s) => s.trim())]
if (targets.length === 0) { console.error('host-matrix: no target versions — registry unreachable and no --versions given'); process.exit(2) }
console.log(`host-matrix: ${String(targets.length)} versions — ${targets.join(', ')}`)

// ---------------------------------------------------------------- isolation

function ensureTree(version: string): { ok: boolean; detail: string; dir: string } {
  const dir = path.join(MATRIX_DIR, version)
  const bin = path.join(dir, 'node_modules', '.bin', 'dsh')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-matrix-cell', private: true, dependencies: { '@deepseek-ai/dsh': version } }, null, 2))
  const declared = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (fs.existsSync(bin) && fs.existsSync(declared)) {
    try {
      if ((JSON.parse(fs.readFileSync(declared, 'utf8')) as { version?: string }).version === version) {
        return { ok: true, detail: 'reused', dir }
      }
    } catch { /* fall through to install */ }
  }
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, encoding: 'utf8', timeout: 600_000 })
  if (r.status !== 0) return { ok: false, detail: `npm install exit ${String(r.status)}: ${(r.stderr ?? '').slice(0, 160)}`, dir }
  try {
    const got = (JSON.parse(fs.readFileSync(declared, 'utf8')) as { version?: string }).version
    return got === version ? { ok: true, detail: 'installed', dir } : { ok: false, detail: `asked ${version}, tree carries ${String(got)}`, dir }
  } catch (error) {
    return { ok: false, detail: `tree unreadable: ${String((error as Error)?.message ?? error)}`, dir }
  }
}

function bindablePort(start: number): number {
  for (let p = start; p < start + 64; p++) {
    const s = net.createServer()
    let free = true
    s.once('error', () => { free = false })
    try { s.listen(p, '127.0.0.1'); s.close() } catch { free = false }
    if (free) return p
  }
  return start
}

// ---------------------------------------------------------------- compose probe

async function composeProbe(url: string, port: number): Promise<{ composed: boolean; error?: string }> {
  const browser = await chromium.launch({ chromiumSandbox: false })
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(6000)
    // Notices are focus traps on every host generation that shows one (#54's lesson,
    // reused from the rig's own dismiss-and-proceed path).
    const { dismissTestingNotice, currentSessionId, sessionLogFileFor, agentPresetFromLog } = await import('../tests/e2e/session.ts')
    await dismissTestingNotice(page)
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
        .find((b) => /New Session/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined
      btn?.click()
    })
    let sid: string | null = null
    for (let i = 0; i < 12 && sid === null; i++) {
      await page.waitForTimeout(1000)
      sid = await currentSessionId(page)
    }
    if (sid === null) return { composed: false, error: 'new-session click never set dsh.sessions.current' }
    // The STRICT compose fact (round-1 lesson): a session existing is not a chapters session —
    // a host with no preset realm happily composes plain sessions and the loose probe PASSED a
    // below-floor version. The header line of the session's durable log carries
    // agentPreset, exactly what the rig's own precondition reads — read it here.
    const sessBase = path.join(os.tmpdir(), 'dsh-e2e', `e2e-home-${String(port)}`, 'sessions')
    let seen: string = 'unreadable'
    for (let round = 0; round < 30; round++) {
      let wsDirs: string[] = []
      try { wsDirs = fs.readdirSync(sessBase) } catch { wsDirs = [] }
      for (const w of wsDirs) {
        let sDirs: string[] = []
        try { sDirs = fs.readdirSync(path.join(sessBase, w)) } catch { continue }
        for (const s of sDirs) {
          if (!s.includes(sid)) continue
          const file = sessionLogFileFor(path.join(sessBase, w, s))
          if (file === null) continue
          try {
            const text = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
            const preset = agentPresetFromLog(text)
            seen = JSON.stringify(preset)
            if (preset === 'chapters') return { composed: true }
          } catch { /* unreadable this round; the poll budget decides */ }
        }
      }
      await new Promise((res) => setTimeout(res, 1000))
    }
    return { composed: false, error: `agent-preset/selected never became "chapters" (header seen: ${seen})` }
  } catch (error) {
    return { composed: false, error: String((error as Error)?.message ?? error).slice(0, 200) }
  } finally {
    await browser.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------- the sweep

interface Cell {
  version: string
  install: string
  preset: BootState
  dropped: string[]
  composed: boolean
  error?: string
  verdict: string
  why: string
}
const cells: Cell[] = []
fs.rmSync(RESULTS, { force: true })

for (const [i, version] of targets.entries()) {
  const tree = ensureTree(version)
  let preset: BootState = 'absent'
  let dropped: string[] = []
  let composed = false
  let bootOk = false
  let error: string | undefined
  if (!tree.ok) {
    error = tree.detail
  } else {
    const port = bindablePort(matrixPort(i))
    const home = path.join(os.tmpdir(), 'dsh-e2e', `e2e-home-${String(port)}`)
    const serverLog = path.join(ROOT, 'var', `e2e-server-${String(port)}.log`)
    process.env.E2E_HOST_DIR = tree.dir
    process.env.E2E_MODEL = 'replay' // tape regime: no credentials, no ambient model; a request that fires is a MISS, loudly
    process.env.E2E_TAPE = 'default'
    fs.rmSync(home, { recursive: true, force: true })
    let stop: (() => Promise<void>) | null = null
    const watchdog = new Promise<'watchdog'>((resolve) => {
      const t = { id: 0 as unknown as ReturnType<typeof setTimeout> }
      t.id = setTimeout(() => resolve('watchdog'), CELL_WATCHDOG_MS)
      void t.id
    })
    try {
      const raced = await Promise.race([
        (async () => {
          const handle = await bootE2eServer(port, { thresholdRatio: '0.9', noAuxModel: true })
          stop = handle.stop
          bootOk = true
          const boot = await new Promise<void>((res) => setTimeout(res, 6000))
          void boot
          const logText = fs.existsSync(serverLog) ? fs.readFileSync(serverLog, 'utf8') : ''
          const sink = fs.existsSync(path.join(ROOT, 'var', `e2e-engine-errors-${String(port)}.log`))
            ? fs.readFileSync(path.join(ROOT, 'var', `e2e-engine-errors-${String(port)}.log`), 'utf8') : ''
          const classified = classifyBootState(`${logText}\n${sink}`)
          preset = classified.state; dropped = classified.dropped
          const probe = await composeProbe(handle.url, port)
          composed = probe.composed; error = probe.error
          return null
        })().catch((e: unknown) => String((e as Error)?.message ?? e)),
        watchdog,
      ])
      if (raced === 'watchdog') { error = `cell watchdog after ${String(CELL_WATCHDOG_MS / 1000)}s — boot or probe hung` }
      else if (typeof raced === 'string') { error = isFloorRefusal(raced) ? raced : raced.slice(0, 200) }
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 200)
    } finally {
      if (stop !== null) await stop().catch(() => undefined)
      delete process.env.E2E_HOST_DIR
    }
  }
  const v = cellVerdict({ installOk: tree.ok, bootOk, preset, dropped, composed, composeError: error })
  const cell: Cell = { version, install: tree.detail, preset, dropped, composed, ...(error !== undefined ? { error } : {}), verdict: v.verdict, why: v.why }
  cells.push(cell)
  fs.appendFileSync(RESULTS, JSON.stringify(cell) + '\n')
  console.log(`${version.padEnd(14)} ${v.verdict.padEnd(18)} ${v.why}${dropped.length > 0 ? ` [dropped: ${dropped.join(', ')}]` : ''}`)
}

// ---------------------------------------------------------------- report

const atFloor = cells.filter((c) => matrixTargets(JSON.stringify([c.version])).length > 0)
const bad = atFloor.filter((c) => !c.verdict.startsWith('pass'))
const boundary = atFloor.filter((c) => c.verdict !== 'pass').map((c) => c.version)
console.log('\n=== host-matrix verdict table ===')
console.log('cells:', String(cells.length), '| supported-block failures:', String(bad.length))
if (boundary.length > 0) console.log(`support boundary observed at: ${boundary.join(', ')} (newest failures listed; see ${path.relative(ROOT, RESULTS)})`)
process.exit(bad.length === 0 ? 0 : 1)
