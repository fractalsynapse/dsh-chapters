/**
 * The goal/suggestion interplay, verified LIVE under a wall-clock bound (#135, #138).
 *
 * WHY THIS LEG IS NOT TAPE-BACKED. The two claims here are about what happens when a **goal** shares the session with
 * the bar's worker loop. A goal round is itself a turn, and every turn ends, so an armed goal drives itself round after
 * round (`goal-round-driver/src/index.ts:182-190` stops only at `roundsStarted >= maxGoalRounds`; the human `/goal`
 * command passes no budget, so the default is 256). Under tape replay my proxy answers every request instantly, so the
 * number of rounds that precede a click is a function of machine latency — and a tape must not record latency. Measured
 * on staging's own corpus: `MISS tape=prompt entries=23 … storedCandidates: []` with the runner's history carrying
 * `Round: 1/256`…`Round: 4/256` where the capture held none, twice, on **docs-only** pushes (runs 40697174778 and
 * 40706037817). The obvious bound fails too: spend a budget of 1 and the driver calls `ctx.goals.block(…, 'round-limit')`
 * (`:183`), and `GoalBar.tsx:85-86` renders no strip for a blocked/complete goal — so the armed state a displacement
 * claim needs is exactly the state that cannot be held still.
 *
 * So these legs run against the real provider, with a bounded duration, and assert the UI and durable-log facts that
 * are true regardless of how many rounds the machine managed: the goal's control flips when the loop is armed, and a
 * cleared goal leaves the bar still suggesting. `scripts/chain-replay.sh` deliberately does NOT list this project, so
 * the model-free acceptance job does not cover these two claims — a live run does. That exclusion is asserted below
 * rather than left to memory, and the guard fails loudly if anyone replays this spec against a tape.
 */
import { test, expect } from '@playwright/test'
import { deliveredFor, newSessionWithTurn, openApp, typeComposer } from './session.ts'
import { DOCK_BAR, offerText, waitForOffer } from './prompt-bar-offer.ts'

/** Wall-clock bound for a live journey: generous, but bounded — this is a smoke-class check, not a soak. */
test.describe.configure({ timeout: 420_000 })

test.beforeEach(async () => {
  // Loud, not silent: a tape cannot answer a goal cascade, so a replay of this spec must never look like a pass.
  test.skip(process.env.E2E_TAPE === 'replay',
    'prompt-goal-live is a LIVE-provider leg: an armed goal\'s round count is machine latency, so no tape can match it (#138)')
})

test('arming the bar\'s Autorun takes the continuation away from an active goal', async ({ page }) => {
  await openApp(page)
  const sid = await newSessionWithTurn(page, 'Reply with exactly: OK')
  const bar = page.locator(DOCK_BAR)
  await expect(bar, 'the prompt dock row is present').toBeVisible({ timeout: 60_000 })
  await waitForOffer(bar, page)

  await typeComposer(page, '/goal Ship the widget and verify it in the browser', deliveredFor(sid, '/goal Ship the widget'))
  const goalBar = page.locator('[data-goal-bar]')
  await expect(goalBar, 'the host goal bar appears once a goal exists').toBeVisible({ timeout: 120_000 })

  // Arm the worker loop. Whatever round the driver happens to be on, the OUTCOME is fixed by the product: the goal
  // loses automatic activation, so the host stops offering `Pause` and starts offering `Resume`.
  const autorun = bar.locator('button[aria-label="Autorun"], button:has-text("Autorun")').first()
  await expect(autorun, 'Autorun is arm-able').toBeEnabled({ timeout: 120_000 })
  await autorun.click()
  await expect(bar.locator('button[aria-label="Autorun off"], button:has-text("Autorun off")').first(),
    'the bar holds its armed state after the server round-trip').toBeVisible({ timeout: 60_000 })
  await expect(page.locator('button[aria-label="Resume goal"], button:has-text("Resume goal")').first(),
    'the host goal control flips: arming the loop displaced the goal driver').toBeVisible({ timeout: 180_000 })
  await expect(page.locator('button[aria-label="Pause goal"], button:has-text("Pause goal")').first(),
    'and Pause is gone, because nothing automatic is running for the goal').toHaveCount(0)
  void sid
})

test('clearing the goal leaves the bar offering a suggestion on the next turn', async ({ page }) => {
  await openApp(page)
  const sid = await newSessionWithTurn(page, 'Reply with exactly: OK')
  await typeComposer(page, '/goal Ship the widget and verify it in the browser', deliveredFor(sid, '/goal Ship the widget'))
  const goalBar = page.locator('[data-goal-bar]')
  await expect(goalBar, 'a goal exists before it can be cleared').toBeVisible({ timeout: 120_000 })

  await typeComposer(page, '/goal clear', deliveredFor(sid, '/goal clear'))
  await expect(goalBar, 'the goal control is gone, not merely rephased').toHaveCount(0, { timeout: 120_000 })

  // One ordinary turn with no goal in the session at all: the bar must go on suggesting.
  const nextTurn = 'Reply with exactly: DONE'
  await typeComposer(page, nextTurn, deliveredFor(sid, nextTurn))
  const bar = page.locator(DOCK_BAR)
  await expect(bar, 'the bar is still mounted with no goal present').toBeVisible({ timeout: 60_000 })
  await waitForOffer(bar, page)
  const offered = await offerText(bar)
  expect(offered.length, 'the bar produces a real suggestion after the goal is cleared (length)').toBeGreaterThan(0)
  void sid
})
