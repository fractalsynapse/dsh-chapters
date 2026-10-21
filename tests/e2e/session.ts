import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Shared e2e session plumbing: specs create THEIR OWN session through the
 * real UI ('New session' → composer → one genuine Local-model turn) instead
 * of hunting legacy fixtures in a sidebar that has accumulated dozens of
 * probe sessions. Turn-complete is watched on the DURABLE plane (the engine
 * signature listener writes state.collections at every real turn/end — realm
 * info logs never reach stdout, r19), after the submit is confirmed on the
 * visible plane.
 */
export const ROOT = path.resolve(import.meta.dirname, '..', '..')
/** The throwaway per-boot home (port-keyed — see boot.ts); the port comes
 * from the boot record the setup just wrote. */
const bootPort = (): number => {
  try { return (JSON.parse(fs.readFileSync(path.join(ROOT, 'var', 'e2e-boot.json'), 'utf8')) as { port: number }).port } catch { return 41731 }
}
export const E2E_HOME = path.join(ROOT, 'var', `e2e-home-${bootPort()}`)
export const E2E_REGISTRY = path.join(E2E_HOME, 'storages', 'dsh_chapters.json')
// The app derives the per-project session dir by non-alphanumerically-slugging
// the workspace path; it must be COMPUTED, never literal (measured 2026-09-24:
// a hardcoded /home/adrian slug made every session-log read a silent '' on
// other machines — CI's model chains were fully replaying (turn/end on disk)
// while three specs polled an invisible log for 7 minutes each).
const sessSlug = (p: string): string => `-${(p.endsWith('/') ? p : p + '/').replace(/[^a-zA-Z0-9]/g, '-')}-`
export const E2E_SESS_DIR = path.join(E2E_HOME, 'sessions', sessSlug(ROOT))
const REGISTRY = E2E_REGISTRY
let zstdWarned = false // one loud zstd failure per process (see logHasEvent/sessionLogTextById catches)

/** total turn-signature collections across all sessions (the durable plane). */
export function collectionTotal(): number {
  try {
    const d = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as { tables?: { sessions?: Record<string, { collections?: unknown[] }> } }
    return Object.values(d.tables?.sessions ?? {}).reduce((n, st) => n + (st.collections?.length ?? 0), 0)
  } catch { return -1 }
}

export async function localModelUp(): Promise<boolean> {
  // Model-tape replay IS the model for this run: every turn is served from
  // tests/fixtures/model-tape, so real-server reachability is irrelevant.
  // A tape MISS answers loudly (proxy 503), never a silent skip — a CI box
  // without any 8080 must still RUN the suite, and it must FAIL if a tape is
  // missing. Only live/record runs ask the server the question.
  if ((process.env.E2E_MODEL ?? 'live') === 'replay') return true
  try {
    const r = await fetch('http://localhost:8080/v1/models', { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch {
    return false
  }
}

export async function openApp(page: Page): Promise<void> {
  const boot = JSON.parse(fs.readFileSync(path.join(ROOT, 'var', 'e2e-boot.json'), 'utf8')) as { url: string }
  await page.goto(boot.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  await dismissTestingNotice(page)
}

/**
 * Dismiss every notice dialog the host puts up, WHICHEVER one it shows.
 *
 * These dialogs are FOCUS TRAPS: while one is open, every click on the composer,
 * the sidebar and 'New session' silently bounces and `activeElement` stays on the
 * dialog (the 2026-09-18 saga was exactly this, with 'Internal Testing Notice').
 * #54 found the second member of the family: host 0.2.x opens a **Preview Notice**,
 * and a rig that dismisses one dialog BY NAME stops working the moment the host
 * ships a second — the failure surfaced as 'composer did not take focus (active:
 * Preview Notice)', hundreds of lines from the cause.
 *
 * Target the DIALOG, not "a div that mentions a notice": scanning ancestor divs
 * matches the whole app wrapper, whose button list includes unrelated controls — the
 * first cut pressed some other 'Close', reported success, and left the notice holding
 * focus (measured: the retry died with `dialog: Preview Notice: Continue` still on
 * screen). Press the control that ACKNOWLEDGES this dialog, repeat for stacked
 * notices, and let an unknown label be a no-op: the focus assert downstream still
 * fires, and the diagnostic names the dialog and its buttons.
 */
export async function dismissTestingNotice(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const dismissed = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [aria-label*="Notice"]'))
      for (const dlg of dialogs) {
        const buttons = Array.from(dlg.querySelectorAll('button'))
        if (buttons.length === 0) continue
        const ack = buttons.find((b) => /^continue$/i.test((b.textContent ?? '').trim()))
          ?? buttons.find((b) => /^(got it|i understand|acknowledge|dismiss|ok)$/i.test((b.textContent ?? '').trim()))
          ?? buttons.find((b) => /^close$/i.test((b.textContent ?? '').trim()) && (b.getAttribute('aria-label') ?? '').toLowerCase().includes('notice'))
        if (ack !== undefined) { (ack as HTMLButtonElement).click(); return true }
      }
      return false
    })
    if (!dismissed) return
    await page.waitForTimeout(800)
  }
}

/**
 * Focus the composer with a TRUSTED pointer click at its center — JS
 * .focus() never armed this editor (measured: text went nowhere) and the
 * actionability .click() stalls behind the app's tooltip layer (measured:
 * 7 minutes of 'visible, enabled and stable'). Then VERIFY the caret; fail
 * loud with the active element named — every silent step here cost a full
 * suite round this week.
 */
export async function focusComposer(page: Page): Promise<void> {
  // The composer's aria-label differs by session state ('Message or run a
  // task…' in a live conversation, 'Describe what you want to build…' in a
  // pristine-home draft — both measured); the '/ commands, @ files or
  // sessions' tail is the stable join.
  const composer = page.locator('div[aria-label*="/ commands, @ files or sessions"]')
  await composer.waitFor({ state: 'attached', timeout: 15_000 })
  const box = await composer.boundingBox()
  if (box === null) throw new Error('composer has no box')
  await page.mouse.click(box.x + Math.min(60, box.width / 2), box.y + box.height / 2)
  await page.waitForTimeout(400)
  const focused = await page.evaluate(() => {
    const ae = document.activeElement
    return ae !== null && (ae.matches('div[aria-label*="/ commands, @ files or sessions"]') || ae.closest('div[aria-label*="/ commands, @ files or sessions"]') !== null)
  })
  if (!focused) {
    const ae = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none')
    throw new Error(`composer did not take focus (active: ${ae})`)
  }
}

/**
 * Type via insertText (one real input event — contenteditable editors can
 * ignore synthetic keystroke streams) and submit VERIFIED: the send button
 * path worked on calm transcripts but silently failed after a heavy turn
 * (oversized-turn run 6: focus verified, message never arrived), so every
 * stage now checks itself and the Enter retry is a fallback that must also
 * show the text leaving the composer. Failures carry full diagnostics.
 */
export async function typeComposer(page: Page, line: string): Promise<void> {
  await focusComposer(page)
  await page.keyboard.insertText(line)
  const composerSel = 'div[aria-label*="/ commands, @ files or sessions"]'
  const needle = line.slice(0, 24)
  const editorState = await page.evaluate((a) => (document.querySelector(a.sel)?.textContent ?? 'ABSENT').slice(0, 60), { sel: composerSel, needle })
  if (!editorState.includes(needle)) throw new Error(`insertText did not reach the composer (head: ${editorState})`)
  const emptied = async (): Promise<boolean> => page.evaluate((sel) => (document.querySelector(sel)?.textContent ?? '').trim().length === 0, composerSel)
  const send = page.locator('button[aria-label="Send message"]')
  // r38-family flake, closed 2026-09-23: a single click/Enter can race the
  // composer's state settling (button still disabled, Enter swallowed by
  // slash-palette processing) — retry the ACTION, not just the observation.
  // A disabled Send button is usually LEGITIMATE busy-state: the previous
  // /command ran as a synthetic turn, and a cold-boot sync inside it can
  // hold the composer for tens of seconds (measured under coverage
  // instrumentation) — so the budget is minutes, and pressing Enter while
  // busy is a harmless no-op that the editor queues nothing for.
  for (let round = 0; round < 48; round += 1) {
    if (await emptied()) return
    const sendEnabled = await send.count() > 0 && await send.first().isEnabled().catch(() => false)
    if (sendEnabled) await send.first().click({ force: true }).catch(() => undefined)
    else await page.keyboard.press('Enter')
    for (let i = 0; i < 4 && !(await emptied()); i++) await page.waitForTimeout(500)
  }
  if (await emptied()) return
  const diag = await page.evaluate((sel) => {
    const btn = document.querySelector('button[aria-label="Send message"]')
    const b = btn?.getBoundingClientRect()
    const topAt = b !== undefined ? (document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.getAttribute('aria-label') ?? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.tagName ?? 'nil') : 'no-button'
    return { sendTop: topAt, disabled: (btn as HTMLButtonElement | null)?.disabled ?? 'absent', left: (document.querySelector(sel)?.textContent ?? '').slice(0, 40) }
  }, composerSel)
  throw new Error(`composer never emptied after send+Enter (send covered by: ${diag.sendTop}, disabled: ${String(diag.disabled)}, text left: "${diag.left}")`)
}

/**
 * The app keeps the live session's identity in localStorage
 * ('dsh.sessions.current' = {"sessionId":"ch-…"}) — the ONLY reliable
 * browser→disk join. File-mtime heuristics were tried first and each burned
 * a suite round (old sessions on the shared dev home rewrite 'freshest'
 * semantics; dir mtimes lie; and needle-matching transcript text collides
 * across reruns of the same scripted question).
 */
/** parsed events of a session log ('' file → []). Raw JSON kept for needles. */
export function logEvents(text: string): { seq: number; type: string; raw: string }[] {
  const out: { seq: number; type: string; raw: string }[] = []
  for (const line of text.split('\n')) {
    try { const e = JSON.parse(line); if (typeof e?.seq === 'number') out.push({ seq: e.seq, type: String(e?.type ?? ''), raw: line }) } catch { /* partial */ }
  }
  return out
}

/** The session id the log's own header declares (identity proof). */
export function logHeaderId(text: string): string | null {
  for (const line of text.split('\n')) {
    try { const e = JSON.parse(line); if (e?.type === 'session') return String(e?.id ?? '') } catch { /* keep scanning */ }
    break
  }
  return null
}

export async function currentSessionId(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    try { return (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? 'null') as { sessionId?: string } | null)?.sessionId ?? null } catch { return null }
  })
}

const SESS_DIR = E2E_SESS_DIR

/**
 * The durable session log inside one session dir, WHICHEVER format the host writes.
 *
 * #54: 0.2.x persists `session.v4.jsonl.zstd`; the rig hardcoded `session.v3…` and every
 * log-reading assertion silently returned '' — which reads as "the archive never landed"
 * and sends you hunting a product bug that lives in a filename. The resolver takes the
 * HIGHEST version present and refuses to guess when there is none.
 */
export function sessionLogFileFor(dir: string): string | null {
  let best: { file: string; v: number } | null = null
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return null }
  for (const n of names) {
    const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(n)
    if (m === null) continue
    const v = Number(m[1])
    if (best === null || v > best.v) best = { file: path.join(dir, n), v }
  }
  return best === null ? null : best.file
}

const sessDirs = (): string[] => { try { return fs.readdirSync(SESS_DIR) } catch { return [] } }

/** full decoded session log for a session id ('' until the file exists). */
export function sessionLogTextById(id: string): string {
  for (const dir of sessDirs()) {
    if (!dir.includes(id)) continue
    const f = sessionLogFileFor(path.join(SESS_DIR, dir))
    if (f === null) return '' // no durable log yet — an empty answer is honest here, a guess is not
    try { return execFileSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }) } catch (e) {
      if (!zstdWarned) { zstdWarned = true; console.error(`e2e: zstd failed reading session log ${dir}: ${String((e as Error)?.message ?? e).slice(0, 160)}`) }
      return ''
    }
  }
  return ''
}

/**
 * Discover a session by a fragment of its durable log — the way a CHILD created by a
 * plugin command is found without the UI ever switching to it. Poll-friendly: returns
 * null until the file exists and contains the fragment. `prefix` narrows the id space
 * (e.g. 'ch-' for continuation children).
 */
/** Session ids currently on disk with a given prefix — for "exactly one new child" checks. */
export function sessIdsWithPrefix(prefix: string): string[] {
  return sessDirs()
    .map((d) => (d.startsWith('ch-') ? d : d.replace(/^session-/, '')))
    .filter((id) => id.startsWith(prefix))
}

export function findSessionIdWhoseLogContains(fragment: string, prefix = ''): string | null {
  for (const dir of sessDirs()) {
    // dirs are `session-<uuid>` (parent) or `ch-<uuid>` (a created child)
    const id = dir.startsWith('ch-') ? dir : dir.replace(/^session-/, '')
    if (prefix !== '' && !id.startsWith(prefix)) continue
    if (sessionLogTextById(id).includes(fragment)) return id
  }
  return null
}

function sessionLogFile(sid: string): string | null {
  for (const dir of sessDirs()) {
    if (!dir.includes(sid)) continue
    const f = sessionLogFileFor(path.join(SESS_DIR, dir))
    return f !== null && fs.existsSync(f) ? f : null
  }
  return null
}

/** The session dir whose LOG FILE is freshest (dir mtimes lie — file
 * rewrites keep them at creation; measured thrice this week). */
export function freshestSessionLog(): { dir: string; file: string } | null {
  let best: { dir: string; file: string; m: number } | null = null
  for (const dir of sessDirs()) {
    const file0 = sessionLogFileFor(path.join(SESS_DIR, dir))
    if (file0 === null) continue
    const file = file0
    let m: number
    try { m = fs.statSync(file).mtimeMs } catch { continue }
    if (best === null || m > best.m) best = { dir, file, m }
  }
  return best === null ? null : { dir: best.dir, file: best.file }
}

export function logHasEvent(file: string, type: string, text?: string): boolean {
  let raw: Buffer
  try { raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 }) } catch (e) {
    // LOUD once: a missing zstd reads identical to "turn not finished" —
    // cost three hosted CI runs to learn (2026-09-24)
    if (!zstdWarned) { zstdWarned = true; console.error(`e2e: zstd failed on ${file}: ${String((e as Error)?.message ?? e).slice(0, 160)}`) }
    return false
  }
  for (const line of raw.toString('utf8').split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e?.type !== type) continue
      if (text === undefined) return true
      if (JSON.stringify(e).includes(text)) return true
    } catch { /* partial line */ }
  }
  return false
}

/**
 * Create a session via the top 'New session' button (JS-dispatched click —
 * the pointer path is tooltip-intercepted) and complete one real turn ON
 * THAT SESSION: identity from localStorage, turn-complete = its own log's
 * own turn/end. Returns the session id for downstream durable assertions.
 */
export async function newSessionWithTurn(page: Page, question: string, turnMs = 420_000, actionGraceMs = 20_000 | false): Promise<string> {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
      .find((b) => /New Session/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined
    btn?.click()
  })
  let sid: string | null = null
  for (let i = 0; i < 10 && sid === null; i++) {
    await page.waitForTimeout(1000)
    sid = await currentSessionId(page)
  }
  if (sid === null) throw new Error('new-session click never set dsh.sessions.current')
  // On a PRISTINE home the draft can render as an uncommitted 'Preview' pane
  // (composer absent from the DOM — measured): clicking its tree row commits
  // it. Conditional, so the warm-home path is untouched.
  try {
    await page.locator('div[aria-label*="/ commands, @ files or sessions"]').waitFor({ state: 'attached', timeout: 6_000 })
  } catch {
    await page.evaluate(() => {
      const it = Array.from(document.querySelectorAll('[role="treeitem"]'))
        .find((t) => /^New Session/.test((t.textContent ?? '').trim())) as HTMLElement | undefined
      it?.click()
    })
    await page.waitForTimeout(2500)
  }
  const preSeq = sid !== null ? Math.max(0, ...logEvents(sessionLogTextById(sid)).map((e) => e.seq)) : 0
  await typeComposer(page, question)
  await expect(page.getByText(question.slice(0, 30), { exact: false }).first(), 'user message rendered (submit worked)').toBeVisible({ timeout: 30_000 })
  // drafts can persist under a FRESH id on first submit — re-read after the
  // send and adopt a rotation (measured: pre-send localStorage is the draft)
  const rotated = await currentSessionId(page)
  if (rotated !== null && rotated !== sid) sid = rotated
  const needle = question.slice(0, 40)
  await expect.poll(() => {
    const text = sid !== null ? sessionLogTextById(sid) : ''
    if (text === '') return false
    const header = logHeaderId(text)
    if (header !== null && header !== sid) throw new Error(`identity mismatch: dir claims session ${header}, spec targets ${sid}`)
    const evs = logEvents(text)
    const mine = evs.find((e) => e.type === 'user/message' && e.seq > preSeq && e.raw.includes(needle))
    return mine !== undefined && evs.some((e) => e.type === 'turn/end' && e.seq > mine.seq)
  }, { timeout: turnMs, intervals: [5000] }, 'this session\u2019s own log shows turn/end').toBe(true)
  if (actionGraceMs !== false) {
    // Ensure the VIEW is on OUR session before UI assertions (measured 2026-09-24
    // on CI: the SPA navigated back to the previous spec's fork child during the
    // log-poll waits — the child's replayed rows carry no fork action, so the
    // assertion searched the wrong transcript). The tree row for our session is
    // labeled with our own question text; clicking it is the app's own path.
    const rowText = question.slice(0, 24)
    const own = page.locator('[role="treeitem"]', { hasText: rowText }).first()
    if (await own.isVisible().catch(() => false)) {
      await own.click()
      await page.waitForTimeout(1200)
    } else {
      console.warn(`e2e: no tree row matching "${rowText}" — asserting on whatever view is open`)
    }
    await expect(page.locator('button[aria-label="Fork with chapters"]').first(), 'assistant row exposes the fork action').toBeVisible({ timeout: actionGraceMs })
  }
  return sid
}
