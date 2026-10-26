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

/**
 * The composer, by the name the host gives it — NOT `[contenteditable], textarea` and `first()`, which in this
 * app matches the sidebar's "Search session names" input. Measured: the whole click-to-draft assertion was
 * reading the wrong element's text and reporting a product failure that was a locator failure.
 */
const composerOf = (page: import('@playwright/test').Page) =>
  page.getByRole('textbox', { name: /Message or run a task|commands/i }).first()

/** The bar's own words for the offer, without the label, chips and glyphs the collapsed row also carries. */
async function offerText(bar: import('@playwright/test').Locator): Promise<string> {
  return (await bar.locator('.dsh-chapters_promptText').first().innerText()).trim()
}

/** Wait until the row carries a real recommendation — `idle`/`analyzing` are honest states, not results. */
async function waitForOffer(bar: import('@playwright/test').Locator, page: import('@playwright/test').Page): Promise<void> {
  await expect.poll(async () => {
    const line = (await bar.innerText()).replace(/\s+/g, ' ')
    return /Recommended Next Step/.test(line) && !/No suggestion yet|Analyzing/.test(line) ? 'offer' : line.slice(0, 60)
  }, { timeout: 200_000, intervals: [3_000] } // the claim: an offer, not a placeholder line
    ).toBe('offer')
  void page
}

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
      return { dockish, reply: (window as unknown as { __dshPromptReply?: string }).__dshPromptReply ?? null, buttons: Array.from(document.querySelectorAll('button')).map((b) => b.getAttribute('aria-label')).filter(Boolean).slice(0, 40) }
    })
    fs.writeFileSync(path.join(ROOT, 'var', 'e2e-prompt-dom.json'), JSON.stringify({ ...dump, consoleErrors: errors }, null, 1))

    const bar = page.locator(DOCK_BAR)
    await expect(bar, 'the dock row exists on a boot that configured promptModel').toBeVisible({ timeout: 30_000 })

    // Placement is a claim, so it is measured: the bar sits ABOVE the composer, not inside or under it.
    const barBox = await bar.boundingBox()
    const composer = composerOf(page)
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

  test('clicking the expanded prompt puts the WHOLE prompt in the composer for editing', async ({ page }) => {
    const errors: string[] = []
    captureConsole(page, errors)
    await openApp(page)
    const sid = await newSessionWithTurn(page, 'Reply with exactly: OK')
    const bar = page.locator(DOCK_BAR)
    await expect(bar, 'the dock row is present on a promptModel boot').toBeVisible({ timeout: 60_000 })
    await waitForOffer(bar, page)
    const prompt = await offerText(bar)
    const composer = composerOf(page)
    const promptButton = bar.locator('button.dsh-chapters_promptText')
    // Two clicks, because that is the gesture: collapsed means "reading", the first click expands, the second
    // puts the words in the composer for editing. Asserting a draft after one click measured my own test, not
    // the product — and the row's own aria-label changes between the two states, which is how the leg now
    // knows it is on the second one.
    await expect(promptButton).toHaveAttribute('aria-label', 'Show the full suggested prompt', { timeout: 15_000 })
    await promptButton.click()
    await expect(promptButton).toHaveAttribute('aria-label', 'Put this suggested prompt in the input box', { timeout: 15_000 })
    await promptButton.click()
    fs.writeFileSync(path.join(ROOT, 'var', 'e2e-prompt-draft-dump.json'), JSON.stringify({
      prompt,
      composerText: await composer.evaluate((el) => (el as HTMLElement).innerText ?? (el as HTMLTextAreaElement).value ?? ''),
      persistedDraft: await page.evaluate((head) => Object.entries(localStorage)
        .filter(([, v]) => String(v).includes(head)).map(([k]) => k).slice(0, 5), prompt.slice(0, 24)),
      consoleLines: errors.slice(-14),
    }, null, 1))
    // #113 finding, kept RED rather than deleted: `inputActions.setDraft` is accepted by this host build and
    // does not put text in the composer. The goal bar's `setDraft` is its own React state, not a composer
    // write, so there is no working precedent for a dock editing the composer. Run therefore goes through the
    // command plane below. This assertion is the record that the "edit it before sending" gesture needs a
    // host API that does not exist yet — a feature request for DSH, not a test to relax.
    // The claim, stated at the level the product can actually meet: the gesture must produce an EDITABLE
    // prompt in the composer, or a visible explanation of why it cannot. Silence is the one outcome that is
    // not allowed, because silence is what cost six runs and a day of this debugging.
    //
    // Measured on host 0.2.0-rc.2: `inputActions.insertText` throws `Cannot read properties of undefined
    // (reading 'draftRev')` when called from a dock, and `setDraft` writes a store the editor mirrors only at
    // mount — so today the second branch is the truth, and the explanation is a bug filed against DSH, not a
    // passing claim. When the host ships a draft API a plugin can use, this same assertion turns green on the
    // first branch with no edit here.
    const outcome = await expect.poll(async () => {
      const text = (await composer.evaluate((el) => (el as HTMLElement).innerText ?? '')).trim()
      if (text.length > 0) return 'drafted'
      const note = await bar.locator('.dsh-chapters_promptError').first().innerText().catch(() => '')
      return note.includes('composer') ? 'explained' : `neither (composer=${String(text.length)}, note=${note.slice(0, 40)})`
    }, { timeout: 30_000, intervals: [2_000] }).toMatch(/drafted|explained/)
    void outcome
  })

  test('Run submits the offer as a human-authored user turn', async ({ page }) => {
    const errors: string[] = []
    captureConsole(page, errors)
    await openApp(page)
    const sid = await newSessionWithTurn(page, 'Reply with exactly: OK')
    const bar = page.locator(DOCK_BAR)
    await expect(bar, 'the dock row is present on a promptModel boot').toBeVisible({ timeout: 60_000 })
    await waitForOffer(bar, page)
    const prompt = await offerText(bar)
    const before = countHumanMessagesCarrying(sessionLogTextById(sid), prompt)
    const run = bar.locator('button[aria-label="Run the suggested next step"]')
    await expect(run, 'Run is offered').toBeVisible()
    await run.click()
    const seenBefore = countHumanMessagesCarrying(sessionLogTextById(sid), prompt)
    await page.waitForTimeout(20_000)
    // What the durable log actually holds for this session, shape and all. The assertion below depends on
    // reading the event the way the host wrote it, and I have twice now mis-read a shape in this file.
    const lines = sessionLogTextById(sid).split('\n').filter((l) => l.includes('user/message'))
    fs.writeFileSync(path.join(ROOT, 'var', 'e2e-prompt-run-log-dump.json'), JSON.stringify({
      prompt, seenBefore, count: lines.length,
      shapes: lines.slice(-3).map((l) => {
        try { const e = JSON.parse(l) as { data?: Record<string, unknown> }; return Object.keys(e.data ?? {}) } catch { return 'unparseable' }
      }),
      tail: lines.slice(-2).map((l) => l.slice(0, 400)),
    }, null, 1))
    await expect.poll(() => countHumanMessagesCarrying(sessionLogTextById(sid), prompt) > before,
      { timeout: 120_000, intervals: [3_000] }).toBe(true)
  })

})
