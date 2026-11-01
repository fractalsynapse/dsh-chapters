/**
 * #218 client-render proof: a GUI-CREATED session (New Session click) gets a BIRTH RECORD from the
 * session/event listener; the bar must mount on the pushed value and render with ZERO command runs
 * in that session's durable log. This proves the full chain: birth record → projection →
 * useProjection → the dock renders — the exact hop the scripted harness couldn't reach before.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = path.join(HERE, 'live-home')
const dsh = path.join(HERE, 'host', 'node_modules', '.bin', 'dsh')
const STEP = (m) => console.log(`[render-proof] ${m}`)

const child = spawn(dsh, ['web', '--port', '4299', '--no-open'], { cwd: HERE, env: { ...process.env, DSH_HOME: HOME, LOCAL_API_KEY: 'sk-local' }, stdio: ['ignore', 'pipe', 'pipe'] })
let bootLog = ''
child.stdout.on('data', (d) => { bootLog += d }); child.stderr.on('data', (d) => { bootLog += d })
let url = null
await new Promise((res) => { const t = setInterval(() => { const m = /dsh web: (http:\/\/[^\s]+)/.exec(bootLog); if (m) { url = m[1]; clearInterval(t); res() } }, 500); setTimeout(() => { clearInterval(t); res() }, 90_000) })
if (!url) { STEP('no url: ' + bootLog.slice(-300)); child.kill(); process.exit(1) }
STEP(`booted; push LIVE: ${bootLog.includes('[chapters-push] transport LIVE')}`)
await new Promise((r) => setTimeout(r, 8_000))

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleLines = []
page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 160)}`))
page.on('pageerror', (e) => consoleLines.push(`PAGEERROR: ${String(e).slice(0, 240)}`))
await page.goto(url)
await page.waitForLoadState('networkidle').catch(() => undefined)
// dismiss focus-trap dialogs
for (let i = 0; i < 3; i++) {
  const dismissed = await page.evaluate(() => {
    for (const dlg of Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))) {
      const buttons = Array.from(dlg.querySelectorAll('button'))
      const label = (b) => (b.textContent ?? '').trim()
      const ack = buttons.find((b) => /^continue$/i.test(label(b))) ?? buttons.find((b) => /^(got it|ok)$/i.test(label(b)))
      if (ack !== undefined) { ack.click(); return label(ack) }
    }
    return false
  })
  if (!dismissed) break
  await new Promise((r) => setTimeout(r, 800))
}
// create a session via the GUI (New Session) — the session the client KNOWS about
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
    .find((b) => /New Session/i.test(b.textContent ?? ''))
  btn?.click()
})
await page.waitForTimeout(3_000)
// PRISTINE HOME: the draft renders as an uncommitted 'Preview' tree row — clicking the tree row
// commits it as a real session (session.ts's measured sequence).
let current = await page.evaluate(() => {
  try { return JSON.parse(window.localStorage.getItem('dsh.sessions.current') ?? 'null')?.sessionId ?? null } catch { return null }
})
if (current === null) {
  await page.evaluate(() => {
    // 0.2.1's preview pane: the commit affordance is the row itself, whatever its role
    const candidates = Array.from(document.querySelectorAll('[role="treeitem"], aside div, nav div, [data-session]'))
      .filter((t) => /^(New Session|Into the Unknown|Preview)/i.test((t.textContent ?? '').trim().slice(0, 30)))
    const it = candidates[0] ?? document.querySelector('[role="treeitem"]')
    ;(it as HTMLElement | null)?.click()
  })
  await page.waitForTimeout(2_500)
  current = await page.evaluate(() => {
    try { return JSON.parse(window.localStorage.getItem('dsh.sessions.current') ?? 'null')?.sessionId ?? null } catch { return null }
  })
}
if (current === null) {
  // last resort: click any treeitem
  await page.evaluate(() => { document.querySelector('[role="treeitem"]')?.click() })
  await page.waitForTimeout(2_500)
  current = await page.evaluate(() => {
    try { return JSON.parse(window.localStorage.getItem('dsh.sessions.current') ?? 'null')?.sessionId ?? null } catch { return null }
  })
}
STEP(`GUI session: ${current}`)
const diag = await page.evaluate(() => ({
  treeitems: Array.from(document.querySelectorAll('[role="treeitem"]')).map((r) => (r.textContent ?? '').slice(0, 30)),
  bodyStart: (document.body.innerText ?? '').slice(0, 200).replace(/\n+/g, ' | '),
  hasComposer: document.querySelectorAll('div[aria-label*="/ commands"]').length,
  buttons: Array.from(document.querySelectorAll('button[aria-label]')).map((b) => b.getAttribute('aria-label')).slice(0, 12),
}))
STEP('DIAG ' + JSON.stringify(diag).slice(0, 400))
await page.waitForTimeout(8_000) // let the birth record land and the projection fold

const DOCK = 'div.dsh-chapters_promptDock[data-prompt-bar="true"]'
const barVisible = await page.locator(DOCK).first().isVisible().catch(() => false)
const barText = barVisible ? (await page.locator(DOCK).first().innerText().catch(() => '')) : ''
const barCount = await page.locator(DOCK).count()

// count chapters-prompt command runs + our records in the CURRENT session's log
const counts = current === null ? { runs: -1, records: -1 } : (() => {
  const files = spawnSync('bash', ['-c', `find ${HOME}/sessions -name 'session.v4.jsonl.zstd' 2>/dev/null`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
  let runs = 0, records = 0
  for (const f of files) {
    if (!f.includes(current)) continue
    const t = spawnSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).stdout ?? ''
    for (const line of t.split('\n')) {
      if (line.includes('"command/run"') && /"name":\s*"chapters-prompt"/.test(line)) runs += 1
      if (line.includes('plugin:dsh-chapters/prompt')) records += 1
    }
  }
  return { runs, records }
})()

const verdict = {
  guiSession: current,
  barCount,
  barVisible,
  barText: barText.replace(/\s+/g, ' ').slice(0, 120),
  commandRuns: counts.runs,
  birthRecords: counts.records,
  rendered: barVisible && (barText.includes('No suggestion') || barText.includes('idle') || barText.includes('recommend')),
  zeroPulls: counts.runs === 0,
}
STEP('VERDICT ' + JSON.stringify(verdict))
fs.writeFileSync(path.join(HERE, 'render-verdict.json'), JSON.stringify(verdict, null, 2))
if (consoleLines.some((l) => l.startsWith('PAGEERROR'))) STEP('PAGE ERRORS:\n' + consoleLines.filter((l) => l.startsWith('PAGEERROR')).join('\n'))
await browser.close()
child.kill('SIGTERM')
process.exit(verdict.rendered && verdict.zeroPulls && verdict.birthRecords > 0 ? 0 : 1)
