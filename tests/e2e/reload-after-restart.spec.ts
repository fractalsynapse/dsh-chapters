/**
 * #319 — the red-first gate: a continued child MUST cold-load after a host restart.
 *
 * The acceptance test this failure class never had: every other leg exercises children while
 * the boot that created them is still alive — nobody killed the server and opened the child
 * again. That restart is the chair's saip scenario (#314): the kernel records its first-turn
 * header mid-surface behind the seeded notice, the host's cold validator refuses the log,
 * and hours of work become an error dialog. Here the refusal gets reproduced deterministically
 * by CI, on the real gateway path, through the real affordances (fork door, sidebar rows).
 *
 * `test.fail(...)` states the contract: TODAY the load is refused (a failing expectation is
 * the expected status; the run stays green). When the empty-seed birth (#319) AND this
 * journey's tape land, the test PASSES — and Playwright turns the unexpected pass into a
 * red run. That red is the signal to delete the annotation, not to touch the assertions.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { deliveredFor, openApp, dismissTestingNotice, newSessionWithTurn, currentSessionId, openSessionByRow, forkDoor, typeComposer, E2E_HOME } from './session.ts'
import { rigChildEnv } from './boot.ts'
import { reapOrphanBoots } from './boot-reap.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** The journey's tape dir: zero entries => not recorded yet => the leg is NOT RUN (skip), and it
 * says so in the project output. `test.fail()` below then carries exactly one meaning: the BUG. */
const TAPE_DIR = path.join(ROOT, 'tests', 'fixtures', 'model-tape', 'reload')
const tapeRecorded = (): boolean => {
  try { return fs.readdirSync(TAPE_DIR).some((f) => f.endsWith('.json')) } catch { return false }
}
const rowTexts = (page: import('@playwright/test').Page): Promise<string[]> =>
  page.locator('[role="treeitem"]').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))

test.describe('a continued child survives a host restart (#319)', () => {
  const stage = (m: string): void => { console.log(`[reload-leg] ${new Date().toISOString().slice(11, 19)}Z stage: ${m}`) }

  test('cold-loads on a fresh host process: its history renders', async ({ browser }) => {
    // RETIRED 2026-11-05: the empty-seed birth (#319 part 2) is in and the reload journey is
    // recorded. This row's PASS is now the contract: a child that ran real turns survived a
    // kill-and-reboot and cold-loaded its history. If it fails, the birth regressed — do not
    // re-annotate, find the seed.
    test.skip(!tapeRecorded() && process.env.E2E_MODEL !== 'record', '#319: reload journey has no tape yet — record it (E2E_MODEL=record chain-replay reload); until then this leg must not generate MISS traffic, and once recorded its failure means the BUG, not a missing fixture')
    test.setTimeout(1_500_000)

    // ---- parent with one completed turn on the fixture boot
    const page = await browser.newPage()
    await openApp(page)
    await newSessionWithTurn(page, 'Name one HTTP redirect status code in one short sentence. Make ZERO tool calls and read no files.', 180_000)

    // ---- fork door -> ch- child; capture the child's row text the way a human sees it
    const rowsBefore = await rowTexts(page)
    const before = await currentSessionId(page)
    const door = forkDoor(page)  // OUR door; the native 'Branch into…' is hidden by design (client/index.ts:74)
    await expect(door, 'our fork door is offered once a turn completed').toBeVisible({ timeout: 60_000 })
    await door.click()
    await expect.poll(async () => {
      const cur = await currentSessionId(page)
      return cur !== null && cur !== before && cur.startsWith('ch-')
    }, { timeout: 90_000, intervals: [1_000], message: 'the app switched to the ch- child' }).toBe(true)
    const childId = (await currentSessionId(page)) ?? ''
    expect(childId.startsWith('ch-'), `the switch left us on a ch- child, got ${childId}`).toBe(true)
    stage('switched to the child: ' + childId.slice(0, 14))
    // (row capture moved BELOW the answer poll: while the birth-ack runs, the sidebar row
    // carries the transient 'Running…' status prefix — grabbing it there corrupts the very
    // string the restarted host must match.)
    // the poison needs a real request: type into the child (second tape entry of this journey)
    await typeComposer(page, 'Name one HTTP redirect status code in one short sentence. Make ZERO tool calls and read no files.', deliveredFor(childId, 'HTTP redirect'), 240_000)
    stage('child question submitted')
    await expect.poll(() => page.evaluate(() => document.body.innerText), { timeout: 180_000, intervals: [2000], message: 'assistant answer lands' }).toMatch(/redirect|30[1278]|status/i)
    // Sidebar row text glues transient status tokens to the title at unpredictable edges
    // ('…— branchno' measured) — never a stable needle for a COLD relaunch. The needle is
    // the door-set title, a static substring both boots render. Idle is gated where it
    // counts: typeComposer waits for the composer to ATTACH (busy = stop button, not input).
    const childNeedle = 'name one http redirect status — branch'
    stage('child row present on the live boot')

    // ---- RESTART for real: reap the fixture boot by port (the rig's own reap API), then a
    // fresh process over the same home. Only durable bytes can serve what comes next.
    const boot = JSON.parse(fs.readFileSync(path.join(ROOT, 'var', 'e2e-boot.json'), 'utf8')) as { port: number, hostBinary: string }
    await reapOrphanBoots(boot.port, ROOT, (m) => { console.log(`[reload-leg] ${m}`) })
    const portB = boot.port + 25
    const proc: ChildProcess = spawn(boot.hostBinary, ['web', '--port', String(portB), '--no-open'], {
      env: rigChildEnv(process.env, { home: E2E_HOME, port: portB }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    let killed = false
    const stop = (): void => { if (!killed) { killed = true; proc.kill('SIGTERM') } }
    try {
      stage('restart: booting a fresh process')
    const url = await new Promise<string>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error(`restart boot never answered:\n${buf.slice(-300)}`)), 150_000)
        proc.stdout!.on('data', (d) => {
          buf += String(d)
          const m = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(buf)
          if (m !== null) { clearTimeout(to); stage('bootB url (stdout): ' + m[1]!.slice(0, 60)); resolve(m[1]!) }
        })
        proc.stderr!.on('data', (d) => {
        buf += String(d)
        // the boot's OWN url on this port only — banner/proxy lines match any loopback URL
        const me = new RegExp('http:\\/\\/127\\.0\\.0\\.1:' + String(portB) + '\\/\\S*').exec(buf)
        if (me !== null) { clearTimeout(to); stage('bootB url (stderr): ' + me[0]!.slice(0, 60)); resolve(me[0]!) }
      })
        proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`restart boot exited early (${String(c)}):\n${buf.slice(-400)}`)) })
      })

      // ---- cold-load through the gateway: open the SAME row on the fresh process.
      // Prove boot B ACTUALLY LISTENS first (the banner lies — it prints before the bind,
      // and an unlistened goto hangs forever on Playwright's default no-nav-timeout), and
      // fail LOUD with the boot's own tail instead of a 25-minute wall.
      const netm = await import('node:net')
      const serves = (): Promise<boolean> => new Promise((res) => {
        const sk = netm.createConnection({ host: '127.0.0.1', port: portB })
        sk.once('connect', () => { sk.destroy(); res(true) })
        sk.once('error', () => { res(false) })
      })
      try { await expect.poll(serves, { timeout: 90_000, intervals: [2000] }).toBe(true) }
      catch { throw new Error(`boot B never listened on port ${String(portB)}; its output tail:\n${buf.slice(-600)}`) }
      console.log(`[reload-leg] stage: boot B is LISTENING; output tail: ${buf.slice(-160)}`)
      const pageB = await browser.newPage()
      pageB.setDefaultTimeout(60_000)  // locator calls in openSessionByRow otherwise wait on the TEST timeout
      await pageB.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      console.log(`[reload-leg] ${new Date().toISOString().slice(11, 19)}Z stage: goto done`)
      await dismissTestingNotice(pageB)  // the boot-B modal masks the sidebar; openApp dismisses it and my cold page skipped that step (measured: '_mask_ intercepts pointer events')
      await pageB.waitForTimeout(8_000)
      const rowsDump = await pageB.evaluate(() => Array.from(document.querySelectorAll('[role="treeitem"]')).map((r) => (r.textContent ?? '').slice(0, 40)))
      console.log(`[reload-leg] ${new Date().toISOString().slice(11, 19)}Z stage: cold rows (${String(rowsDump.length)}): ${JSON.stringify(rowsDump.slice(0, 5))}`)
      // Let the sidebar QUIESCE before clicking: the cold boot's title refresh churns the
      // rows, and locator.click waits for an element that stops moving — measured burning
      // the full test budget on a row that never settled within the old 8s grace.
      const snapRows = (): Promise<string> => pageB.evaluate(() => Array.from(document.querySelectorAll('[role="treeitem"]')).map((r) => r.textContent ?? '').join('|'))
      await expect.poll(async () => {
        const a = await snapRows()
        await pageB.waitForTimeout(4_000)
        return a === await snapRows() ? 'settled' : 'moving'
      }, { timeout: 120_000, intervals: [1_000], message: 'the cold sidebar never settled' }).toBe('settled')
      const rowState = await pageB.evaluate((n) => {
        const hits = Array.from(document.querySelectorAll('[role="treeitem"]')).filter((r) => ((r.textContent ?? '').toLowerCase().includes(n)))
        return { matched: hits.length, rects: hits.map((h) => { const b = h.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x) } }) }
      }, childNeedle)
      console.log(`[reload-leg] ${new Date().toISOString().slice(11, 19)}Z stage: child row state ${JSON.stringify(rowState)}`)
      await dismissTestingNotice(pageB)  // the notice mounts late on boot B (hydration) — the goto-time pass ran before it existed
      const modalDump = await pageB.evaluate(() => {
        const roots = Array.from(document.querySelectorAll('[role="presentation"], [aria-modal="true"], [role="dialog"]'))
        return roots.slice(0, 4).map((d) => ({ cls: String(d.className).slice(0, 24), text: (d.textContent ?? '').slice(0, 90), btns: Array.from(d.querySelectorAll('button')).map((b) => JSON.stringify((b.textContent ?? '').trim().slice(0, 30)) + (b.disabled ? '(disabled)' : '')).join(', ') }))
      })
      console.log(`[reload-leg] ${new Date().toISOString().slice(11, 19)}Z stage: boot-B modal dump ${JSON.stringify(modalDump)}`)
      // boot B inherits no ambient API key, so the first-run onboarding modal ('Add an API
      // key', buttons Configure-later / Save-and-continue[disabled]) masks the sidebar. The
      // human path IS the dismissal: click 'Configure later' and prove the mask is gone.
      await pageB.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => /^configure later$/i.test((x.textContent ?? '').trim()))
        if (b !== undefined) b.click()
      })
      await pageB.waitForTimeout(2_500)
      const maskGone = await pageB.evaluate(() => document.querySelectorAll('[class*="_mask_"]').length === 0)
      expect(maskGone, 'boot B onboarding mask survived Configure-later').toBe(true)
      const opened = await openSessionByRow(pageB, [childNeedle, childId])
      expect(opened, `the restarted host lists the child row for needle ${childNeedle}`).toBe(true)
      const coldId = await currentSessionId(pageB)
      expect(coldId, `the cold open must land on the CHILD session, got ${String(coldId) ?? 'null'}`).toBe(childId)
      // the load itself is the assertion: on a poisoned log the gateway refuses and NO history
      // renders (the chair's error); on a reloadable shape both rows are present.
      stage('cold boot reached; asserting history')
      await expect(pageB.getByText('HTTP redirect').first(), 'child content after cold load (row titles truncate — measured)').toBeVisible({ timeout: 60_000 })
      await expect.poll(() => pageB.evaluate(() => document.body.innerText), { timeout: 60_000, intervals: [2000], message: 'child assistant row after cold load' }).toMatch(/redirect|30[1278]|status|[Aa]cknowledg/i)
    } finally {
      stop()
    }
  })
})
