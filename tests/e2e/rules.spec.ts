/**
 * P3 S6 — the rule lifecycle end to end in the browser, over a local-path
 * pool: add (proposed) -> approve (per-machine fact) -> real turn (tape) ->
 * UI fork -> the CHILD's own log carries the rule verbatim inside the
 * notice. The child's first durable event is the strongest possible proof:
 * the notice bytes the child session actually starts from.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import {openApp, newSessionWithTurn, typeComposer, E2E_SESS_DIR, sessionLogFileFor, openSessionByRow, durableLogExists, deliveredFor} from './session.ts'

const RULE_TEXT = 'Never log raw tokens or bearer headers anywhere in command output'

function childLogWithRule(after: Set<string>): string {
  // r39 mystery, solved 2026-09-22: session logs are DIRECTORIES containing a
  // zstd-compressed session.v<N>.jsonl.zstd (resolved, not hardcoded — #54) — the original readFileSync of a
  // directory entry always threw, so this poll could never succeed regardless
  // of product behavior. Decompress via the same zstd route session.ts uses.
  let dirs: string[] = []
  try { dirs = fs.readdirSync(E2E_SESS_DIR) } catch { return '' }
  for (const dir of dirs) {
    if (after.has(dir) || !dir.startsWith('ch-')) continue
    try {
      const f = sessionLogFileFor(path.join(E2E_SESS_DIR, dir))
      if (f === null) continue
      const t = execFileSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      if (t.includes('CORE RULES') && t.includes(RULE_TEXT)) return dir
    } catch { /* not flushed yet */ }
  }
  return ''
}

test('a rule proposed and approved in the UI renders verbatim into the next continuation', async ({ page }) => {
  test.setTimeout(900_000)
  await openApp(page)
  // commands need a REAL session to render flow nodes into — the draft screen
  // turns composer text into a first message, not a command (r38 lesson)
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-rules-pool-'))
  const sid = await newSessionWithTurn(page, 'Reply with exactly one short sentence naming an HTTP redirect status code. Make ZERO tool calls.')
  await typeComposer(page, `/chapters-link ${path.join(pool, 'pool.git')} `, deliveredFor(sid, `/chapters-link ${path.join(pool, 'pool.git')} `))
  await expect.poll(async () => ((await page.textContent('body')) ?? '').includes('pool'), { timeout: 120_000 }).toBe(true)

  await typeComposer(page, `/chapters-rule add security ${RULE_TEXT}`, deliveredFor(sid, `/chapters-rule add security ${RULE_TEXT}`))
  await expect.poll(async () => ((await page.textContent('body')) ?? '').includes('proposed'), { timeout: 60_000 }).toBe(true)
  // approve the id add actually returned (rule files are write-once; a dirty
  // store advances the number — hard-coding 001 would approve a different rule)
  const ruleId = await expect.poll(async () => {
    const m = /rule (\S+\/\d{3}) proposed/.exec((await page.textContent('body')) ?? '')
    return m?.[1] ?? ''
  }, { timeout: 30_000 }).not.toBe('')
  void ruleId
  const approveTarget = /rule (\S+\/\d{3}) proposed/.exec((await page.textContent('body')) ?? '')?.[1] ?? ''
  await typeComposer(page, `/chapters-rule approve ${approveTarget} `, deliveredFor(sid, `/chapters-rule approve ${approveTarget} `))
  await expect.poll(async () => ((await page.textContent('body')) ?? '').includes('CORE on THIS machine'), { timeout: 60_000 }).toBe(true)

  const before = new Set<string>((() => { try { return fs.readdirSync(E2E_SESS_DIR) } catch { return [] } })())
  await page.locator('button[aria-label="Fork with chapters"]').first().click({ force: true })

  // #54 (host 0.2.x): a created child does not persist a durable log until something
  // STARTS it. The door created the child — its directory exists, holding a 0-byte
  // `session.lock` and nothing else — and the poll below then waited ten minutes for
  // bytes that would never arrive. That is NOT a licence to weaken the assertion: the
  // notice is the whole point of the journey, and reading it from a file is the strong
  // form of the claim. So the journey now does what a user does — open the child —
  // using the SAME selector the product's own door uses (`src/client/doors.ts`
  // openBranchRow: role=treeitem by title, with 'more sessions' expansion), and only
  // if opening still flushed nothing does it start a turn in the child. Either way the
  // assertion after this point is unchanged: the child's own durable log must carry
  // CORE RULES and the rule text verbatim.
  // The child is a fact on disk BEFORE it is a sentence in the page: the door creates the
  // session and its success text lands asynchronously (measured — reading
  // textContent('body') immediately after the click found no 'is session ch-…' at all).
  // So the id comes from the filesystem; the title comes from the page as a BEST EFFORT,
  // because the sidebar row is labelled by title, and a missing title only costs one
  // matching string, not the run.
  await expect.poll(() => {
    try { return fs.readdirSync(E2E_SESS_DIR).some((d) => !before.has(d) && d.startsWith('ch-')) } catch { return false }
  }, { timeout: 120_000, intervals: [1500] },
    'no child session directory appeared after the fork door').toBe(true)
  const childId = fs.readdirSync(E2E_SESS_DIR).find((d) => !before.has(d) && d.startsWith('ch-')) ?? ''
  const doorText = (await page.textContent('body')) ?? ''
  const childTitle = /branch “([^”]+)” is session/.exec(doorText)?.[1]
    ?? /branch "([^"]+)" is session/.exec(doorText)?.[1] ?? ''
  const opened = durableLogExists(childId) ? false : await openSessionByRow(page, [childId, childId.replace(/^ch-/, ''), childTitle])
  let childDir = ''
  const pollRule = async (): Promise<string> => { childDir = childLogWithRule(before); return childDir }
  // If no row existed, the child was NEVER STARTED — and typing a turn now would send it
  // to whatever session the UI IS showing (measured: the fallback below typed into the
  // parent and the wait then blamed the notice). Say what is missing instead: on host
  // 0.2.0-rc.2 the fork door created the child (its directory exists, holding only a
  // 0-byte session.lock) but the client's open path never surfaced it — the projection
  // cache had no entry for it either, so the sidebar could not list what the store never
  // saw. That is a client-plane finding to chase in src/client/doors.ts, not something
  // this journey should paper over by acting on the wrong session.
  if (!opened && !durableLogExists(childId)) {
    throw new Error(`the fork door produced child ${childId} but nothing could open it — no sidebar row, no durable log `
      + '(host 0.2.x: a created child is not started, so it is neither listed nor persisted; see docs/backlog.md)')
  }
  await expect.poll(pollRule, { timeout: 180_000, intervals: [2000] },
    `the child's durable log never carried the rule (opened=${String(opened)}, child ${childId}) — `
    + 'either the notice lost the rule tier or this host does not persist a child that has been started').not.toBe('')
  const childFile = sessionLogFileFor(path.join(E2E_SESS_DIR, childDir))
  expect(childFile, `no durable session log under ${childDir} — the rig cannot read the host's log format`).not.toBeNull()
  const text = execFileSync('zstd', ['-dc', childFile as string], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  expect(text).toContain('CORE RULES')
  expect(text).toContain(RULE_TEXT)
  fs.rmSync(pool, { recursive: true, force: true })
})
