/**
 * Shared offer predicates for the Suggested Next Step bar legs (#135, #138).
 *
 * Two specs read this bar now — the tape-backed leg (`prompt-bar.spec.ts`) and the live goal legs
 * (`prompt-goal-live.spec.ts`) — so "what counts as a real suggestion" lives here once (AGENTS: one predicate per
 * semantic decision; #59 is what happens when a second copy drifts). The two functions are deliberately DIFFERENT, and
 * were: `offerText` reads the offer element itself, while `waitForOffer` reads the whole row's text because it is
 * testing the row's *state* (an `Analyzing`/placeholder row must not pass as an offer). Collapsing them into one cost a
 * capture — my first extraction rewrote `offerText` against `bar.innerText()` and the "Run submits" test failed on the
 * very next record.
 */
import { expect, type Locator, type Page } from '@playwright/test'

export const DOCK_BAR = 'div.dsh-chapters_promptDock[data-prompt-bar="true"]'

/** The offer's own text — the suggestion a user could act on, not the row's chrome. */
export async function offerText(bar: Locator): Promise<string> {
  return (await bar.locator('.dsh-chapters_promptText').first().innerText()).trim()
}

/** Wait until the row carries a real recommendation — `idle`/`analyzing` are honest states, not offers. */
export async function waitForOffer(bar: Locator, page: Page): Promise<void> {
  await expect.poll(async () => {
    const line = (await bar.innerText()).replace(/\s+/g, ' ')
    return /Recommended Next Step/.test(line) && !/No suggestion yet|Analyzing/.test(line) ? 'offer' : 'waiting'
  }, { timeout: 200_000, intervals: [3_000] } // the claim: an offer, not a placeholder line
  ).toBe('offer')
  void page
}
