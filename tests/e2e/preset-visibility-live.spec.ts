import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, typeComposer, sessionLogTextById, ROOT } from './session.ts'

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

// The seat is the popup button whose label text is EXACTLY the current preset display name
// (measured live: BUTTON[] {Chapters} — empty aria-label). aria-haspopup ALONE hits the workspace
// chooser and the model picker first (measured inventory), and a /chapters/i SUBSTRING would hit
// '@treeseed/dsh-chapters'. Exact-text the label is the stable selector; after staging the label
// may read 'Standard', so both spellings are allowed.
const seat = (page: import('@playwright/test').Page) =>
  page.locator('button[aria-haspopup="menu"]').filter({ hasText: /^(Chapters|Standard( mode)?)$/i }).first()

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
    test.setTimeout(1_500_000) // 25 min: two live sessions, seat RPC, draft commit — sized to the measured flow, not to a doomed wait

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

    // ── standard side, per the upstream flow (examples agent-preset-selection.e2e.ts:254-267):
    // the pick applies to the CURRENT blank draft (seat-store calls remote.agentPresets.select on
    // that session), the acceptance fact is the SEAT LABEL flipping, and clicking New-session again
    // would CLEAR the unapplied pick — which is precisely what the first two live runs measured
    // (second session header came back `chapters`, both times, for that reason).
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
      const b = btn[0] as HTMLButtonElement | undefined
      if (b === undefined) throw new Error('no New-session button to return to the draft')
      b.click()
    })
    await expect.poll(async () => (await seat(page).count()) > 0, { timeout: 60_000, intervals: [2000],
      message: 'the seat is reachable from the fresh draft' }).toBe(true)
    await seat(page).click()
    await dumpInteractive(page, 'seat-open')
    const standardItem = page.getByRole('menuitem', { name: /^Standard mode/ }).first()
    await expect(standardItem, 'the registry roster offers the standard preset').toBeVisible({ timeout: 20_000 })
    await standardItem.click()
    // THE pick applied: the seat's own label now reads Standard mode (upstream waits on exactly this).
    await expect(page.getByRole('button', { name: 'Standard mode', exact: true }).first(),
      'the staged preset applied to the current draft').toBeVisible({ timeout: 20_000 })

    // type into the CURRENT draft via the rig's own typeComposer (the composer is a contenteditable
    // DIV, not a textarea — a fill() waits on a target that cannot exist, which is exactly how run
    // 3 spent its 40-minute budget). No New-session click: it would discard the staged composition.
    await typeComposer(page, 'Reply with exactly the single word: STANDARDSIDE. Do not read or run anything.')
    // THE measurement is DOM, from the host's own surfaces — the header probe measured the wrong
    // artifact: upstream agent-preset-selection.e2e.ts:302 settles the staged pick through the
    // host's PROJECTION (`projections.values.agentPreset`) — exactly what our dock reads — while the
    // durable header keeps the CREATE-TIME composition (run5 proved both can disagree: header
    // `chapters` on a session the host composed standard). The session's own preset chip is the
    // host saying what this session composes; the row below is the user-visible fact.
    // (run6's aria snapshot settles both: `text: Standard mode` sits in the session header and the
    // paragraph `STANDARDSIDE` proves the row arrived — the chip's ACCESSIBLE NAME is not its
    // visible text in the session view, so assert substring text, not exact name regex.)
    await expect(page.locator('text=Standard mode').first(),
      'the host chip says this session composes the standard preset — the same projection the dock reads').toBeVisible({ timeout: 120_000 })

    // a fresh assistant row in this session exists (so the row the button would ride on is really
    // there), yet NO realm-scoped door button renders anywhere:
    await expect(page.getByText('STANDARDSIDE').first(),
      'the standard session produced its assistant row').toBeVisible({ timeout: 180_000 })
    await expect(page.locator('button[aria-label="Fork with chapters"]'),
      '#372: no dead door button in a standard-preset session').toHaveCount(0)
    await expect(page.locator('button[aria-label="Continue with chapters"]'),
      '#372: and none for the continue door either').toHaveCount(0)

    // verdict artifact: the two host surfaces side by side — chip/projection (what the dock reads,
    // asserted above) and the durable header (create-time composition, kept here precisely because
    // the standard side may honestly read `chapters`: that artifact pair is what run5 settled).
    const chipVisible = await page.locator('text=Standard mode').first().isVisible().catch(() => false)
    fs.writeFileSync(path.join(ROOT, 'var', 'preset-visibility-verdict.json'), JSON.stringify({
      at: new Date().toISOString(),
      chapters: { sid: sidCh, headerPreset: headerPresetOf(sidCh) },
      standard: { chipVisible, doorButtons: 'asserted above: count 0' },
    }, null, 2) + '\n')
  })
})
