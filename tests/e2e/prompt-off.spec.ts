/**
 * The switch's other half (#113): a boot with **no** `promptModel` must show no bar at all.
 *
 * This is a separate project on a separate port (`prompt-off`) rather than a conditional inside the ON leg,
 * because a test that only runs when its own fixture is absent can never fail. `promptModel` is the single
 * existence switch, so the OFF state is a real supported configuration — and "supported" means asserted.
 */
import { test, expect } from '@playwright/test'
import { newSessionWithTurn, openApp } from './session.ts'

const DOCK_BAR = 'div.dsh-chapters_promptDock[data-prompt-bar=\"true\"]'

test('a session with no defining model gets no suggested-next-step bar', async ({ page }) => {
  test.skip(process.env.E2E_PROMPT === '1', 'this leg is the OFF state by construction')
  await openApp(page)
  await newSessionWithTurn(page, 'Reply with exactly: OK')
  // Absent, not merely hidden: a node that exists and is invisible would still be a component the switch
  // failed to keep off, and it would render its CSS and its poll.
  await expect(page.locator(DOCK_BAR), 'no promptModel means the dock row is never mounted').toHaveCount(0)
})
