/**
 * Shared offer predicates for the Suggested Next Step bar legs (#135, #138).
 *
 * Two specs now read this bar — the tape-backed leg (`prompt-bar.spec.ts`) and the live-only goal legs
 * (`prompt-goal-live.spec.ts`). The definition of "the bar is showing a real suggestion and not a placeholder" is ONE
 * semantic decision, so it lives here once (AGENTS: one predicate per decision — the duplicate title predicate in #59
 * is what this rule exists to prevent).
 */
import { expect, type Locator, type Page } from '@playwright/test'

export const DOCK_BAR = 'div.dsh-chapters_promptDock[data-prompt-bar="true"]'

/** The visible offer line, or '' when the row is still in `Analyzing` / placeholder state. */
export async function offerText(bar: Locator): Promise<string> {
  const line = (await bar.innerText()).replace(/\s+/g, ' ')
  return /Recommended Next Step/.test(line) && !/No suggestion yet|Analyzing/.test(line) ? line : ''
}

/** Wait until the row carries a real suggestion. Generous: a bar's offer is a model call away. */
export async function waitForOffer(bar: Locator, page: Page): Promise<void> {
  await expect.poll(async () => (await offerText(bar)) !== '' ? 'offer' : 'waiting',
    { timeout: 200_000, intervals: [3_000] }).toBe('offer')
  void page
}
