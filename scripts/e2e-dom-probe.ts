/**
 * e2e DOM probe (#54) — the selector-archaeology pass for the BROWSER RIG, run by hand.
 *
 * When the pinned host moves and a spec starts failing on "composer did not take focus",
 * the question is what the page actually looks like NOW — and no assertion answers that.
 * This boots one e2e server, opens the app, walks the FIRST steps of the real spec path
 * (New session → is the composer attached?), and dumps the interactive surface:
 * activeElement, tree rows, anything labelled Preview, and the composer count.
 *
 *   E2E_PROBE_PORT=41799 node --experimental-strip-types scripts/e2e-dom-probe.ts
 *
 * Writes var/e2e-dom-probe.json and prints it. It STOPS the server it started: a probe
 * that leaks an orphan makes the next run die on the port guard talking about its own
 * predecessor (measured 2026-10-21, and the guard's message is what named the pid).
 */
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { bootE2eServer, ROOT } from '../tests/e2e/boot.ts'

const port = Number(process.env.E2E_PROBE_PORT ?? 41799)
const boot = await bootE2eServer(port, { thresholdRatio: '0.9' })
const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? undefined })
const page = await browser.newPage()
try {
  await page.goto(boot.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  const dump = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('div'))
      .filter((d) => d.querySelector('button') && /notice|preview|welcome|terms|consent/i.test(d.textContent ?? ''))
      .slice(0, 6)
      .map((d) => ({ text: (d.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 260), buttons: Array.from(d.querySelectorAll('button')).map((b) => ((b.textContent ?? '').trim().slice(0, 40)) || (b.getAttribute('aria-label') ?? '?')) }))
    const aria = Array.from(document.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label')!).filter((v, i, a) => a.indexOf(v) === i)
    return {
      url: location.href,
      active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none',
      dialogs,
      composerish: aria.filter((a) => /command|file|session|input|message|notice/i.test(a)).slice(0, 25),
      allCount: aria.length,
    }
  })
  // now walk the spec's actual path: click New session, then see what the draft looks like
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
      .find((b) => /New Session/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined
    btn?.click()
  })
  await page.waitForTimeout(6000)
  const after = await page.evaluate(() => ({
    active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none',
    treeitems: Array.from(document.querySelectorAll('[role="treeitem"]')).map((t) => (t.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)).slice(0, 10),
    previews: Array.from(document.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label')!).filter((a) => /preview/i.test(a)).slice(0, 10),
    composerAttached: document.querySelectorAll('div[aria-label*="/ commands, @ files or sessions"]').length,
    current: (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? 'null') as { sessionId?: string })?.sessionId ?? null,
  }))
  dump.after = after
  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-dom-probe.json'), JSON.stringify(dump, null, 2))
  console.log(JSON.stringify(dump, null, 2).slice(0, 2600))
} finally {
  await browser.close()
  await boot.stop()
}
