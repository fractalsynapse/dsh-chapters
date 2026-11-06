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
import { openApp, newSessionWithTurn, currentSessionId, openSessionByRow, E2E_HOME } from './session.ts'
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
  test('cold-loads on a fresh host process: its history renders', async ({ browser }) => {
    // RETIRED 2026-11-05: the empty-seed birth (#319 part 2) is in and the reload journey is
    // recorded. This row's PASS is now the contract: a child that ran real turns survived a
    // kill-and-reboot and cold-loaded its history. If it fails, the birth regressed — do not
    // re-annotate, find the seed.
    test.skip(!tapeRecorded(), '#319: reload journey has no tape yet — record it (E2E_MODEL=record chain-replay reload); until then this leg must not generate MISS traffic, and once recorded its failure means the BUG, not a missing fixture')
    test.setTimeout(600_000)

    // ---- parent with one completed turn on the fixture boot
    const page = await browser.newPage()
    await openApp(page)
    await newSessionWithTurn(page, 'Reply with exactly: OK', 120_000)

    // ---- fork door -> ch- child; capture the child's row text the way a human sees it
    const rowsBefore = await rowTexts(page)
    const before = await currentSessionId(page)
    const door = page.locator('button[aria-label="Branch into a new conversation"]')
    await expect(door, 'the fork door is offered once a turn completed').toBeVisible({ timeout: 30_000 })
    await door.click()
    await expect.poll(async () => {
      const cur = await currentSessionId(page)
      return cur !== null && cur !== before && cur.startsWith('ch-')
    }, { timeout: 90_000, intervals: [1_000] }, 'the app switched to the ch- child').toBe(true)
    const childRow = (await rowTexts(page)).find((t) => !rowsBefore.includes(t)) ?? ''
    expect(childRow.length, 'the child appears as its own sidebar row on the live boot').toBeGreaterThan(3)

    // the poison needs a real request: type into the child (second tape entry of this journey)
    await page.locator('[data-composer-input], [contenteditable="true"][role="textbox"]').first().click()
    await page.keyboard.type('Reply with exactly: OK')
    await page.keyboard.press('Enter')
    await expect(page.getByText('OK', { exact: true }).last()).toBeVisible({ timeout: 120_000 })

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
      const url = await new Promise<string>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error(`restart boot never answered:\n${buf.slice(-300)}`)), 150_000)
        proc.stdout!.on('data', (d) => {
          buf += String(d)
          const m = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(buf)
          if (m !== null) { clearTimeout(to); resolve(m[1]!) }
        })
        proc.stderr!.on('data', (d) => { buf += String(d) })
        proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`restart boot exited early (${String(c)}):\n${buf.slice(-400)}`)) })
      })

      // ---- cold-load through the gateway: open the SAME row on the fresh process
      const pageB = await browser.newPage()
      await pageB.goto(url, { waitUntil: 'domcontentloaded' })
      await pageB.waitForTimeout(8_000)
      const opened = await openSessionByRow(pageB, [childRow])
      expect(opened, `the restarted host lists the child row ("${childRow.slice(0, 40)}")`).toBe(true)
      // the load itself is the assertion: on a poisoned log the gateway refuses and NO history
      // renders (the chair's error); on a reloadable shape both rows are present.
      await expect(pageB.getByText('Reply with exactly: OK').first(), 'child user row after cold load').toBeVisible({ timeout: 30_000 })
      await expect(pageB.getByText('OK', { exact: true }).last(), 'child assistant row after cold load').toBeVisible({ timeout: 30_000 })
    } finally {
      stop()
    }
  })
})
