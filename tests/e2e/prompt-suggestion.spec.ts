import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import {openApp, localModelUp, currentSessionId, sessionLogTextById, typeComposer, ROOT, deliveredFor} from './session.ts'
import { SUGGESTION, SUGGEST_TRIGGER } from './stub-model.ts'

/**
 * #71 prompt recommendations, in the browser: a session idles, the composer
 * ghost offers the second reader's next prompt, typing hides it, ArrowRight
 * accepts it into the draft, Enter sends it — and the durable log receives it as
 * an ordinary human message while the recommendation's own bytes stay OUT of
 * every chapter and every notice.
 *
 * CLIENT-PLANE FACTS THIS JOURNEY STANDS ON (measured, docs/contract.md §
 * Composer Ghost Layer):
 *  - the ghost is a `conversation.input.overlay` entry: a button named
 *    "Accept the suggested next prompt";
 *  - the composer editor is `div[aria-label*="/ commands, @ files or sessions"]`
 *    (session.ts's own selector), and `ArrowRight` is not claimed by the host
 *    keymap — our capture listener is the only consumer;
 *  - the tape's `suggest` requests are served by the SCRIPTED upstream's arm
 *    (tests/e2e/stub-model.ts, SUGGEST_TRIGGER) — the same scripted-distill
 *    precedent plans.spec.ts established. What this journey proves is the
 *    ghost's WIRE-UP in a real browser (slot registration, the command pull,
 *    the keystroke, the draft), not a trained model's taste in next steps.
 *
 * The boot carries `promptModel` in the plugin row (E2E_PROMPT=1, boot.ts
 * applyRigPluginPatch) — every other project boots WITHOUT it, and their
 * greenness is the OFF-state test: no ghost row ever renders there.
 *
 * Browser-plane claim status: the tape is distilled here; replay of the whole
 * nine-project chain stays gated by #56 (the corpus re-anchor). Landing this
 * spec adds a project to that re-distill list; it does not unblock it.
 */

const composerSel = 'div[aria-label*="/ commands, @ files or sessions"]'

/** Create a session and wait for its identity (r38: establish the session
 *  before exercising any command surface — draft screens SEND text). */
async function newSession(page: Page): Promise<string> {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
      .find((b) => /New Session/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined
    btn?.click()
  })
  let sid: string | null = null
  for (let i = 0; i < 15 && sid === null; i += 1) {
    await page.waitForTimeout(1000)
    sid = await currentSessionId(page)
  }
  if (sid === null) throw new Error('prompt-suggestion.spec: new-session click never set dsh.sessions.current')
  return sid
}

const editorText = (page: Page): Promise<string> =>
  page.evaluate((sel) => (document.querySelector(sel)?.textContent ?? 'ABSENT'), composerSel)

const ghost = (page: Page) => page.getByRole('button', { name: 'Accept the suggested next prompt' })

async function clearComposer(page: Page): Promise<void> {
  await page.click(composerSel)
  await page.keyboard.press('ControlOrMeta+KeyA')
  await page.keyboard.press('Backspace')
  await expect.poll(() => editorText(page), { timeout: 10_000 }).toBe('')
}

test('the ghost appears idle, hides on typing, accepts on ArrowRight, and reaches the log as a human message', async ({ page }) => {
  test.setTimeout(900_000)
  if (!(await localModelUp())) {
    throw new Error('prompt-suggestion.spec: no model upstream answers — start the scripted upstream (node tests/e2e/stub-model.ts) for record, or run under E2E_MODEL=replay. This journey must RUN.')
  }

  await openApp(page)
  const sid = await newSession(page)

  // One real turn so there is an idle boundary with a completed assistant reply.
  await typeComposer(page, 'Reply in one sentence: which file renders the chapter archive?', deliveredFor(sid, 'Reply in one sentence: which file renders the chapter archive?'))

  // The suggestion arrives via the composer pull — wait for the chip, generously:
  // on record, the auxiliary call runs live against the scripted upstream.
  await expect(ghost(page), `the ghost offers the second reader's line (trigger ${SUGGEST_TRIGGER})`)
    .toBeVisible({ timeout: 300_000 })
  await expect(ghost(page)).toContainText(SUGGESTION)

  // Typing hides it instantly — the ghost behaves like the placeholder it mirrors.
  await page.click(composerSel)
  await page.keyboard.insertText('t')
  await expect(ghost(page), 'one typed character wins over the suggestion').toBeHidden({ timeout: 5_000 })

  // Back to empty: the same boundary's offer returns (visibility is derived, not latched).
  await clearComposer(page)
  await expect(ghost(page), 'an emptied draft re-shows the unaccepted suggestion').toBeVisible({ timeout: 5_000 })

  // Boundary 1's dismissal gesture: Escape closes the offer for THIS boundary —
  // the chip stays gone even with the draft still empty (the reducer's `dismissed`
  // phase, proven in the browser next to the unit row).
  await page.click(composerSel)
  await page.keyboard.press('Escape')
  await expect(ghost(page), 'Escape dismisses for the boundary').toBeHidden({ timeout: 5_000 })
  await expect(ghost(page), 'a dismissed offer does not come back this boundary').toBeHidden({ timeout: 3_000 })

  // A real turn opens boundary 2 — and the next boundary RE-ARMS the offer.
  await typeComposer(page, 'One more sentence, no tools.', deliveredFor(sid, 'One more sentence, no tools.'))
  await expect(ghost(page), 'the next boundary re-offers').toBeVisible({ timeout: 300_000 })

  // The acceptance gesture: ArrowRight moves the suggestion into the draft — the
  // host's own InputActions.setDraft — and closes the offer. Nothing sent yet.
  await page.click(composerSel)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => editorText(page), { timeout: 5_000, message: 'ArrowRight accepted the draft' }).toBe(SUGGESTION)
  await expect(ghost(page), 'acceptance closes the offer').toBeHidden({ timeout: 5_000 })

  // Send it: it becomes an ordinary human message — the acceptance IS the decision.
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => sessionLogTextById(sid).includes(SUGGESTION), { timeout: 120_000, message: 'the accepted prompt reaches the durable log' })
    .toBe(true)
  await expect
    .poll(() => sessionLogTextById(sid).includes(SUGGEST_TRIGGER), { timeout: 60_000, message: 'the reader persona never reaches the log' })
    .toBe(false)

  // And it never masquerades as memory: nothing the ghost wrote is archived.
  // The store for THIS boot lives under the e2e home (rig isolation, #61).
  const tree = path.join(ROOT, 'var', `e2e-home-${process.env.E2E_PORT ?? '41739'}`, 'chapters', sid)
  const { existsSync, readdirSync, readFileSync } = await import('node:fs')
  if (existsSync(tree)) {
    const files = readdirSync(tree, { recursive: true, encoding: 'utf8' }).filter((f) => String(f).endsWith('.md'))
    const tainted = files.filter((f) => readFileSync(path.join(tree, String(f)), 'utf8').includes(SUGGEST_TRIGGER))
    expect(tainted, 'a recommendation is UI state, never an archived chapter').toEqual([])
  }
})
