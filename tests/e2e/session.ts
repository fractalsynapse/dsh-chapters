export async function dismissTestingNotice(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const dismissed = await page.evaluate(() => {
      // THE DIALOG, not "a div that mentions a notice". The first cut of this scanned
      // every div whose text matched /notice/ — which includes the app ancestors, whose
      // button lists contain unrelated controls: it clicked some other 'Close', reported
      // success, and left the Preview Notice holding focus (measured twice: the retry
      // failed with `dialog: Preview Notice: Continue` still on screen). Query the
      // dialogs themselves, and press the control that ACKNOWLEDGES this one.
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [aria-label*="Notice"]'))
      for (const dlg of dialogs) {
        const buttons = Array.from(dlg.querySelectorAll('button'))
        if (buttons.length === 0) continue
        const ack = buttons.find((b) => /^continue$/i.test((b.textContent ?? '').trim()))
          ?? buttons.find((b) => /^(got it|i understand|acknowledge|dismiss|ok)$/i.test((b.textContent ?? '').trim()))
          ?? buttons.find((b) => /^close$/i.test((b.textContent ?? '').trim()) && (b.getAttribute('aria-label') ?? '').toLowerCase().includes('notice'))
        if (ack !== undefined) { (ack as HTMLButtonElement).click(); return true }
      }
      return false
    })
    if (!dismissed) return
    await page.waitForTimeout(800)
  }
}
