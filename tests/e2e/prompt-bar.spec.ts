/**
 * The docked Suggested Next Step bar, in a real browser (#113).
 *
 * This is the leg that decides whether the feature exists. Everything before it was type-level: the dock
 * component compiles, `promptModel` is the only existence switch, and the rig now boots a session whose route
 * really answers. What has NEVER been shown is a pixel — so every assertion here names something the browser
 * either renders or does not, and nothing is claimed about behavior the DOM cannot evidence.
 *
 * Selectors are only the ones `src/client/prompt-dock.ts` actually emits: `data-prompt-bar="true"` on the dock
 * row, and the button labels `Run the suggested next step`, `Autorun`, `Turn prompt suggestions off for this
 * session`. No invented class names, no heading text — the wording is the product's to change.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

/**
 * Console capture for the leg that has to prove a component renders.
 *
 * A missing dock row has four possible causes and the DOM cannot tell them apart: plugin not mounted (the
 * assistant-action buttons settle that), slot not registered, registration rejected by a host guard, or the
 * component throwing during render. Only the browser says which — and `page.on` must be attached before
 * navigation, so it lives here rather than in the discovery spec.
 */
function captureConsole(page: import('@playwright/test').Page, sink: string[]): void {
  // The URL, not just the status. "Failed to load resource: 404" tells me something is missing; the request
  // path tells me WHETHER it is the bar's own command plane or some unrelated asset.
  page.on('response', (r) => { if (r.status() >= 400) sink.push(`http ${String(r.status())}: ${r.url().slice(0, 160)}`) })
  page.on('requestfailed', (r) => { sink.push(`requestfailed: ${r.url().slice(0, 160)} :: ${String(r.failure()?.errorText ?? '')}`.slice(0, 240)) })
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.text().includes('[client:prompt]')) sink.push(`${m.type()}: ${m.text()}`.slice(0, 300)) })
  page.on('pageerror', (e) => { sink.push(`pageerror: ${String(e.message).slice(0, 300)}`) })
}

import { countHumanMessagesCarrying, newSessionWithTurn, openApp, sessionLogTextById } from './session.ts'

const DOCK_BAR = 'div.dsh-chapters_promptDock[data-prompt-bar="true"]'

test.describe('the suggested-next-step bar docked above the composer', () => {
  test('it registers into the composer dock and is visible without hovering anything', async ({ page }) => {
    const errors: string[] = []
    captureConsole(page, errors)
    await openApp(page)
    const sid = await newSessionWithTurn(page, 'Reply with exactly: OK')
    expect(sid, 'the leg needs a completed turn before a suggestion can exist').toBeTruthy()
    // Name what the browser rendered BEFORE asserting, into a file. Without this a dock failure is only
    // ever a locator string, and three separate causes — the plugin not mounted, the slot not registered,
    // the component returning null on its switch — are indistinguishable. Measured cost tonight: I chased a
    // stale bundle, a wrong model route, and a deleted rig home before the DOM could tell me which it was.
    const dump = await page.evaluate(() => {
      const dockish = Array.from(document.querySelectorAll('[data-plugin-root], [data-prompt-bar], [class*="promptDock"], [class*="_composer"]'))
        .map((el) => ({ tag: el.tagName, cls: el.className?.toString?.().slice(0, 60) ?? '', attr: el.getAttribute('data-plugin-root') ?? el.getAttribute('data-prompt-bar') ?? '' }))
      return { dockish, buttons: Array.from(document.querySelectorAll('button')).map((b) => b.getAttribute('aria-label')).filter(Boolean).slice(0, 40) }
    })
    fs.writeFileSync(path.join(ROOT, 'var', 'e2e-prompt-dom.json'), JSON.stringify({ ...dump, consoleErrors: errors }, null, 1))

    const bar = page.locator(DOCK_BAR)
    await expect(bar, 'the dock row exists on a boot that configured promptModel').toBeVisible({ timeout: 30_000 })

    // Placement is a claim, so it is measured: the bar sits ABOVE the composer, not inside or under it.
    const barBox = await bar.boundingBox()
    const composer = page.locator('[contenteditable="true"], textarea').first()
    const composerBox = await composer.boundingBox()
    expect(barBox, 'the bar has a box — a zero-size node is not "rendered"').not.toBeNull()
    expect(composerBox, 'the composer has a box').not.toBeNull()
    expect(barBox!.y + barBox!.height, 'the whole bar is above the composer input').toBeLessThanOrEqual(composerBox!.y + 4)
  })

  test('it offers the three actions the design promises', async ({ page }) => {
    await openApp(page)
    await newSessionWithTurn(page, 'Reply with exactly: OK')
    const bar = page.locator(DOCK_BAR)
    await expect(bar.locator('button[aria-label="Run the suggested next step"]'), 'Run').toBeVisible({ timeout: 30_000 })
    await expect(bar.locator('button[aria-label="Autorun"], button:has-text("Autorun")').first(), 'Autorun').toBeVisible()
    await expect(bar.locator('button[aria-label="Turn prompt suggestions off for this session"], button:has-text("Off")').first(), 'Off').toBeVisible()
  })

  test('expanding puts the WHOLE prompt in the composer for editing, and Run submits it as a user message', async ({ page }) => {
    await openApp(page)
    const sid = await newSessionWithTurn(page, 'Reply with exactly: OK')
    const bar = page.locator(DOCK_BAR)
    await expect(bar, 'the dock row is present on a promptModel boot').toBeVisible({ timeout: 30_000 })

    // The suggestion's own words, read out of the DOM rather than assumed: everything below is checked
    // against THESE bytes, so the leg cannot pass by submitting something else.
    const prompt = (await bar.innerText()).trim()
    expect(prompt.length, 'the row says something — an empty row is not a suggestion').toBeGreaterThan(0)

    // Record the row's words as they change, so "it never got a recommendation" is a measurement rather than
    // a guess: `idle` → `Analyzing the session…` → an actual next step is the sequence the product owes, and
    // which link of the chain broke is visible in the transitions.
    const seen: string[] = []
    const started = Date.now()
    while (Date.now() - started < 150_000) {
      const line = (await bar.innerText()).replace(/\s+/g, ' ').trim()
      if (seen[seen.length - 1] !== line) seen.push(line)
      if (seen.length > 1 && !/No suggestion yet|Analyzing/.test(line) && line.length > 24) break
      await page.waitForTimeout(2_000)
    }
    fs.writeFileSync(path.join(ROOT, 'var', 'e2e-prompt-transitions.json'), JSON.stringify(seen, null, 1))
    expect(seen.length, 'the row said something').toBeGreaterThan(0)
    expect(seen[seen.length - 1], 'the bar produced a recommendation for the completed turn').not.toMatch(/No suggestion yet/)

    // Click-to-draft: the composer ends up holding the whole prompt, not a fragment of it.
    await bar.click()
    const composer = page.locator('[contenteditable="true"], textarea').first()
    await expect.poll(async () => {
      const t = await composer.evaluate((el) => ((el as HTMLElement).innerText ?? (el as HTMLTextAreaElement).value ?? ''))
      return t.trim().length
    }, { timeout: 30_000, intervals: [1_000] }).toBeGreaterThan(0)
    const drafted = (await composer.evaluate((el) => ((el as HTMLElement).innerText ?? (el as HTMLTextAreaElement).value ?? ''))).trim()
    expect(drafted.length, 'the draft carries the suggestion, not a truncated head of it').toBeGreaterThanOrEqual(Math.min(prompt.length, 20))

    // Run submits it: the durable log gains a HUMAN-authored message holding those words. This is the
    // assertion that matters — a click that only moved pixels would leave the feature unusable and green.
    const before = countHumanMessagesCarrying(sessionLogTextById(sid), prompt)
    const run = bar.locator('button[aria-label="Run the suggested next step"]')
    await expect(run, 'Run is offered').toBeVisible()
    await run.click()
    await expect.poll(
      () => countHumanMessagesCarrying(sessionLogTextById(sid), prompt) > before,
      // expect.poll takes (fn, opts) only — a third "message" argument is a compile error here, and the
      // repo's own baseline carries that error in a-knowledge-loop.spec. Naming the claim in the assertion
      // text instead keeps the failure readable without borrowing a broken call shape.
      { timeout: 180_000, intervals: [3_000] },
      // Run must reach the durable log as a human-authored user message holding those exact words.
    ).toBe(true)
  })

  test('a boot WITHOUT promptModel has no bar at all — OFF is the default realm', async ({ page }) => {
    // The rig guarantees the negative half: only the `prompt` project sets E2E_PROMPT, so any other leg's boot
    // is this test's fixture. Asserting absence here is what stops a component that renders unconditionally
    // from being mistaken for one that respects its switch.
    await openApp(page)
    await newSessionWithTurn(page, 'Reply with exactly: OK')
    if (process.env.E2E_PROMPT !== '1') {
      await expect(page.locator(DOCK_BAR), 'no promptModel means no dock row').toHaveCount(0)
    } else {
      test.skip(true, 'this boot configured promptModel; the negative case belongs to an un-pinned project')
    }
  })
})
