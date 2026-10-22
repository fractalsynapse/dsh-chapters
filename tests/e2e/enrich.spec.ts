/**
 * P2 S6 — the enrichment scenario, end to end through the real UI and the
 * tape: /compact archives a chapter (deterministic, zero-token), then
 * /chapters-enrich run drives ONE ladder call (record §6.1) and the durable
 * plane must show it: model title + generated: provenance in the chapter
 * frontmatter, the verbatim body byte-identical, and a clean report.
 * The recording pass also captures the enrichment exchange into
 * tests/fixtures/model-tape/enrich; replays then prove the ladder plumbing without GPU.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {openApp, newSessionWithTurn, typeComposer, forkDoor, ROOT, E2E_STORE_ROOT} from './session.ts'

// #70 moved the rig's store into the port's own home; reading the workspace tree here made a
// successful archive look like a missing one (#56).
const storeRoot = E2E_STORE_ROOT

function chapterFile(sid: string): string {
  const dir = path.join(storeRoot, sid, 'chapters')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : []
  return files.length > 0 ? path.join(dir, files[0]!) : ''
}

test('an archived chapter enriches through the ladder with the body provably untouched', async ({ page }) => {
  test.setTimeout(900_000)
  await openApp(page)
  const sid = await newSessionWithTurn(page, 'What does the read tool do? One sentence, no tools.')
  // the message-level fork archives the parent's turn into chapters (the
  // proven P1 path); a 2K-token session has nothing /compact could archive
  // #54: was `.first().click({ force: true })` — force-masked exactly the stale-node trap
  // that cost the suite leg 25 minutes. The visible newest row is the affordance a user has.
  await forkDoor(page).click()
  await expect.poll(async () => chapterFile(sid), { timeout: 360_000, intervals: [2000] }).not.toBe('')
  const f = chapterFile(sid)
  const before = fs.readFileSync(f, 'utf8')
  const bodyBefore = before.slice(before.indexOf('\n---\n') + 5)

  await typeComposer(page, '/chapters-enrich run ')
  await expect.poll(() => {
    const now = chapterFile(sid)
    const text = now === '' ? '' : fs.readFileSync(now, 'utf8')
    return text.includes('generated:') ? 'yes' : ''
  }, { timeout: 420_000, intervals: [3000] }).toBe('yes')
  const after = fs.readFileSync(chapterFile(sid), 'utf8')
  expect(after).toContain('generated:')
  expect(after.slice(after.indexOf('\n---\n') + 5)).toBe(bodyBefore, 'the verbatim body must survive the sanctioned write')
  // exact provenance-chain shape (model name, newest-first) is proven at the
  // integration layer (enrich-wire.test.ts); the browser scenario proves the
  // ladder reached the durable plane through the real command + proxy path.
  expect(after).toMatch(/generated:|unvetted/, 'sanctioned write markers present')

  await typeComposer(page, '/chapters-enrich report ')
  await expect.poll(async () => (await page.textContent('body'))?.includes('pending'), { timeout: 60_000 }).toBe(true)
})
