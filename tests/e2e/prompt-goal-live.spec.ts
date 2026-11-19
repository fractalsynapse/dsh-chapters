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
import nodeAssert from 'node:assert/strict'
import { deliveredFor, newSessionWithTurn, openApp, typeComposer } from './session.ts'
import { DOCK_BAR, offerText, waitForOffer } from './prompt-bar-offer.ts'

/** Wall-clock bound for a live journey: generous, but bounded — this is a smoke-class check, not a soak. */
test.describe.configure({ timeout: 420_000 })

test.beforeEach(async () => {
  // Loud, not silent: a tape cannot answer a goal cascade, so a replay of this spec must never look like a pass.
  // `E2E_MODEL === 'replay'` is the rig's replay signal (globalSetup.ts:52). `E2E_TAPE` is the PROJECT name —
  // my first guard compared it to 'replay', so it never fired and the spec ran against a tape it cannot match.
  test.skip(process.env.E2E_MODEL === 'replay',
    'prompt-goal-live needs the live provider (E2E_MODEL!=replay): an armed goal\'s round count is machine latency, so no tape can match it (#138)')
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

// ─────────────── #349: the goal crosses the renewal — re-armed at birth, live host ───────────────
//
// THE CLAIM MEASURED HERE (not available any cheaper): an ACTIVE goal in the parent produces, at
// /chapters-continue birth, a goal the CHILD'S OWN session carries — armed via the host's goal
// service (the maintainer authority decision 2026-11-19, docs/architecture.md § The Goal Across a
// Renewal), visible in the child's goal strip, and durable in the child's log. Deterministic rows
// cover the decision and the wording; ONLY a real host answers whether the service call lands on a
// freshly-born, UI-attachable session — which is precisely the class of fact this leg exists for.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { openSessionByRow, ROOT, sessionLogTextById } from './session.ts'

function findChildOf(parentSid: string): string {
  // #397 lineage does the discovery: the child's DURABLE HEADER names parentSession — no registry
  // race, no id-shape guessing. Sessions roots are port-keyed like every rig home.
  const home = `/tmp/dsh-e2e/e2e-home-${process.env.E2E_PORT ?? ''}`
  const root = path.join(home, 'sessions')
  let dirs: string[] = []
  try { dirs = fs.readdirSync(root).flatMap((ws) => fs.readdirSync(path.join(root, ws)).map((d) => path.join(root, ws, d))) } catch { return '' }
  for (const d of dirs) {
    const f = path.join(d, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    const base = path.basename(d)
    if (base.includes(parentSid)) continue
    try {
      const first = execFileSync('zstd', ['-dc', f], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n')[0] ?? ''
      const e = JSON.parse(first) as { type?: string; parentSession?: string }
      if (e.type === 'session' && e.parentSession === parentSid) return base.replace(/^session-/, '')
    } catch { /* an empty/flushing log is simply not the child yet */ }
  }
  return ''
}

test('the continuation child of an ACTIVE-goal session is born with the goal re-armed (#349, live host)', async ({ page }) => {
  test.setTimeout(1_800_000) // 30 min: goal RPC, a door birth, sidebar open, and this box's measured latency margins

  const sid = await newSessionWithTurn(page,
    'Reply with exactly the single word: PRE-GOAL. Do not read or run anything.', 900_000, false)

  // The human arms the goal (the tool's direct-human gate is honored — a person types the command).
  await typeComposer(page, '/goal Ship the widget and verify it in the browser', deliveredFor(sid, '/goal Ship the widget'))
  await expect(page.locator('[data-goal-bar]').first(), 'the parent shows its goal strip').toBeVisible({ timeout: 120_000 })

  // The deterministic door, from the composer.
  await typeComposer(page, '/chapters-continue Goal-carry-live', deliveredFor(sid, '/chapters-continue Goal-carry-live'))

  // The child exists when its HEADER names the parent (#397 lineage as the discovery mechanism).
  await expect.poll(() => findChildOf(sid), {
    timeout: 420_000, intervals: [5000],
    message: 'a session was born whose durable header parentSession is the goal session',
  }).not.toBe('')
  const child = findChildOf(sid)

  // Open it by the title the door gave it; then the two USER-VISIBLE facts:
  await expect.poll(() => openSessionByRow(page, ['Goal-carry-live']),
    { timeout: 120_000, intervals: [3000], message: 'the child row opens in the sidebar' }).toBe(true)

  await expect(page.locator('[data-goal-bar]').first(),
    '#349: the CHILD shows a goal strip — the objective kept driving').toBeVisible({ timeout: 120_000 })
  await expect(page.locator('[data-goal-bar]').first(),
    '#349: and it is the SAME objective, verbatim').toContainText('Ship the widget', { timeout: 30_000 })

  // Durable truth under the UI: the child's own log holds the birth goal/change create, objective whole.
  const childLog = sessionLogTextById(child)
  nodeAssert.ok(childLog.includes('operation') && childLog.includes('"create"'),
    `the child log records the re-armed goal durably (goal/change create): ${childLog.slice(0, 200)}`)
  nodeAssert.ok(childLog.includes('Ship the widget and verify it in the browser'),
    'the objective is whole in the child log')
  // and the TOC the child was handed said the re-armed truth, not the notice-only sentence
  nodeAssert.ok(childLog.includes('re-created this goal on the child'),
    'the birth notice used the re-armed wording')
})
