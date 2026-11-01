/**
 * #194 client-push proof, standalone: boots the probe home (provisioned by live-proof.mjs), waits
 * for the probe plugin's results file (it appends a plugin:dsh-chapters/prompt READY record to a
 * session it creates), opens that session in the GUI, and asserts the bar renders the pushed offer
 * with ZERO chapters-prompt command runs in the durable log — no mount pull, no cadence, nothing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = path.join(HERE, 'live-home')
const dsh = path.join(HERE, 'host', 'node_modules', '.bin', 'dsh')
const STEP = (m) => console.log(`[push-proof] ${m}`)
const RESULTS = path.join(HERE, 'probe-results.json')

const bootHost = (port) => {
  const c = spawn(dsh, ['web', '--port', port, '--no-open'], { cwd: HERE, env: { ...process.env, DSH_HOME: HOME, LOCAL_API_KEY: 'sk-local' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  c.stdout.on('data', (d) => { log += d }); c.stderr.on('data', (d) => { log += d })
  return new Promise((res) => {
    const t = setInterval(() => { const m = /dsh web: (http:\/\/[^\s]+)/.exec(log); if (m) { clearInterval(t); res({ child: c, url: m[1], log }) } }, 500)
    setTimeout(() => { clearInterval(t); res({ child: c, url: null, log }) }, 90_000)
  })
}
const readSessionId = async (seconds) => {
  for (let i = 0; i < seconds; i++) {
    try { const sid = JSON.parse(fs.readFileSync(RESULTS, 'utf8')).sessionId ?? null; if (sid !== null) return sid } catch { /* mid-write or absent */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

// Stage 1: boot, let the probe plugin create its session and append the record.
const first = await bootHost('4299')
if (!first.url) { STEP('stage-1 no url; tail: ' + first.log.slice(-400)); first.child.kill(); process.exit(1) }
STEP(`stage-1 booted; push witness: ${first.log.includes('[chapters-push] transport LIVE')}`)
const sessionId = await readSessionId(240)
if (sessionId === null) { STEP('probe never reported a session'); first.child.kill(); process.exit(1) }
STEP(`probe session: ${sessionId}`)
first.child.kill('SIGTERM')
await new Promise((r) => setTimeout(r, 3_000))

// Stage 2: reboot and open THAT session by seeding the app's own identity key before load
// (session.ts: 'dsh.sessions.current' is the ONLY reliable browser→disk join).
const second = await bootHost('4298')
if (!second.url) { STEP('stage-2 no url; tail: ' + second.log.slice(-400)); second.child.kill(); process.exit(1) }
STEP(`stage-2 booted; push witness: ${second.log.includes('[chapters-push] transport LIVE')}`)
const url = second.url
const child = second.child
const bootLog = second.log

const countWire = () => {
  const files = spawnSync('bash', ['-c', `find ${HOME}/sessions -name 'session.v4.jsonl.zstd' 2>/dev/null`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
  let runs = 0, records = 0
  for (const f of files) {
    const t = spawnSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).stdout ?? ''
    for (const line of t.split('\n')) {
      if (line.includes('"command/run"') && /"name":\s*"chapters-prompt"/.test(line)) runs += 1
      if (line.includes('plugin:dsh-chapters/prompt')) records += 1
    }
  }
  return { runs, records }
}

const browser = await chromium.launch()
const page = await browser.newPage()
await page.addInitScript((sid) => {
  try { window.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: sid })) } catch { /* best effort */ }
}, sessionId)
await page.goto(url)
await page.waitForLoadState('networkidle').catch(() => {})
for (let i = 0; i < 3; i++) {
  const dismissed = await page.evaluate(() => {
    for (const dlg of Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))) {
      const buttons = Array.from(dlg.querySelectorAll('button'))
      const label = (b) => (b.textContent ?? '').trim()
      const ack = buttons.find((b) => /^continue$/i.test(label(b))) ?? buttons.find((b) => /^(got it|i understand|acknowledge|dismiss|ok)$/i.test(label(b))) ?? buttons.find((b) => /^close$/i.test(label(b)))
      if (ack !== undefined) { ack.click(); return label(ack) }
    }
    return false
  })
  if (!dismissed) break
  await new Promise((r) => setTimeout(r, 800))
}
await page.waitForTimeout(6_000)
const DOCK = 'div.dsh-chapters_promptDock[data-prompt-bar="true"]'
const barText = await page.locator(DOCK).first().innerText().catch(() => '')
const before = countWire()
await page.waitForTimeout(25_000) // a pull-mode bar would have polled at least once by now
const after = countWire()
const verdict = {
  pushedOfferRendered: barText.includes('PROOF-PUSHED-OFFER'),
  barText: barText.replace(/\s+/g, ' ').slice(0, 140),
  recordsInLog: after.records,
  runsBefore: before.runs,
  runsAfter: after.runs,
  zeroPulls: after.runs === 0,
}
STEP('VERDICT ' + JSON.stringify(verdict))
fs.writeFileSync(path.join(HERE, 'push-verdict.json'), JSON.stringify(verdict, null, 2))
await browser.close()
child.kill('SIGTERM')
process.exit(verdict.pushedOfferRendered && verdict.zeroPulls && verdict.recordsInLog > 0 ? 0 : 1)
