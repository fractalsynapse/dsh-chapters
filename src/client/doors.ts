/**
 * The client door runner: the two deterministic archive doors, executed over
 * `remote.commands` and followed by a SWITCH to the fresh child.
 *
 * ONE runner, two rows. The server side keeps the same discipline — both doors
 * come from `deterministicCommand(door)` in src/tools.ts, and a unit row pins
 * that they archive identically. Copy-pasting this body is how the two would
 * drift apart, so there is exactly one implementation and a table of rows.
 *
 * `chapters-continue` ships only as a composer command; without a button here
 * the child is created correctly and the UI shows nothing, which reads as
 * "nothing happened". The row is the missing affordance, not new logic.
 *
 * React-free on purpose: the primitives package pulls CSS modules the node
 * test runner cannot load, so the testable half lives here and index.ts is the
 * thin chrome that renders these rows as buttons (tests/unit/client-doors.test.ts).
 *
 * @module dsh-chapters/src/client/doors
 */

/** Structural slice of the aggregated remote service (@deepseek-ai/dsh-api-remotes).
 * `remote.commands` must ALSO appear in inject — the federation gates each
 * sub-service individually (the live feedback package declares
 * remote.messageFeedback beside remote for exactly this reason). */
export interface ClientRemote {
  commands?: {
    execute(sessionId: string, line: string, attachments: readonly unknown[]): Promise<{
      ok?: boolean
      value?: { commandId?: string; result?: { kind?: string; text?: string } }
      error?: { code?: string; message?: string }
    }>
  }
}

/** The client sessions service (dsh-client-runtime): open() lives on the
 * prototype; everything else on the surface stays untrusted and unused. */
export interface ClientSessions {
  open(sessionId: string): unknown
}

export interface DoorResult {
  ok: boolean
  message: string
}

/**
 * One assistant-action row. `noun` is the server's own word for the child in
 * its success text (`branch` / `continuation`), so the fallback wording and the
 * title regex both track the door without a second implementation.
 */
export interface DoorAction {
  /** The slot registration id. */
  id: string
  /** Position in the assistant action row. */
  order: number
  /** Button + tooltip label, and the accessible name the e2e specs select on. */
  label: string
  /** The host command this row executes — the ONLY semantic difference at runtime. */
  command: string
  /** The noun in `${noun} “title” is session ch-…`. */
  noun: string
  /** The row's glyph (16×16 viewBox, single path). */
  iconPath: string
}

export const DOOR_ACTIONS: readonly DoorAction[] = [
  {
    id: 'chapters-fork',
    order: 30,
    label: 'Fork with chapters',
    command: '/chapters-fork',
    noun: 'branch',
    iconPath: 'M5 3.25a2.25 2.25 0 1 0-1.5 2.12v5.26a2.25 2.25 0 1 0 1.5 0V9h5a2.25 2.25 0 0 0 2.25-2.25v-1.4a2.25 2.25 0 1 0-1.5 0v1.4A.75.75 0 0 1 10 7.5H5V5.37A2.25 2.25 0 0 0 5 3.25Z',
  },
  {
    id: 'chapters-continue',
    order: 31,
    label: 'Continue with chapters',
    command: '/chapters-continue',
    noun: 'continuation',
    iconPath: 'M1 8a.75.75 0 0 1 0-1.5h9.44L7.72 3.28a.75.75 0 1 1 1.06-1.06l3.5 3.5.53.53-.53.53-3.5 3.5a.75.75 0 1 1-1.06-1.06L10.44 9.5H1Zm13-5.25v10.5a.75.75 0 0 1-1.5 0v-10.5a.75.75 0 0 1 1.5 0Z',
  },
]

/** Pull the child id out of either door's durable success text — both end in
 * `… is session ch-…` (src/tools.ts), so this regex is door-agnostic. */
export const CHILD_ID = /is session (ch-[\w-]+)/

/** The quoted title the door gave the child, matched by its OWN noun so a
 * refusal or an unrelated quote cannot pass for it. */
export const doorTitle = (noun: string): RegExp => new RegExp(`${noun} \\u201C([^\\u201D]+)\\u201D is session`)

function openByService(sessions: ClientSessions | undefined, sessionId: string): Promise<boolean> {
  return (async () => {
    const svc = sessions as unknown as { open?: (id: string) => unknown; refresh?: () => unknown } | undefined
    if (typeof svc?.open !== 'function') return false
    try { await svc.refresh?.() } catch { /* refresh best-effort */ }
    // The store must know the session before open() resolves it; a child
    // created seconds ago is only server-known until refresh lands. Retry
    // open briefly across that window.
    const started = Date.now()
    for (;;) {
      try { svc.open(sessionId); return true } catch {
        if (Date.now() - started > 4_000) return false
        await new Promise((r) => setTimeout(r, 250))
      }
    }
  })()
}

/**
 * Fallback path: expand collapsed groups / show-more buttons, then click the
 * newest treeitem whose label contains the child title (newest-updated sorts
 * first, so the first match is the fresh child).
 */
async function openBranchRow(title: string, budgetMs = 4_000): Promise<boolean> {
  if (typeof document === 'undefined') return false
  const needle = title.toLowerCase()
  const tryClick = (): boolean => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    const hit = rows.find((row) => (row.textContent ?? '').toLowerCase().includes(needle))
    if (hit === undefined) return false
    hit.click()
    return true
  }
  const clickMore = (): number => {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('button'))
      .filter((b) => /more sessions|ungrouped/i.test(b.textContent ?? '') && b.getAttribute('aria-expanded') !== 'true')
    for (const b of buttons) b.click()
    return buttons.length
  }
  const started = Date.now()
  let expansions = 0
  while (Date.now() - started < budgetMs) {
    if (tryClick()) return true
    if (expansions < 4 && clickMore() > 0) { expansions += 1; await new Promise((r) => setTimeout(r, 250)); continue }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return tryClick()
}

export function makeDoorRunner(
  remote: ClientRemote,
  sessions: ClientSessions | undefined,
  door: DoorAction,
  /**
   * "Is THIS session the one the client is now showing?" #54: `sessions.open()` returns
   * void, so a call that resolves proves the request was accepted, not that the app
   * switched. Measured on host 0.2.0-rc.2: no note element (open resolved), yet
   * `dsh.sessions.current` still named the parent and the child was absent from the
   * sidebar after a full reload — the user got silence and a missing session. Absent
   * (a client that cannot answer) the runner keeps the old behavior, and the wiring is
   * pinned by a row so production can never quietly drop it.
   */
  verifySwitched?: (childSessionId: string) => Promise<boolean>,
): (sessionId: string) => Promise<DoorResult> {
  return async function run(sessionId: string): Promise<DoorResult> {
    try {
      if (remote.commands?.execute === undefined) return { ok: false, message: 'commands remote unavailable' }
      const res = await remote.commands.execute(sessionId, door.command, [])
      if (res.ok !== true) return { ok: false, message: (res.error?.message ?? `the ${door.noun} call failed`).slice(0, 90) }
      const result = res.value?.result
      const text = typeof result?.text === 'string' ? result.text : ''
      if (result?.kind !== 'success') return { ok: false, message: (text || `the ${door.noun} was refused — see the command result`).slice(0, 90) }
      const child = CHILD_ID.exec(text)?.[1]
      if (child === undefined) return { ok: true, message: `${door.noun} created — appearing in the sidebar` }
      const switched = async (): Promise<boolean> => {
        if (verifySwitched === undefined) return true
        // the client settles asynchronously; three short looks, then the honest answer
        for (let i = 0; i < 3; i++) {
          try { if (await verifySwitched(child)) return true } catch { return false }
          await new Promise((r) => { setTimeout(r, 250).unref?.() })
        }
        return false
      }
      if (await openByService(sessions, child) && await switched()) return { ok: true, message: '' }
      // the service path did not take — the sidebar row is the same affordance a human uses
      const title = doorTitle(door.noun).exec(text)?.[1]
      if (title !== undefined && await openBranchRow(title) && await switched()) return { ok: true, message: '' }
      // #54: a child that is created but not shown is a DIFFERENT fact from one the user
      // has to open by hand, and the message must not blur them.
      return verifySwitched === undefined
        ? { ok: true, message: `${door.noun} created — open it in the sidebar` }
        : { ok: true, message: `${door.noun} created — the app did not switch; open it from the sidebar` }
    } catch (error) {
      return { ok: false, message: String((error as Error)?.message ?? error).slice(0, 90) }
    }
  }
}
