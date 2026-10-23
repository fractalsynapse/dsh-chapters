import fs from 'node:fs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { openApp, newSessionWithTurn, localModelUp, sessionLogFileFor, forkDoor, currentSessionId, E2E_REGISTRY, E2E_SESS_DIR } from './session.ts'

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
// A fresh home has NO registry file until the first archive writes it — which is exactly
// what the poll below waits for. Throwing ENOENT on the first tick kills the poll on line 1
// and reports "the fork did nothing" when the truth is "nothing has been written yet"
// (from #54, same class as the v3/v4 log path). Absence is a zero, stated as a zero.
const registry = (): { tables: { sessions: Record<string, { parentSession?: string | null }> } } => {
  try {
    return JSON.parse(fs.readFileSync(E2E_REGISTRY, 'utf8')) as
      { tables: { sessions: Record<string, { parentSession?: string | null }> } }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { tables: { sessions: {} } }
    throw error
  }
}
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

  await expect(forkDoor(page)).toBeVisible()
  // Both deterministic doors need a mouth: a composer-only `/chapters-continue`
  // left the user with a created child and no affordance at all.
  await expect(page.locator('button[aria-label="Continue with chapters"]').first()).toBeVisible()
  await expect(page.locator('button[aria-label="Branch into a new conversation"]')).toBeHidden()

  const sid = await currentSessionId(page)
  assert.ok(sid !== null, 'the spec created a session, so the client must name it before the door is clicked')
  const before = childCount()
  await forkDoor(page).click()

  // durable plane: a linked child appears in the registry
  await expect.poll(() => childCount(), { timeout: 30_000, intervals: [500] }).toBeGreaterThan(before)
  // visible plane: the app switched to the branch (title carries it; a
  // plugin-sourced notice is context injection, not a chat bubble — by design)
  // #56: this assertion was VACUOUS and I nearly shipped a green on it. Every page title
  // contains the em dash separator, so it passed while the app had not switched at all — the
  // door's own note (`roster: MISSING, 1 sessions`) proved the truth. Name the session instead:
  // the client's published current session must be the child the reply announced.
  await expect.poll(async () => {
    const cur = await currentSessionId(page)
    // a continuation child is minted with the `ch-` prefix by continue-core; anything else
    // means the client moved somewhere unrelated, which is not a pass either
    return cur !== null && cur !== sid && cur.startsWith('ch-')
  }, { timeout: 60_000, intervals: [1000] }, 'the client switched to the child session').toBe(true)

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
        if (!log.includes('chapters:toc')) continue
        // #56/#57: `.dsh-chapters/` was the OLD dialect — since #70 each boot pins its own
        // store root (`<e2e home>/chapters`), so a literal here asserts a path the product no
        // longer writes and the run fails while the feature works. Verify the citation is
        // TRUE instead: take the chapter paths the notice names and require one to exist.
        // That is strictly stronger than a substring, and it survives any store location.
        const cites = [...log.matchAll(/([^\s"`'()\\]+chapters\/[^\s"`'()\\]+\.md)/g)].map((m) => m[1])
        const real = cites.some((c) => fs.existsSync(path.isAbsolute(c) ? c : path.join(ROOT, c)))
        if (cites.length > 0 && real) return true
      } catch { /* partial */ }
    }
    return false
  }, { timeout: 20_000, intervals: [1000] }).toBe(true)
})
