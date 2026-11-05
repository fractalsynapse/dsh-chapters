/**
 * #276 — the persisted-off revival leg: the delivery-layer pin #272 never had.
 *
 * Why this leg exists: every Playwright boot starts with EMPTY localStorage, so the bug #272
 * fixed — a disk-restored `off` cache vetoing the mount pull forever, while the durable row
 * held a ready offer — has no browser-side existence anywhere else in the corpus. The unit
 * rows pin the decision; only this leg can pin the DELIVERY: seed the maintainer's exact state
 * (a stale `off` mirror for a session whose row is ready), reload, and require the bar back.
 *
 * Pre-#272 this assertion fails by construction: the mount renders the cached `off` (an
 * invisible row) and never pulls. Post-#272 the disk tag (`readPersisted` sets fromDisk) pays
 * the one honest revival pull — and the pull leaves a receipt the leg reads: `__dshPromptReply`,
 * the dock's own test-seam write of the last wire answer, which stays EMPTY if no pull ever ran.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { newSessionWithTurn, openApp } from './session.ts'
import { DOCK_BAR, waitForOffer } from './prompt-bar-offer.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** What the page ACTUALLY holds when the New-session plumbing would have worked — the bar leg's own
 * discipline (#135): a locator string is not a diagnosis. Written by a guarded pre-flight below. */
async function dumpPage(page: import('@playwright/test').Page, why: string): Promise<void> {
  try {
    const d = await page.evaluate(() => ({
      title: document.title,
      bodyChars: document.body.innerText.length,
      buttons: Array.from(document.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '').filter(Boolean).slice(0, 30),
      errors: Array.from(document.querySelectorAll('[role="alert"], .error')).map((el) => (el.textContent ?? '').slice(0, 120)).slice(0, 4),
      hash: location.hash.slice(0, 80),
    }))
    fs.writeFileSync(path.join(ROOT, 'var', 'e2e-revival-dom.json'), JSON.stringify({ why, ...d }, null, 1))
  } catch { /* the dump must never outrank the test it explains */ }
}

test.describe('a persisted off surviving a reload revives (#276)', () => {
  test('the mount pull fires despite the stale cached off', async ({ page }) => {
    test.setTimeout(600_000)
    await page.on('pageerror', (e) => { fs.appendFileSync(path.join(ROOT, 'var', 'e2e-revival-console.log'), `pageerror: ${String(e.message).slice(0, 200)}\n`); })
    // Same plumbing the bar legs use: a live session carried to a READY offer.
    let sessionId: string
    try {
      await openApp(page) // the helper clicks; it does not navigate — every bar spec opens first (the blank-page
      // witness that cost this investigation: bodyChars 0 was about:blank, not a dead boot)
      sessionId = await newSessionWithTurn(page, 'Reply with exactly: OK')
    } catch (error) {
      await dumpPage(page, `newSessionWithTurn failed: ${String((error as Error)?.message ?? error).slice(0, 120)}`)
      throw error
    }
    const bar = page.locator(DOCK_BAR)
    await waitForOffer(bar, page)

    // Manufacture the maintainer's state: a stale `off` mirror for THIS session, written after
    // the last honest pull — via addInitScript so it is in place BEFORE any app JS on the next
    // navigation, exactly how #272's persisted entry survived every reload.
    await page.addInitScript((id: string) => {
      try {
        window.localStorage.setItem(`dsh.chapters.promptState.${id}`, JSON.stringify({
          ev: { t: 'polled', status: 'off', text: '', turnSeq: null, error: '' },
          autorun: 'disarmed',
          at: Date.now() - 3_600_000,
        }))
      } catch { /* a storage still mounted: fine, the pull assertion below is the witness */ }
    }, sessionId)
    await page.reload({ waitUntil: 'domcontentloaded' })

    // Revival. Both claims matter and they are different: visibility proves the veto lost,
    // the reply seam proves a REAL pull answered (a cached render could never set it).
    const revived = page.locator(DOCK_BAR)
    await expect(revived, 'the bar revives despite the stale cached off').toBeVisible({ timeout: 30_000 })
    // The visible bar is the DISK-TAGGED CACHE RENDER (#272 renders immediately and pulls async);
    // reading the reply seam right now can race the pull itself. CI measured it: the first reply
    // read was EMPTY (the response had not landed) and the leg failed on MY timing, not the
    // product. Wait for the wire to answer; THEN name what it said.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __dshPromptReply?: string }).__dshPromptReply ?? ''),
      { timeout: 20_000, message: 'the mount pull must answer the reply seam — an empty seam is a race, not a revival' })
      .toMatch(/suggested next step/)
    const reply = await page.evaluate(() => (window as unknown as { __dshPromptReply?: string }).__dshPromptReply ?? '')
    // #304 taught this seam a fourth honest answer: a boot that released a zombie claim can make
    // the mount's first pull legitimately answer `off`. The claim guarded here is "the wire
    // answered", not the status — the waitForOffer below still refuses a cached veto, because a
    // dead render never yields a visible offer.
    expect(reply, 'the mount paid its one honest pull — the wire answered, not a cached render').toMatch(/suggested next step: (ready|analyzing|off|idle)/)
    await waitForOffer(revived, page)
  })
})
