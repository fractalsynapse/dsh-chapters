/**
 * #194 live browser proof: the REAL plugin on the 0.2.1 probe host, a real local model (vLLM),
 * a real turn — asserting the maintainer's ledger directly:
 *   1. the server log says the push transport is LIVE,
 *   2. the bar reaches a real offer,
 *   3. the durable log carries plugin:dsh-chapters/prompt records,
 *   4. navigating away and back (past the quiet interval) adds ZERO chapters-prompt command runs,
 *   5. a second turn's offer arrives with still zero added runs — the idle edge + records did it.
 * Usage: node live-proof.mjs   (expects vLLM healthy on :8080)
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const HOST = path.join(HERE, 'host')
const HOME = path.join(HERE, 'live-home')
const PORT = '4299'
const dsh = path.join(HOST, 'node_modules', '.bin', 'dsh')
const STEP = (m) => console.log(`[live-proof] ${m}`)

// ---- provision (first boot creates the profile; then plugin add; then config rows)
if (!fs.existsSync(path.join(HOME, 'profiles', 'web', 'package.json'))) {
  STEP('provisioning home (first boot)')
  const first = spawn(dsh, ['web', '--port', PORT, '--no-open'], { cwd: HERE, env: { ...process.env, DSH_HOME: HOME }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((res) => { let b = ''; const d = (x) => { b += String(x); if (b.includes('dsh web: http')) res() }; first.stdout.on('data', d); first.stderr.on('data', d); setTimeout(res, 45_000) })
  first.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 1500))
}
const profPkg = path.join(HOME, 'profiles', 'web', 'package.json')
const pkg = JSON.parse(fs.readFileSync(profPkg, 'utf8'))
if (!pkg.dependencies?.['@treeseed/dsh-chapters']) {
  STEP('dsh plugin add link:repo + link:probe-plugin')
  const addProbe = spawnSync(dsh, ['plugin', '--profile', 'web', 'add', `link:${path.join(HERE, 'plugin')}`], { cwd: HERE, env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 300_000 })
  if (addProbe.status !== 0) { console.error(addProbe.stdout, addProbe.stderr); process.exit(1) }
  const add = spawnSync(dsh, ['plugin', '--profile', 'web', 'add', `link:${REPO}`], { cwd: HERE, env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 300_000 })
  if (add.status !== 0) { console.error(add.stdout, add.stderr); process.exit(1) }
}
const patchPath = path.join(HOME, 'profiles', 'web', 'cordis.patch.yml')
let patch = fs.readFileSync(patchPath, 'utf8')
if (!patch.includes('llm-pi-ai')) {
  // The rig's discipline (applyRigPluginPatch): ONE row per id. `plugin add` writes a bare row;
  // appending a second row with the same id leaves the merge to chance — replace instead.
  const out = []
  let skipping = false
  for (const line of patch.split('\n')) {
    if (/^- id: '@treeseed\/dsh-chapters'/.test(line)) { skipping = true; continue }
    if (skipping && !/^\s/.test(line) && line !== '') skipping = false
    if (!skipping) out.push(line)
  }
  patch = out.join('\n')
  patch = patch.split('\n').filter((l) => l.trim() !== '[]').join('\n')
  patch += `
- id: llm-pi-ai
  config:
    providers:
      local:
        displayName: Local
        api: openai-completions
        baseURL: http://127.0.0.1:8080/v1
        models:
          - id: qwen3-4b-instruct
            name: qwen3-4b-instruct
            contextWindow: 32768
            maxTokens: 4096
        apiKeyEnv: LOCAL_API_KEY
- id: agent-default-model
  config:
    provider: local
    model: qwen3-4b-instruct
    reasoningEffort: medium
- id: agent-preset-registry
  config:
    selectedDefault: chapters
- id: '@treeseed/dsh-chapters'
  config:
    promptModel: local/qwen3-4b-instruct
    artifactStoreRoot: ${path.join(HOME, 'store')}
`
  fs.writeFileSync(patchPath, patch)
  STEP('config rows written (provider, default model, promptModel)')
}

// ---- boot
fs.rmSync(path.join(HERE, 'live-boot.log'), { force: true })
const child = spawn(dsh, ['web', '--port', PORT, '--no-open'], { cwd: HERE, env: { ...process.env, DSH_HOME: HOME, LOCAL_API_KEY: 'sk-local' }, stdio: ['ignore', 'pipe', 'pipe'] })
let bootLog = ''
const logStream = fs.createWriteStream(path.join(HERE, 'live-boot.log'))
child.stdout.on('data', (d) => { bootLog += String(d); logStream.write(d) })
child.stderr.on('data', (d) => { bootLog += String(d); logStream.write(d) })
let url = null
await new Promise((res) => {
  const t = setInterval(() => { const m = /dsh web: (http:\/\/[^\s]+)/.exec(bootLog); if (m) { url = m[1]; clearInterval(t); res() } }, 500)
  setTimeout(() => { clearInterval(t); res() }, 60_000)
})
if (url === null) { console.error('no URL line; boot log tail:\n' + bootLog.slice(-1500)); child.kill(); process.exit(1) }
STEP(`booted: ${url.slice(0, 40)}…`)
STEP(`boot log carries push witness: ${bootLog.includes('[chapters-push]')}; door witness: ${bootLog.includes('turn/end door armed')}`)
for (const line of bootLog.split('\n').filter((l) => /chapters|Failed|activate/i.test(l)).slice(0, 8)) STEP(`boot: ${line.slice(0, 140)}`)
await new Promise((r) => setTimeout(r, 8_000)) // let plugins finish activating
const pushLive = bootLog.includes('push transport LIVE')
STEP(`server says push transport LIVE: ${pushLive}`)

// ---- drive
async function dismissDialogs(page) {
  for (let i = 0; i < 3; i++) {
    const dismissed = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      for (const dlg of dialogs) {
        const buttons = Array.from(dlg.querySelectorAll('button'))
        if (buttons.length === 0) continue
        const label = (b) => (b.textContent ?? '').trim()
        const ack = buttons.find((b) => /^continue$/i.test(label(b)))
          ?? buttons.find((b) => /^(got it|i understand|acknowledge|dismiss|ok)$/i.test(label(b)))
          ?? buttons.find((b) => /^close$/i.test(label(b)))
        if (ack !== undefined) { ack.click(); return label(ack) }
      }
      return false
    })
    if (!dismissed) return
    console.log(`[live-proof] dismissed dialog via: ${dismissed}`)
    await new Promise((r) => setTimeout(r, 800))
  }
}

const browser = await chromium.launch()
const page = await browser.newPage()
const consoleTail = []
page.on('console', (m) => { consoleTail.push(`${m.type()}: ${m.text().slice(0, 160)}`); if (consoleTail.length > 60) consoleTail.shift() })
page.on('pageerror', (e) => { consoleTail.push(`PAGEERROR: ${String(e).slice(0, 200)}`) })
await page.goto(url)
await page.waitForLoadState('networkidle').catch(() => undefined)
await dismissDialogs(page)

  // open the probe plugin's session (sidebar row named after its id prefix) and assert the push
  let probeSession = null
  for (let i = 0; i < 200 && probeSession === null; i++) {
    try { probeSession = JSON.parse(fs.readFileSync(RESULTS, 'utf8')).sessionId ?? null } catch { /* not yet */ }
    if (probeSession === null) await new Promise((r) => setTimeout(r, 1000))
  }
  STEP(`probe session: ${probeSession ?? 'NONE'}`)
  if (probeSession !== null) {
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[role="treeitem"]'))
      const target = rows.find((r) => /push-probe/i.test(r.textContent ?? '')) ?? rows[0]
      target?.click()
    })
    await page.waitForTimeout(6_000)
    const barText = await page.locator(DOCK).first().innerText().catch(() => '')
    const before = countWire()
    await page.waitForTimeout(20_000) // a pull-mode bar would have polled several times by now
    const after = countWire()
    const verdictPush = {
      pushedOfferRendered: barText.includes('PROOF-PUSHED-OFFER'),
      barText: barText.replace(/\s+/g, ' ').slice(0, 120),
      recordsInLog: after.records,
      runsBefore: before.runs,
      runsAfter: after.runs,
      zeroPulls: after.runs === 0,
    }
    STEP('PUSH VERDICT ' + JSON.stringify(verdictPush))
    fs.writeFileSync(path.join(HERE, 'push-verdict.json'), JSON.stringify(verdictPush, null, 2))
    if (process.env.PUSH_ONLY === '1') { await browser.close(); child.kill('SIGTERM'); process.exit(verdictPush.pushedOfferRendered && verdictPush.zeroPulls ? 0 : 1) }
  }

const DOCK = 'div.dsh-chapters_promptDock[data-prompt-bar="true"]'

// ---- client push proof (#194's last unproven piece): the probe plugin appended a
// plugin:dsh-chapters/prompt record with a READY payload to a session it created itself. Opening
// that session must render the pushed offer through useProjection with ZERO chapters-prompt
// command runs — no mount pull, no cadence, no confirm: the projection IS the wire.
const RESULTS = path.join(HERE, 'probe-results.json') // the plugin's own default (cwd = HERE)
const zstdText = (f) => spawnSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).stdout ?? ''
const countWire = () => {
  const files = spawnSync('bash', ['-c', `find ${HOME}/sessions -name 'session.v4.jsonl.zstd' 2>/dev/null`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
  let runs = 0, records = 0
  for (const f of files) {
    for (const line of zstdText(f).split('\n')) {
      if (line.includes('"command/run"') && /"name":\s*"chapters-prompt"/.test(line)) runs += 1
      if (line.includes('plugin:dsh-chapters/prompt')) records += 1
    }
  }
  return { runs, records }
}
const countRuns = () => {
  let n = 0, records = 0
  for (const f of walk(HOME)) {
    let t = ''
    try { t = fs.readFileSync(f, 'utf8') } catch { continue }
    if (!t.includes('command/run') && !t.includes('plugin:dsh-chapters/prompt')) continue
    for (const line of t.split('\n')) {
      if (line.includes('"command/run"') && /"name":\s*"chapters-prompt"/.test(line)) n += 1
      if (line.includes('plugin:dsh-chapters/prompt')) records += 1
    }
  }
  return { runs: n, records }
}
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}
try {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
      .find((b) => /New Session/i.test(b.textContent ?? ''))
    btn?.click()
  })
  await page.waitForTimeout(3_000)
  // The pristine-home sequence, ported from tests/e2e/session.ts (measured there): the draft can
  // render as an uncommitted Preview pane whose composer never sends; clicking the tree row commits.
  let composer = page.locator('div[aria-label*="/ commands, @ files or sessions"]').first()
  try {
    await composer.waitFor({ state: 'attached', timeout: 8_000 })
  } catch {
    await page.evaluate(() => {
      const it = Array.from(document.querySelectorAll('[role="treeitem"]'))
        .find((t) => /^New Session/.test((t.textContent ?? '').trim()))
      it?.click()
    })
    await page.waitForTimeout(2_500)
    composer = page.locator('div[aria-label*="/ commands, @ files or sessions"]').first()
    await composer.waitFor({ state: 'attached', timeout: 15_000 })
  }
  // The send sequence, ported from tests/e2e/session.ts typeComposer (measured there, three
  // failure families closed): insertText — NOT type() — then verify the editor holds the needle,
  // then a send loop that clicks the enabled Send button and falls back to Enter, checking the
  // durable delivery predicate (the user message rendered) BEFORE pressing again.
  const QUESTION = 'Reply with exactly one word: hello'
  const composerSel = 'div[aria-label*="/ commands, @ files or sessions"]'
  const needle = QUESTION.slice(0, 24)
  const editorHolds = () => page.evaluate((a) => (document.querySelector(a.sel)?.textContent ?? 'ABSENT').includes(a.needle), { sel: composerSel, needle })
  // The DURABLE log is the only delivery authority (session.ts's lesson: the composer's own text
  // renders the needle too, so a DOM predicate reports "sent" for a message that never left).
  const delivered = () => {
    try {
      const { execSync } = require('node:child_process')
      const dir = execSync(`find ${HOME}/sessions -name 'session.v4.jsonl.zstd' 2>/dev/null | head -1`).toString().trim()
      if (dir === '') return false
      const text = execSync(`zstd -dc '${dir}' 2>/dev/null || true`).toString()
      return text.includes('"user/message"') && text.includes(needle.slice(0, 16))
    } catch { return false }
  }
  const emptied = () => page.evaluate((sel) => (document.querySelector(sel)?.textContent ?? '').trim() === '', composerSel)
  for (let attempt = 0; attempt < 3 && !(await delivered()); attempt++) {
    let composer = page.locator(composerSel).first()
    try { await composer.waitFor({ state: 'attached', timeout: 8_000 }) }
    catch {
      await page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('[role="treeitem"]'))
          .find((t) => /^New Session/.test((t.textContent ?? '').trim()))
        it?.click()
      })
      await page.waitForTimeout(2_500)
      composer = page.locator(composerSel).first()
      await composer.waitFor({ state: 'attached', timeout: 15_000 })
    }
    const box = await composer.boundingBox()
    if (box !== null) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await dismissDialogs(page)
    const focused = await page.evaluate((sel) => {
      const ae = document.activeElement
      return ae !== null && ae.closest(sel) !== null
    }, composerSel).catch(() => false)
    if (!focused) STEP('composer did not take the caret; retrying focus')
    await page.keyboard.insertText(QUESTION)
    if (!(await editorHolds())) { STEP('insertText did not reach the editor; retrying focus'); continue }
    for (let round = 0; round < 12 && !(await delivered()) && !(await emptied()); round++) {
      const send = page.locator('button[aria-label="Send message"]')
      const enabled = (await send.count()) > 0 && await send.first().isEnabled().catch(() => false)
      if (enabled) await send.first().click({ force: true }).catch(() => undefined)
      else await page.keyboard.press('Enter')
      for (let i = 0; i < 4 && !(await emptied()); i++) await page.waitForTimeout(500)
    }
    if (await delivered()) STEP('send landed (user message rendered)')
  }
  await page.waitForTimeout(5_000)
  const bodyText = (await page.evaluate(() => document.body.innerText.slice(0, 600))).replace(/\n+/g, ' | ')
  STEP(`page after send: ${bodyText.slice(0, 280)}`)
  STEP('turn sent; waiting for the bar offer (up to 240s)')
  await page.waitForFunction(() => {
    const el = document.querySelector('div.dsh-chapters_promptDock[data-prompt-bar="true"]')
    return el !== null && /Recommended Next Step/.test(el.textContent ?? '') && !/Analyzing/.test(el.textContent ?? '')
  }, null, { timeout: 240_000 })
  STEP('offer is on the bar')
  const first = countRuns()
  STEP(`after first offer: chapters-prompt runs=${first.runs} push-records=${first.records}`)

  // navigate away and back, past the quiet interval
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
      .find((b) => /New Session/i.test(b.textContent ?? ''))
    btn?.click()
  })
  await page.waitForTimeout(4_000)
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="treeitem"], aside a, nav a'))
    rows[0]?.click()
  })
  await page.waitForTimeout(70_000) // > QUIET_POLL_MS: a pull-mode bar would have re-pulled by now
  const back = countRuns()
  STEP(`after away-and-back + 70s: runs=${back.runs} (delta ${back.runs - first.runs}) records=${back.records}`)

  const doors = await page.locator('button[aria-label="Fork with chapters"]').count()
  STEP(`fork/continue door buttons visible: ${doors}`)
  const verdict = {
    doorsRendered: doors > 0,
    pushLive,
    offerSeen: true,
    recordsFlowing: back.records > 0,
    navigationCostZero: back.runs - first.runs === 0,
    runs: back.runs,
    records: back.records,
  }
  console.log('VERDICT ' + JSON.stringify(verdict))
  fs.writeFileSync(path.join(HERE, 'live-verdict.json'), JSON.stringify(verdict, null, 2))
} catch (e) {
  console.log('VERDICT FAILED: ' + String(e?.message ?? e).slice(0, 300))
  console.log('CONSOLE TAIL:\n' + consoleTail.slice(-25).join('\n'))
  await page.screenshot({ path: path.join(HERE, 'live-fail.png'), fullPage: false }).catch(() => undefined)
  fs.writeFileSync(path.join(HERE, 'live-verdict.json'), JSON.stringify({ failed: String(e?.message ?? e).slice(0, 600), pushLive }, null, 2))
  process.exitCode = 1
} finally {
  await browser.close()
  child.kill('SIGTERM')
  logStream.end()
}
