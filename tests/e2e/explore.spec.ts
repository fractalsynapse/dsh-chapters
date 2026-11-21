import fs from 'node:fs'
import path from 'node:path'
import { test } from '@playwright/test'
import { openApp, newSessionWithTurn, localModelUp } from './session.ts'

/**
 * Surface-explore pass on a freshly created session (fixture-independent by
 * design). The turn question hard-caps tool calls (2026-09-25: live qwen
 * ignored the old three-read cap and looped reads past the 7-minute turn):
 * a cap the replayed chain must honor on every machine. dumps the interactive aria surface + message structure to
 * var/e2e-explore.json for selector archaeology when specs need updating.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..')

test('explore a live session with one real turn', async ({ page }) => {
  test.setTimeout(420_000)
  test.skip(!(await localModelUp()), 'Local model server not running')
  await openApp(page)
  // #222: `actionGrace: false`, exactly the a-knowledge-loop precedent, and the root cause is
  // the same one recorded there. Measured this session (probe on the live record, 2026-11-19):
  // the fresh draft's tree row reads `@treeseed/dsh-chapters` — the project basename — until
  // durable-title projection lands, and only THEN `What does the sync loop`; so the helper's
  // row-click navigation is at the mercy of an async title race. When the match misses, the
  // grace claim asserts on whatever view the SPA restored — the other session's transcript,
  // which correctly carries no fork action on its rows. That tested the view's navigation
  // history, not this fixture's subject. `fork-button.spec.ts` owns
  // 'assistant row exposes the fork action' and asserts it on the transcript where it applies;
  // this selector-archaeology dump never needed the claim.
  await newSessionWithTurn(page, 'What does the sync loop in src/sync.ts do? Read that file at most TWICE with the read tool, then immediately end your turn with one plain-text sentence. Tool calls beyond two reads are forbidden: after two reads you must answer in words.', 420_000, false)
  await page.waitForTimeout(2000)
  const dump = await page.evaluate(() => {
    const aria = Array.from(document.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label')!).filter((v, i, a) => a.indexOf(v) === i)
    const msgs = Array.from(document.querySelectorAll('[class*="essage"], article, [data-message-id]'))
      .slice(0, 40).map((el) => ({ tag: el.tagName, cls: (el.className ?? '').toString().slice(0, 70), text: (el.textContent ?? '').trim().slice(0, 60) }))
    return { url: location.href, aria: aria.slice(0, 80), msgs }
  })
  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-explore.json'), JSON.stringify(dump, null, 2))
})
