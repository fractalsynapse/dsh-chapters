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
import { newSessionWithTurn } from './session.ts'
import { DOCK_BAR, waitForOffer } from './prompt-bar-offer.ts'

test.describe('a persisted off surviving a reload revives (#276)', () => {
  test('the mount pull fires despite the stale cached off', async ({ page }) => {
    test.setTimeout(600_000)
    // Same plumbing the bar legs use: a live session carried to a READY offer.
    const sessionId = await newSessionWithTurn(page, 'Reply with exactly: OK')
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
    const reply = await page.evaluate(() => (window as unknown as { __dshPromptReply?: string }).__dshPromptReply ?? '')
    expect(reply, 'the mount paid its one honest pull — the wire answered, not a cached render').toMatch(/suggested next step: (ready|analyzing|idle)/)
    await waitForOffer(revived, page)
  })
})
