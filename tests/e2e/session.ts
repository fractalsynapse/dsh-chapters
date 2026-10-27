import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { e2eHome, rigMirrorRoot, rigStoreRoot } from './boot.ts'

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
// ONE derivation, from boot.ts (#89, third time this lesson has had to be learned here — the
// 2026-09-24 hardcoded-slug incident, #70's store root, and now the hermetic-home move). The specs
// used to rebuild the home path as `ROOT/var/e2e-home-<port>`; when boots moved to
// `E2E_HOME_ROOT` (tmpdir), every durable-log read returned '' — and a-knowledge-loop stalled
// twelve minutes on a turn that had completed, with my own new diagnostic reporting `home=[]`.
// A path a boot writes and a spec re-derives are ONE fact; two derivations are a drift waiting to
// look like a product bug.
export const E2E_HOME = e2eHome(bootPort())
export const E2E_REGISTRY = path.join(E2E_HOME, 'storages', 'dsh_chapters.json')
// The app derives the per-project session dir by non-alphanumerically-slugging
// the workspace path; it must be COMPUTED, never literal (measured 2026-09-24:
// a hardcoded /home/adrian slug made every session-log read a silent '' on
// other machines — CI's model chains were fully replaying (turn/end on disk)
// while three specs polled an invisible log for 7 minutes each).
const sessSlug = (p: string): string => `-${(p.endsWith('/') ? p : p + '/').replace(/[^a-zA-Z0-9]/g, '-')}-`
export const E2E_SESS_DIR = path.join(E2E_HOME, 'sessions', sessSlug(ROOT))
/**
 * Where THIS boot's chapters actually land. #70 pinned `artifactStoreRoot` per port (so the
 * rig stops writing 42 test trees into the project's own production `.dsh-chapters/`), but the
 * specs kept reading `ROOT/.dsh-chapters` — and then reported "the archive never landed" about
 * files that were sitting in the port store the whole time (#56: enrich waited 6 min, heavy 8).
 * One constant, derived exactly like `boot.rigStoreRoot`; a row pins that the two agree.
 */
// Same rule as the home above: derive it from boot, don't re-implement it and hope a row keeps the
// two honest. (#70 pinned the store root per port; the specs re-derived it and reported "the archive
// never landed" about files sitting in the port store.)
export const E2E_STORE_ROOT = rigStoreRoot(bootPort())
const REGISTRY = E2E_REGISTRY
let zstdWarned = false // one loud zstd failure per process (see logHasEvent/sessionLogTextById catches)

/** total turn-signature collections across all sessions (the durable plane). */
export function collectionTotal(): number {
  try {
    const d = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as { tables?: { sessions?: Record<string, { collections?: unknown[] }> } }
    return Object.values(d.tables?.sessions ?? {}).reduce((n, st) => n + (st.collections?.length ?? 0), 0)
  } catch { return -1 }
}

/**
 * A failed availability probe in a mode that NEEDS the model is a FAILURE, not a skip (#54's doctrine, and
 * the thing my previous commit claimed but did not do — the comment landed, the behaviour did not, and
 * `LEG=fork MODE=live` came back `1 skipped`, which reads as a pass to anyone scanning a log). `E2E_ALLOW_SKIP=1`
 * is the single explicit opt-out: for the rare run that genuinely means "skip legs I cannot serve".
 */
/**
 * A probe ANSWERS a question. `localModelUp` keeps returning the boolean, because `tape-proxy-upstream-key`
 * pins the remote branch's contract — "an unreachable remote must be a NO, never an assumed yes" — and
 * turning the answer into an exception made a probe function throw where a test asked whether the endpoint
 * was reachable. That was my error in `a45bc10`: the loudness is right, the place was wrong. It moves to
 * `requireModelForLeg()`, which runs when a leg is about to act on the answer.
 */
function unavailable(what: string): false {
  void what
  return false
}

/**
 * The loud half: called by a leg that is about to run against the model. A skip is legal only when the
 * operator said so (`E2E_ALLOW_SKIP=1`); otherwise an unreachable model FAILS the leg with the remedy,
 * because "# skipped" in a CI log is indistinguishable from "# passed" and that silence cost six of eight
 * projects once before (#54).
 */
export function requireModelForLeg(reachable: boolean, what: string): void {
  if (reachable || process.env.E2E_ALLOW_SKIP === '1') return
  throw new Error(`e2e: ${what} — this leg needs a reachable model and none is. Start it, or point the run at one `
    + '(E2E_UPSTREAM=http://host:port, or E2E_PROVIDER=harness for this host\'s own route), or set E2E_ALLOW_SKIP=1 '
    + 'to skip on purpose.')
}

export async function localModelUp(): Promise<boolean> {
  // Model-tape replay IS the model for this run: every turn is served from
  // tests/fixtures/model-tape, so real-server reachability is irrelevant.
  // A tape MISS answers loudly (proxy 503), never a silent skip — a CI box
  // without any 8080 must still RUN the suite, and it must FAIL if a tape is
  // missing. Only live/record runs ask the server the question.
  if ((process.env.E2E_MODEL ?? 'live') === 'replay') return true
  // HARNESS-NATIVE MODE: the route IS the host's own provider, resolved and credential-checked by the boot
  // (which refuses if the key cannot be found). Asking "is 8080 listening?" here is #54's exact bug reborn —
  // a probe pointed at an endpoint this run never uses, answering `false`, and the journey SKIPS while the
  // log reads as though nothing needed doing. Measured: `LEG=fork MODE=live E2E_PROVIDER=harness` came back
  // `1 skipped` for precisely this reason.
  if (process.env.E2E_PROVIDER === 'harness') return true
  // LIVE MODE MUST NOT QUIETLY SKIP (#54's lesson, finished): a leg that skips "because the model is not
  // running" reports as a pass to anyone scanning a log, and that is how six of eight projects went unrun for
  // a month. A failed probe in live mode is now a FAILURE naming the remedy, unless the operator opts out
  // explicitly with E2E_ALLOW_SKIP=1 — which is the only way a silent skip may happen again, and it is loud
  // in the code, not implied.
  const base = (process.env.E2E_UPSTREAM ?? '').trim().replace(/\/+$/, '')
  // #54: RECORD against a REMOTE endpoint. The guard asks "is the model this run talks
  // to reachable?" — and answering it by probing port 8080 alone made every remote
  // distill SKIP six of the eight projects silently (measured: the fork journey came
  // back as `1 skipped`, which reads like a pass to anyone scanning a log). A spec that
  // skips because it is looking at the wrong endpoint is a spec that is not run.
  if (base !== '' && !/^https?:\/\/(localhost|127\.|\[::1\])/.test(base)) {
    const key = (process.env.E2E_UPSTREAM_KEY ?? process.env.LOCAL_API_KEY ?? '').trim()
    try {
      const r = await fetch(`${base}/v1/models`, {
        ...(key !== '' ? { headers: { authorization: `Bearer ${key}` } } : {}),
        signal: AbortSignal.timeout(8000),
      })
      // ANY HTTP answer means an endpoint is there; 5xx means it is not usable. A 401
      // would already have been refused at boot when the key is missing.
      return r.status < 500
    } catch {
      return false
    }
  }
  // A LOCAL custom upstream (the scripted stub on its own port — #71's distill,
  // and any `E2E_UPSTREAM=http://127.0.0.1:<port>` run) must be probed AT THAT
  // PORT. Answering "is the model reachable?" by probing :8080 regardless is the
  // same silent-skip bug the remote branch above was fixed for — measured 2026-10-22:
  // the prompt journey refused to run TWICE with a healthy stub on :8081. The row in
  // tests/unit/tape-proxy-upstream-key.test.ts that pinned the old :8080-probe changed
  // with it, reason in its comment.
  const localBase = base !== '' && /^https?:\/\/(localhost|127\.|\[::1\])/.test(base) ? base : 'http://localhost:8080'
  try {
    const r = await fetch(`${localBase}/v1/models`, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch {
    return unavailable(`no model answered ${localBase}/v1/models`)
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
 * Does a session have a durable log on disk yet? (#54)
 *
 * Host 0.2.x persists a created-but-never-started child as a directory holding only
 * `session.lock`. Specs that assert on a child's notice bytes therefore cannot just
 * poll the file — the file is a fact about whether the session was STARTED, not about
 * what the child was seeded with. This helper names the distinction so each journey can
 * decide, explicitly, to open the child rather than wait for a write that will not come.
 */
export function durableLogExists(sessionId: string): boolean {
  for (const dir of sessDirs()) {
    if (!dir.includes(sessionId)) continue
    return sessionLogFileFor(dir) !== null
  }
  return false
}

/**
 * Open a session the way the product does: click its sidebar row.
 *
 * Same selector the client door uses (`src/client/doors.ts` openBranchRow —
 * role=treeitem matched by text, 'more sessions' expanded when the list is folded),
 * so the rig is exercising the real affordance instead of inventing one. Returns false
 * when no row matched — callers must say which child they could not open, never proceed
 * as if it had.
 */
export async function openSessionByRow(page: Page, needles: readonly string[]): Promise<boolean> {
  const clean = needles.filter((n) => n !== '').map((n) => n.toLowerCase())
  if (clean.length === 0) return false
  const rows = page.locator('[role="treeitem"]')
  for (let attempt = 0; attempt < 3; attempt++) {
    const n = await rows.count()
    for (let i = 0; i < n; i++) {
      const t = ((await rows.nth(i).textContent()) ?? '').toLowerCase()
      if (clean.some((needle) => t.includes(needle))) {
        await rows.nth(i).click()
        await page.waitForTimeout(1200)
        return true
      }
    }
    // the list can be folded; the door clicks the expander before giving up
    const expanded = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('button'))
        .filter((b) => /more sessions|ungrouped/i.test(b.textContent ?? '') && b.getAttribute('aria-expanded') !== 'true')
      for (const b of buttons) b.click()
      return buttons.length
    })
    if (expanded === 0) break
    await page.waitForTimeout(400)
  }
  return false
}

/**
 * The fork door as a USER would click it: the NEWEST assistant row, visible.
 *
 * `.first()` picks the OLDEST message's row — harmless in a one-turn journey, and a
 * 25-minute dead click in a long one (#54, the `suite` leg), because once the conversation
 * moves on that node is no longer the actionable one and Playwright waits for
 * actionability that never comes. One helper, both specs, so the two journeys cannot drift
 * back into different selectors for the same affordance.
 */
export const forkDoor = (page: Page) => page.locator('button[aria-label="Fork with chapters"]:visible').last()

/**
 * Type via insertText (one real input event — contenteditable editors can
 * ignore synthetic keystroke streams) and submit VERIFIED: the send button
 * path worked on calm transcripts but silently failed after a heavy turn
 * (oversized-turn run 6: focus verified, message never arrived), so every
 * stage now checks itself and the Enter retry is a fallback that must also
 * show the text leaving the composer. Failures carry full diagnostics.
 */
/**
 * Is a HUMAN turn already in the durable log? #81: `typeComposer` used the editor's own emptiness
 * as proof of delivery, and the host clears the draft on its own schedule — a late flush made it
 * press again and one session got the same instruction twice (`STILL-HERE` at seq 40 and again at
 * seq 47). A `user/message` carrying the text is the only authority, and pointedly NOT an
 * assistant echo: a model repeating a phrase must not be read as the human's send having landed.
 */
/**
 * How many times does this instruction appear as a human turn? (#88)
 *
 * Counting, not existing. `deliveredFor` below needs "did THIS press land", and existence answers a
 * different question — "has something like this ever been sent" — which silently swallowed the
 * second of two identical instructions. A replay of the knowledge journey stalled for sixteen
 * minutes on exactly that: the spec runs `/chapters-status` twice, the guard saw the first record,
 * and the second send never happened.
 *
 * #84 still holds: the WHOLE instruction, not a window. An 80-character prefix made two prompts that
 * open alike ("…then answer." vs "…then summarize it.") indistinguishable. A swallowed send is worse
 * than a duplicate: a duplicate is visible in the log, this is silent.
 */
/**
 * Session ids present in the boot's home, newest directory first. This is the discovery side of
 * "the durable log decides" (#77-class, cold home): the SPA's own id can name a directory that was
 * never committed, and then no predicate over the log can ever see the turn that did land.
 */
export function listRecentSessionIds(): string[] {
  const out: Array<{ id: string, mtime: number }> = []
  for (const dir of sessDirs()) {
    const base = path.basename(dir)
    const m = /^(session|ch|sub)-/.exec(base)
    if (m === null) continue
    let mtime = 0
    try { mtime = fs.statSync(dir).mtimeMs } catch { continue }
    out.push({ id: base.slice(m[1]!.length + 1).split('--')[0] ?? base, mtime })
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.id)
}

export function countHumanMessagesCarrying(logText: string, needle: string): number {
  if (logText === '' || needle === '') return 0
  const want = needle.trimEnd()
  let n = 0
  for (const line of logText.split('\n')) {
    if (!line.includes('"user/message"')) continue
    try {
      const ev = JSON.parse(line) as { data?: { message?: { content?: unknown }, content?: unknown } }
      // Nested-first with a flat fallback, the same shape rule `unwrapEvent` carries for the gateway: the host
      // wraps composer-authored messages as `data.message`, while a message a plugin injected through
      // `agent.followup` is stored FLAT (`{id, role, source, content}`). Measured on the Run test: the offer
      // was in the log the whole time (seq 34) and this reader could not see it. Reading one shape and
      // calling the absence a failure is the error this repo has been bitten by repeatedly.
      const c = ev?.data?.message?.content ?? ev?.data?.content
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? (c as Array<{ text?: string }>).map((b) => b?.text ?? '').join(' ') : ''
      if (text.includes(want)) n += 1
    } catch { /* a partial write is not a delivery */ }
  }
  return n
}

/** How many times has this slash command reached the host? Its record is a `command/run`, not a
 *  chat bubble — and a journey may legitimately run the same command twice (#88). Full args, not a
 *  prefix, so two different invocations of one command are never conflated. */
export function countCommandsDispatched(logText: string, name: string, args: string): number {
  if (logText === '') return 0
  const want = args.trim()
  let n = 0
  for (const line of logText.split('\n')) {
    if (!line.includes('"command/run"')) continue
    try {
      const ev = JSON.parse(line) as { data?: { name?: string, args?: string } }
      if (ev?.data?.name !== name) continue
      if (want === '' || (ev?.data?.args ?? '').trim() === want) n += 1
    } catch { /* ignore a partial line */ }
  }
  return n
}

/** Did a human turn carrying this exact instruction reach the log? One predicate per decision: the
 *  boolean is the count, never a parallel implementation of the same question. */
export function humanMessageCarries(logText: string, needle: string): boolean {
  return countHumanMessagesCarrying(logText, needle) > 0
}

/** Did this command reach the host? Same rule: derived from the count. */
export function commandDispatched(logText: string, name: string, args: string): boolean {
  return countCommandsDispatched(logText, name, args) > 0
}

/** Total deliveries of this instruction in this session, right now. */
export function countDeliveries(sid: string | null, line: string): number {
  if (sid === null || sid === '') return 0
  const text = sessionLogTextById(sid)
  if (text === '') return 0
  const trimmed = line.trim()
  if (trimmed.startsWith('/')) {
    const name = (trimmed.slice(1).split(/\s+/)[0] ?? '')
    return countCommandsDispatched(text, name, trimmed.slice(1 + name.length))
  }
  return countHumanMessagesCarrying(text, trimmed)
}

/**
 * The predicate `typeComposer` needs at EVERY call site, built from the session it is typing into.
 *
 * #81 wired this only for the first turn of `newSessionWithTurn` and left the follow-ups and slash
 * commands unguarded — which is how the re-anchored `heavy` tape recorded a duplicated instruction:
 * record-time the race sent twice, only one answer got recorded, and replay asked a question the tape
 * has no entry for. A guard covering one of N call sites is a coin flip.
 *
 * #88 is the other half of the same lesson: the guard must ask **"has THIS press landed?"** So the
 * closure snapshots how many copies existed when it was created and compares counts thereafter. A
 * second identical instruction is a real instruction; existence-based delivery swallowed it, and a
 * knowledge-loop replay stalled sixteen minutes waiting for a command that was never sent.
 */
export function deliveredFor(sid: string | null, line: string): () => boolean {
  const baseline = countDeliveries(sid, line)
  return () => countDeliveries(sid, line) > baseline
}

/**
 * Which session does a send actually live in? (#77's lesson, turned on the rig.)
 *
 * A pristine home commits a draft under a FRESH id while `dsh.sessions.current` keeps reporting the
 * draft, so a spec that trusts the view watches a log nothing was ever written to. Measured on the
 * cold home: the instruction landed at seq 10 and `turn/end` at seq 42 — 28 seconds, well inside the
 * 12-minute poll — in `session-c553d23b…`, while the spec was watching `session-105939e9…`, a log
 * with no human turn at all. The durable log decides; candidates are only where to look.
 *
 * Exported and injected (`readLog`) so a row can prove it without a browser or a host: `null` when
 * nothing carries the turn (the caller keeps its current target and the poll fails honestly), and the
 * FIRST candidate that actually holds the message when one does.
 */
export function adoptSessionForTurn(opts: {
  candidates: Array<string | null>
  needle: string
  readLog: (id: string) => string
  /** Newest-first session ids present in the home. The view's ids are a hint; on a cold home they
   *  can name directories that do not exist at all (measured on the rules leg: the committed
   *  session was `2304a071…` with the question at seq 10 and `turn/end` at 21, while the view
   *  offered ids with no log — a finished turn was polled for twelve minutes). Discovery is what
   *  makes "the durable log decides" literal instead of a preference. */
  discover?: () => string[]
}): string | null {
  const want = opts.needle.trimEnd().slice(0, 40)
  const pool = [...opts.candidates]
  if (opts.discover !== undefined) {
    try {
      for (const id of opts.discover()) if (id !== '' && !pool.includes(id)) pool.push(id)
    } catch { /* a listing failure must not turn a stall into a crash */ }
  }
  for (const c of pool) {
    if (c === null || c === '') continue
    let text = ''
    try { text = opts.readLog(c) } catch { text = '' }
    if (text !== '' && humanMessageCarries(text, want)) return c
  }
  return null
}

export async function typeComposer(page: Page, line: string, delivered?: () => boolean | Promise<boolean>): Promise<void> {
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
  const alreadyDelivered = async (): Promise<boolean> => {
    if (delivered === undefined) return false
    try { return await delivered() } catch { return false }
  }
  // #84: a press is not a delivery until the durable log has had its chance to say so. record and
  // replay differ in WHEN the write lands, so a single read of the log answers differently for the
  // same action — the nondeterminism that made the suite tape record five requests where the
  // journey makes six. Wait it out, then decide.
  const deliveredGraceMs = async (ms: number): Promise<boolean> => {
    if (delivered === undefined) return false
    const deadline = Date.now() + ms
    for (;;) {
      if (await alreadyDelivered()) return true
      if (Date.now() >= deadline) return false
      await page.waitForTimeout(500)
    }
  }
  for (let round = 0; round < 48; round += 1) {
    // #81: the durable delivery predicate is checked FIRST, before any further press. The
    // editor's own state is a hint about the future, not a record of the past — that inversion
    // is what sent one instruction twice.
    if (await alreadyDelivered()) return
    if (await emptied()) return
    // after the FIRST press only: give the durable write a window before pressing again, so a slow
    // flush cannot manufacture a duplicate (#81) and a fast one cannot hide a swallowed send (#84)
    if (round === 0 && await deliveredGraceMs(4_000)) return
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

/**
 * Every session directory this boot owns — FULL paths.
 *
 * Two bugs, both measured today, both of the "silent empty read" family this file has been written to refuse:
 * (1) the old version returned `fs.readdirSync(SESS_DIR)` — BARE NAMES — while its callers did
 * `fs.statSync(dir)` and `path.basename(dir)`, resolving those names against the process cwd. Discovery was
 * therefore empty everywhere, and the give-up diagnostic printed `home=[]` even in runs whose assertions were
 * passing;
 * (2) `SESS_DIR` is `sessSlug(ROOT)`, but the app slugs the SESSION's workspace, and on a throwaway home that
 * is the host's default workspace directory, not the repository. In the working copy the two coincide often
 * enough to hide it; from a clone at any other path every durable-log read returns '' — which is exactly how a
 * completed turn (`needle` at seq 10, `turn/end` at seq 43) polled blind for 720 seconds.
 *
 * The home is per-port and disposable, so EVERY workspace directory inside it belongs to this boot: prefer the
 * ROOT slug for determinism, and union the rest instead of assuming the slug matches.
 */
/**
 * Pure core of `sessDirs`, exported so the two failure modes it fixes are TESTED rather than asserted in a
 * comment: bare-name returns (which callers `statSync` against the process cwd, so discovery is silently empty)
 * and a workspace slug that cannot match because the app slugs the SESSION's workspace, not the repository root.
 * A home is per-port and disposable, so every workspace directory inside it belongs to this boot: `preferred`
 * sorts first for determinism, the rest are unioned rather than ignored.
 */
export function sessDirsIn(base: string, preferred: string): string[] {
  let wsDirs: string[] = []
  try { wsDirs = fs.readdirSync(base) } catch { return [] }
  // Preferred FIRST, and ONLY if it yields nothing do we look further. The wider union I introduced today made
  // a `prompt` leg throw `identity mismatch: dir claims session X, spec holds Y`: discovery could now see a
  // DIFFERENT workspace's transcripts inside the same disposable home, so adoption could hand back a session the
  // spec never opened. A fallback is not a licence to mix homes (AGENTS.md: one journey, one boot).
  const scan = (dirNames: string[]): string[] => {
    const out: string[] = []
    for (const w of dirNames) {
    const wsPath = path.join(base, w)
    let names: string[] = []
    try { names = fs.readdirSync(wsPath) } catch { continue }
    for (const n of names) {
      if (!/^(session|ch|sub)-/.test(n)) continue
      const full = path.join(wsPath, n)
      try { if (fs.statSync(full).isDirectory()) out.push(full) } catch { /* vanished between readdir and stat */ }
    }
    }
    return out
  }
  const own = scan([preferred])
  if (own.length > 0) return own
  return scan(wsDirs.filter((w) => w !== preferred))
}

const sessDirs = (): string[] =>
  sessDirsIn(path.join(E2E_HOME, 'sessions'), path.basename(SESS_DIR))

/** full decoded session log for a session id ('' until the file exists). */
export function sessionLogTextById(id: string): string {
  for (const dir of sessDirs()) {
    if (!dir.includes(id)) continue
    const f = sessionLogFileFor(dir)
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
/**
 * The session id a directory represents. Parents are `session-<uuid>` and their id is the uuid; children keep
 * their own prefix (`ch-`, `sub-`) because specs filter on it. Deriving this from a BASENAME matters: `sessDirs()`
 * returns absolute paths, so testing a raw path for a `ch-` start is never true and a created child becomes invisible
 * to the rig (measured 2026-10-27: the plans leg polled 240s for a continuation whose seed was on disk and
 * carried the plan — a false red about the product, caused by our own read).
 */
/**
 * Do these two spellings denote the same session?
 *
 * The durable log writes the session event's id WITH the `session-` prefix; the view (`dsh.sessions.current`) and
 * `sessionIdFromDir` hand back the bare uuid for parents while children keep `ch-`/`sub-`. A guard that compares
 * the raw strings therefore fires on a spelling — measured as `identity mismatch: dir claims session
 * session-2ba8…, spec targets 2ba8…` on the bar's own leg, a false red on the exact journey that is supposed to
 * be trustworthy. A child prefix is NOT a spelling difference: `ch-x` and `x` are different sessions, so the
 * guard still fires there.
 */
export function sameSessionId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false
  const norm = (x: string): string => (x.startsWith('session-') ? x.slice('session-'.length) : x)
  const [na, nb] = [norm(a), norm(b)]
  // Children keep their prefix deliberately: stripping it would equate a parent with its continuation.
  return na === nb && (a.startsWith('ch-') || a.startsWith('sub-')) === (b.startsWith('ch-') || b.startsWith('sub-'))
}

export function sessionIdFromDir(dir: string): string {
  const name = path.basename(dir)
  return name.startsWith('session-') ? name.slice('session-'.length) : name
}

export function sessIdsWithPrefix(prefix: string): string[] {
  return sessDirs()
    .map(sessionIdFromDir)
    .filter((id) => id.startsWith(prefix))
}

export function findSessionIdWhoseLogContains(fragment: string, prefix = ''): string | null {
  for (const dir of sessDirs()) {
    // dirs are `session-<uuid>` (parent) or `ch-<uuid>` (a created child)
    const id = sessionIdFromDir(dir)
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
/**
 * The preset a session actually COMPOSED WITH, read from its own durable header.
 *
 * #56/#77, the find of the week: the profile pinned the preset under a row id the 0.2.x host no
 * longer mounts (`agent-presets` survives only as a client UI section; the registry row is
 * `agent-preset-registry`, whose `defaultId` is `selectedDefault ?? default`). Patch layers merge
 * by id, so the row was inert, every boot ran `standard`, and the legs then waited 8 minutes for
 * chapters that the realm had no engine to write — a product-shaped conclusion from an
 * un-mounted product. The header is the cheapest possible place to see the truth, so the rig now
 * looks, and says so in one sentence instead of an hour of polling.
 */
export function agentPresetFromLog(logText: string): string | null {
  for (const line of logText.split('\n').slice(0, 4)) {
    try {
      const e = JSON.parse(line) as { type?: string, agentPreset?: string }
      if (e?.type === 'session') return e.agentPreset ?? null
    } catch { /* a partial write; keep looking at the next line */ }
  }
  return null
}

/** The words the tripwire says — a pure function so a unit row can read them without a browser. */
export function presetMismatchMessage(sessionId: string, actual: string | null, expected: string): string {
  return (
    `e2e: session ${sessionId} composed with agentPreset=${JSON.stringify(actual)}, not "${expected}" — `
    + 'the chapters realm (persona, ChaptersCompactionEngine, arrival-time artifacting, the turn/end signature '
    + 'listener that first writes the registry) is NOT mounted in this boot, so every compaction-dependent '
    + 'assertion below would be measuring an absent product. Fix: the profile pin must reach the row the pinned '
    + 'host mounts — `- id: agent-preset-registry` with `selectedDefault: chapters` — and the realm config must '
    + 'be pinned on `preset-chapters` (tests/e2e/rig-preset-pin.ts); see issues #56/#77.'
  )
}

/** The precondition every chapters journey needs, asserted BEFORE its polls. */
export function assertChaptersPreset(sessionId: string, expected = 'chapters'): void {
  const preset = agentPresetFromLog(sessionLogTextById(sessionId))
  if (preset === expected) return
  throw new Error(presetMismatchMessage(sessionId, preset, expected))
}

/**
 * Did a `/chapters-* report` command actually run and say something durable?
 *
 * #56 (`enrich`): the DOM poll for the word `pending` failed while the child's own log held
 * `…pending: 0 chapter(s)` — the command ran, the surface just wasn't showing it, because the
 * 0.2.x conversation list virtualizes. An assertion cannot tell "the feature is broken" from
 * "the text is offscreen" unless it also reads the durable record, so it now does: predicate over
 * decoded log text, wrapper that walks whatever sessions this boot created.
 */
export function commandResultSaysPending(logText: string): boolean {
  if (logText === '') return false
  for (const line of logText.split('\n')) {
    if (!line.includes('"command/done"')) continue
    // Both report shapes carry the word: `pending: 0 chapter(s)` and `…; 0 pending`. No `\b`
    // on the left: in a JSON-encoded log line a newline is the two characters `\n`, so
    // `\npending` has a word character before it and a word-boundary pattern silently misses
    // the exact case this predicate exists to catch (measured with a direct call). The
    // `command/done` guard above is what keeps this from matching human text.
    if (line.includes('pending')) return true
  }
  return false
}

/**
 * Read ONE session's durable log by DIRECTORY path. Split out because the helper below used
 * `sessionLogTextById(name)`, which resolves against the boot-port-derived home this module
 * computed at import time — so pointed at any other tree it silently found nothing and returned
 * false forever. A gate that can never pass is worse than a missing gate: it looks like the
 * feature is broken.
 */
export function decodeSessionLogAt(sessionDir: string): string {
  const f = sessionLogFileFor(sessionDir)
  if (f === null) return ''
  try { return execFileSync('zstd', ['-dc', f], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }) } catch { return '' }
}

export function reportPendingInDurableLog(dir: string = E2E_SESS_DIR): boolean {
  let entries: string[] = []
  try { entries = fs.readdirSync(dir) } catch { return false }
  for (const name of entries) {
    const text = decodeSessionLogAt(path.join(dir, name))
    if (text !== '' && commandResultSaysPending(text)) return true
  }
  return false
}

/**
 * How many host commands the composer ghost ran in this session (#79).
 *
 * The number is the point: with the feature OFF, the honest count is zero, and it was 4–26 per
 * session because an effect depended on `props`. A durable count is the only assertion that
 * survives a UI that looks correct while it polls.
 */
export function countGhostCommandRuns(logText: string): number {
  if (logText === '') return 0
  let n = 0
  for (const line of logText.split('\n')) {
    if (!line.includes('"command/run"')) continue
    if (/"name":\s*"chapters-prompt"/.test(line)) n += 1
  }
  return n
}

/**
 * #83's ratchet caught a real latent bug here: `actionGraceMs = 20_000 | false` was parsed as a
 * BITWISE OR (evaluating to 20000), so the inferred parameter type was `number`, every `false` call
 * site was a type error, and the `actionGraceMs !== false` branch below could never have run.
 * A union needs a type annotation, not a pipe in the default position.
 */
export async function newSessionWithTurn(page: Page, question: string, turnMs = 420_000, actionGraceMs: number | false = 20_000): Promise<string> {
  // Every journey that needs a real turn arrives here, so this is where the skip becomes a failure. The
  // probe stays a yes/no question (rows depend on that); the CONSEQUENCE of "no" lives here, where a leg is
  // about to run blind. `E2E_ALLOW_SKIP=1` is the only way a leg declines without failing.
  requireModelForLeg(await localModelUp(), 'no reachable model for this journey')
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
  // #81: pass the authority down. If the durable log already carries this instruction as a
  // human turn, the send landed — pressing again is what duplicated it last night.
  await typeComposer(page, question, () => {
    if (sid === null) return false
    const t = sessionLogTextById(sid)
    return t !== '' && humanMessageCarries(t, question)
  })
  await expect(page.getByText(question.slice(0, 30), { exact: false }).first(), 'user message rendered (submit worked)').toBeVisible({ timeout: 30_000 })
  // drafts can persist under a FRESH id on first submit — re-read after the
  // send and adopt a rotation (measured: pre-send localStorage is the draft)
  // #77's lesson, applied to the rig itself: the VIEW is not the truth. On a PRISTINE home the
  // draft commits under a fresh id and `dsh.sessions.current` keeps reporting the draft — measured
  // on the cold home: the needle landed at seq 10 and `turn/end` at seq 42 (28 s later, comfortably
  // inside the poll) in session `c553d23b…`, while the spec watched `105939e9…`, a session that
  // contains no human turn at all. So adoption must come from the durable log, with the view only as
  // a hint. On warm homes the two agree and nothing changes.
  const rotated = await currentSessionId(page)
  const adopted = adoptSessionForTurn({
    candidates: [sid, rotated, await currentSessionId(page)],
    needle: question,
    readLog: sessionLogTextById,
    discover: listRecentSessionIds,
  })
  if (adopted !== null) sid = adopted
  const needle = question.slice(0, 40)
  const turnSeen = (): boolean => {
    // #77-class, and the measurement that ended three guesses: adoption used to run ONCE, right after
    // the send — when the committed session often does not exist yet. The poll then watched the
    // draft's (empty) log for twelve minutes while the turn completed in `session-5eb0bb60…`
    // (needle at seq 10, `turn/end` at 39: a passing run that no predicate could see). The log
    // decides for the WHOLE wait, so re-resolve on every interval, not just the first.
    if (sid === null || sessionLogTextById(sid) === '' || !humanMessageCarries(sessionLogTextById(sid), needle)) {
      const again = adoptSessionForTurn({
        candidates: [sid],
        needle: question,
        readLog: sessionLogTextById,
        discover: listRecentSessionIds,
      })
      if (again !== null) sid = again
    }
    const text = sid !== null ? sessionLogTextById(sid) : ''
    if (text === '') return false
    const header = logHeaderId(text)
    if (header !== null && !sameSessionId(header, sid)) throw new Error(`identity mismatch: dir claims session ${header}, spec targets ${sid}`)
    const evs = logEvents(text)
    const mine = evs.find((e) => e.type === 'user/message' && e.seq > preSeq && e.raw.includes(needle))
    return mine !== undefined && evs.some((e) => e.type === 'turn/end' && e.seq > mine.seq)
  }
  try {
    await expect.poll(turnSeen, { timeout: turnMs, intervals: [5000] }, 'this session\u2019s own log shows turn/end').toBe(true)
  } catch (error) {
    // #61a, aimed at the rig: a poll that gives up after twelve minutes must not leave "which of
    // these four facts was wrong?" to a stranger with a zstd binary. This exact message is what
    // turned three guesses about the cold-home stall into one measurement.
    const homes = listRecentSessionIds().slice(0, 4).map((id) => {
      const text = sessionLogTextById(id)
      if (text === '') return `${id}=unreadable`
      const evs = logEvents(text)
      const hit = evs.find((e) => e.type === 'user/message' && e.raw.includes(needle))
      return `${id.slice(0, 18)}(maxSeq=${String(evs.reduce((m, e) => Math.max(m, e.seq), 0))},hasNeedle=${hit !== undefined}${hit !== undefined ? `@${String(hit.seq)}` : ''},turnEnds=${evs.filter((e) => e.type === 'turn/end').map((e) => String(e.seq)).join('|') || 'none'})`
    })
    console.error(`e2e: turn poll failed after ${String(turnMs)}ms — sid=${String(sid)} preSeq=${String(preSeq)} needle=${JSON.stringify(needle)} home=[${homes.join(' ')}]`)
    throw error
  }
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
  // #56/#77 PRECONDITION, before any journey polls anything: did this session actually compose
  // with the chapters preset? A durable log can take a moment to flush, so this waits for a
  // READABLE header and then asserts the value — it never waits for the value to become true.
  await expect.poll(() => sessionLogTextById(sid) !== '', { timeout: 60_000, intervals: [2000] },
    `session ${sid} never produced a durable log to read its preset from`).toBe(true)
  assertChaptersPreset(sid)
  return sid
}
