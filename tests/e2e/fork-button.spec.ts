import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, localModelUp, sessionLogFileFor, E2E_REGISTRY, E2E_SESS_DIR } from './session.ts'

/**
 * The assistant-row door actions, on a session this spec CREATES through the
 * real UI with one genuine Local-model turn. Two planes of truth per
 * assertion: the durable registry/session log (what the plugin wrote) and
 * the browser (the reported defect this spec exists to keep fixed: after the
 * click, the app SWITCHES to the branch).
 *
 * Both deterministic doors have a row here: `/chapters-continue` shipped as a
 * composer command only, which made a pulled continuation look like nothing had
 * happened. One runner, two rows — src/client/doors.ts.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const registry = () => JSON.parse(fs.readFileSync(E2E_REGISTRY, 'utf8')) as
  { tables: { sessions: Record<string, { parentSession?: string | null }> } }
const childCount = () => Object.values(registry().tables.sessions).filter((s) => typeof s.parentSession === 'string').length
const sessDir = E2E_SESS_DIR

test('the fork action keeps its promises: ours visible, native hidden, click forks and SWITCHES', async ({ page }) => {
  test.setTimeout(420_000)
  test.skip(!(await localModelUp()), 'Local model server not running')
  await openApp(page)
  // The stimulus must be ONE sentence with no tool work, and the wording is load-bearing.
  // #54's first 0.2.x distill of this journey asked "which file implements…" and the
  // hosted model obeyed literally — it read files, the turn ran past the output limit, the
  // host rendered "Output token limit reached", and the assistant action row NEVER mounted,
  // so `toBeVisible` on our door timed out at 20s. Nothing was wrong with the door: the
  // probe with a one-sentence tool-free turn shows both rows live at 28x28 inside the
  // host's own action container (`EvIC1a_flowItem > TS9iAW_actions`). This is RR2=137's
  // lesson restated for a stronger model: a journey that depends on a wander-prone turn
  // fails for a reason that has nothing to do with what it asserts.
  await newSessionWithTurn(page, 'Name one HTTP redirect status code in one short sentence. Make ZERO tool calls and read no files.')

  await expect(page.locator('button[aria-label="Fork with chapters"]').first()).toBeVisible()
  // Both deterministic doors need a mouth: a composer-only `/chapters-continue`
  // left the user with a created child and no affordance at all.
  await expect(page.locator('button[aria-label="Continue with chapters"]').first()).toBeVisible()
  await expect(page.locator('button[aria-label="Branch into a new conversation"]')).toBeHidden()

  const before = childCount()
  await page.locator('button[aria-label="Fork with chapters"]').first().click()

  // durable plane: a linked child appears in the registry
  await expect.poll(() => childCount(), { timeout: 30_000, intervals: [500] }).toBeGreaterThan(before)
  // visible plane: the app switched to the branch (title carries it; a
  // plugin-sourced notice is context injection, not a chat bubble — by design)
  await expect.poll(() => page.title(), { timeout: 40_000, intervals: [1000] }).toMatch(/—|branch|composer|Which file/i)

  // the newest child's seed carries the TOC notice + chapter citations
  const { execFileSync } = await import('node:child_process')
  await expect.poll(() => {
    const kids = fs.readdirSync(sessDir)
      .filter((d) => d.startsWith('ch-') || d.startsWith('session-ch-'))
      .map((d) => ({ d, t: fs.statSync(path.join(sessDir, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const k of kids.slice(0, 3)) {
      try {
        const f = sessionLogFileFor(path.join(sessDir, k.d))
        if (f === null) continue
        const log = execFileSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        if (log.includes('chapters:toc') && log.includes('.dsh-chapters/')) return true
      } catch { /* partial */ }
    }
    return false
  }, { timeout: 20_000, intervals: [1000] }).toBe(true)
})
