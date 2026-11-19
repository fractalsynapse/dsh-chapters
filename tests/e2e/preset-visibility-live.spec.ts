import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, sessionLogTextById, ROOT } from './session.ts'

/**
 * #372 — the door buttons follow the COMPOSED PRESET, measured in the browser on BOTH sides.
 *
 * The defect: the two realm-scoped door rows rendered in EVERY session, because the client
 * injected them with no preset gate — in a non-chapters session they resolve to nothing, and the
 * old note was a generic "the branch call failed": a dead button by design. The fix reads the
 * host's OWN per-session projection (`projectionValues.agentPreset` — the exact fact
 * `dsh-client-ui-agent-preset`'s seat renders) and hides the rows when the preset RESOLVES to
 * something else; when the fact is unreadable the rows stay and the click answers with a refusal
 * that names the chapters preset realm (fail-open VISIBLY — UNKNOWN is never guessed either way).
 *
 * This leg is LIVE-CLASS by the same law as prompt-goal-live (#138): the journey needs the hero
 * seat's real roster RPC (`remote.agentPresets.select`) and a model reply per session — its request
 * count is machine behavior, not tape-stable. It skips LOUDLY under replay; the deterministic half
 * lives in tests/unit/client-doors.test.ts (#372 rows). Recorded through the translating proxy
 * (E2E_PROVIDER=harness, MODE=record) like every honest live run since #416 — the recording dir is
 * a byproduct, never corpus (excluded in the e2e-pins coverage gate exactly like the other live legs).
 *
 * Both halves are asserted as user-visible facts, per the acceptance:
 *   chapters side — the seat starts staged on the deployment's selected default; the new session's
 *     header carries `agentPreset: chapters` AND the *Fork with chapters* button renders on the
 *     assistant row (the exact selector fork-button.spec depends on — it may not drift).
 *   standard side — re-stage the seat to the registry's other preset ('standard' is the rig's
 *     registered DEFAULT), send a tiny reply turn, and the SAME button is ABSENT from that
 *     session's row while its durable header says `agentPreset: standard` — the button vanished for
 *     a reason the archive itself records.
 */

const seat = (page: import('@playwright/test').Page) => page.locator('button[aria-haspopup="menu"]')

async function dumpInteractive(page: import('@playwright/test').Page, phase: string): Promise<void> {
  const inv = await page.evaluate(() => {
    const out: string[] = []
    for (const el of Array.from(document.querySelectorAll('button,[role=menuitem],[role=combobox],select'))) {
      const a = el.getAttribute('aria-label') ?? ''
      const t = (el.textContent ?? '').trim().slice(0, 60)
      if (a !== '' || t !== '') out.push(`${el.tagName}[${a}] {${t}}`)
    }
    return out
  })
  // eslint-disable-next-line no-console
  console.log(`[preset-visibility] ${phase} inventory: ${JSON.stringify(inv).slice(0, 2400)}`)
}

function headerPresetOf(sid: string): string | null {
  try {
    const log = sessionLogTextById(sid)
    for (const line of log.split('\n')) {
      try {
        const e = JSON.parse(line) as { type?: string; agentPreset?: string }
        if (e.type === 'session') return typeof e.agentPreset === 'string' ? e.agentPreset : null
      } catch { /* partial */ }
    }
    return null
  } catch { return null }
}

test.describe('door buttons follow the composed preset (#372)', () => {
  test.skip(process.env.E2E_MODEL === 'replay',
    'preset-visibility-live is a live-class leg: the seat roster RPC and a reply per session are machine behavior, not tape-stable (#138 class). Run with E2E_PROVIDER=harness.')

  test('chapters session renders the door rows; a standard session does not', async ({ page }) => {
    test.setTimeout(2_400_000) // 40 min: two live sessions, seat RPC, and the roster wait margins this box has measured

    await openApp(page)

    // ── The seat exists on this deployment at all? Loud, not silent: without it BOTH halves of the
    // acceptance would pass vacuously (absent buttons everywhere!). Dump the inventory so a selector
    // drift reads as evidence, not as a mystery.
    await expect.poll(async () => (await seat(page).count()) > 0,
      { timeout: 60_000, intervals: [2000], message: 'the hero agent-preset seat renders on the draft screen' }).toBe(true)
    await dumpInteractive(page, 'draft')

    // ── chapters side first: new session with the seat at its staged default.
    const sidCh = await newSessionWithTurn(page,
      'Reply with exactly the single word: CHAPTERSIDE. Do not read or run anything.',
      900_000, false)
    await expect.poll(() => headerPresetOf(sidCh), { timeout: 60_000, intervals: [2000],
      message: 'the durable header records the chapters preset' }).toBe('chapters')
    // The row action — same label fork-button.spec selects on (pinned by client-doors rows as sacred).
    await expect(page.locator('button[aria-label="Fork with chapters"]').first(),
      'the realm-scoped button renders in a chapters session').toBeVisible({ timeout: 60_000 })

    // ── standard side: go back to the draft, re-stage the seat, create the session.
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
      const b = btn[0] as HTMLButtonElement | undefined
      if (b === undefined) throw new Error('no New-session button to return to the draft')
      b.click()
    })
    await expect.poll(async () => (await seat(page).count()) > 0, { timeout: 60_000, intervals: [2000],
      message: 'the seat is reachable from the fresh draft' }).toBe(true)
    await seat(page).first().click()
    // Menu items render through the host Menu with per-option name spans; dump for selector honesty.
    await dumpInteractive(page, 'seat-open')
    const standardItem = page.locator('[role=menuitem]', { hasText: /standard/i }).first()
    await expect(standardItem, 'the registry roster offers the standard preset').toBeVisible({ timeout: 20_000 })
    await standardItem.click()
    await page.waitForTimeout(1500) // the select RPC lands; the seat label repaints

    const sidStd = await newSessionWithTurn(page,
      'Reply with exactly the single word: STANDARDSIDE. Do not read or run anything.',
      900_000, false)
    await expect.poll(() => headerPresetOf(sidStd), { timeout: 60_000, intervals: [2000],
      message: 'the durable header records the standard preset — the fact the dock reads' }).toBe('standard')

    // THE measurement: a fresh assistant row in this session exists (so the row the button would
    // ride on is really there), yet NO realm-scoped door button renders anywhere.
    await expect.poll(() => sessionLogTextById(sidStd).includes('STANDARDSIDE'),
      { timeout: 120_000, intervals: [2000], message: 'the standard session produced its assistant row' }).toBe(true)
    await expect(page.locator('button[aria-label="Fork with chapters"]'),
      '#372: no dead door button in a standard-preset session').toHaveCount(0)
    await expect(page.locator('button[aria-label="Continue with chapters"]'),
      '#372: and none for the continue door either').toHaveCount(0)

    // verdict artifact: which header facts and which counts, whichever way the run landed
    fs.writeFileSync(path.join(ROOT, 'var', 'preset-visibility-verdict.json'), JSON.stringify({
      at: new Date().toISOString(),
      chapters: { sid: sidCh, headerPreset: headerPresetOf(sidCh) },
      standard: { sid: sidStd, headerPreset: headerPresetOf(sidStd) },
    }, null, 2) + '\n')
  })
})
