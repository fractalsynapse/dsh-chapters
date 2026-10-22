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

/**
 * Is the child in the client's OWN roster? This is the question that separates two very
 * different failures, and the door used to report the symptom without it:
 *  - the client never learned the session exists (roster: missing) → the fix is server-side
 *    publication, and no amount of clicking `open` will ever work;
 *  - the client knows it and `open` still did nothing (roster: contains) → a navigation bug.
 * Measured host 0.2.0-rc.2: the sessions service exposes `projectList`, `refresh`, `retain`,
 * `handleSessionAdded` — the roster is a projection the client fills from control frames.
 */
function rosterNote(sessions: ClientSessions | undefined, child: string): string {
  try {
    // gated on `projectList` existing — wrong test, since the note reads the STORE, not that
    // mutator. Any service exposing a list store can answer; any other answers UNKNOWN.
    // Measure the SHAPE, not the hope (the repo's own lesson: `listEvents` "worked" and had
    // no `data`). The first version of this note printed "0 sessions" for a conversation that
    // visibly had one, because it guessed at Array|Map and reported the guess as a fact.
    // The host's client store shape is `list.getSnapshot() → { ids, byId, phase }`. And
    // `projectList()` turned out to be a MUTATOR that returns undefined (measured), so the
    // first version of this note printed "0 sessions" about a conversation that visibly had
    // one — the repo's own `listEvents` lesson ("measure the shape, not the presence"),
    // repeated by me in the same week. Read the store; if it isn't reachable, presence is
    // UNKNOWN, and the note says so rather than inventing an absence.
    const store = (sessions as unknown as { list?: { getSnapshot?: () => unknown } })?.list
    const snap = typeof store?.getSnapshot === 'function' ? store.getSnapshot() : undefined
    const ids = new Set<string>()
    if (Array.isArray((snap as { ids?: unknown[] } | undefined)?.ids)) {
      for (const id of (snap as { ids: unknown[] }).ids) ids.add(String(id))
    } else if ((snap as { byId?: object } | undefined)?.byId !== undefined) {
      for (const k of Object.keys((snap as { byId: object }).byId)) ids.add(k)
    }
    if (ids.size === 0) {
      const shape = typeof store?.getSnapshot !== 'function' ? 'no list store on the service' : 'snapshot unreadable'
      return ` (roster: ${shape} — presence of ${child.slice(0, 11)}… is UNKNOWN, not absent)`
    }
    const n = ids.size
    return ids.has(child)
      ? ` (roster: contains ${child.slice(0, 11)}…, ${String(n)} sessions — open() is the failure)`
      : ` (roster: MISSING, ${String(n)} sessions — the client never catalogued this session)`
  } catch { return '' }
}

/** The service's own method names, as a hint attached to a failure note (never a guess). */
function verbsNote(sessions: ClientSessions | undefined): string {
  try {
    const svc = sessions as unknown as Record<string, unknown> | undefined
    if (svc === null || svc === undefined || typeof svc !== 'object') return ' (sessions service: absent)'
    // Measured: `Object.keys(svc)` returned NOTHING for the real service, because the host
    // puts its verbs on the PROTOTYPE (a class instance), not as own keys. A diagnostic that
    // reports "no methods" about a working service is worse than none — walk the chain.
    const found = new Set<string>()
    let node: unknown = svc
    // Stop at Object.prototype: its four legacy accessors are not service verbs, and listing
    // them pushed the real names past the cap on the first live run.
    for (let depth = 0; depth < 6 && node !== null && node !== undefined && node !== Object.prototype; depth++) {
      for (const key of Object.getOwnPropertyNames(node as object)) {
        if (key === 'constructor') continue
        try { if (typeof (svc as Record<string, unknown>)[key] === 'function') found.add(key) } catch { /* getter that throws — not a verb we can use either */ }
      }
      node = Object.getPrototypeOf(node)
    }
    const verbs = [...found].sort().slice(0, 24)
    return verbs.length === 0 ? ' (sessions service: no methods on the chain)' : ` (sessions verbs: ${verbs.join(', ')})`
  } catch { return ' (sessions service: unreadable)' }
}

function openByService(sessions: ClientSessions | undefined, sessionId: string): Promise<boolean> {
  return (async () => {
    const svc = sessions as unknown as { open?: (id: string) => unknown; refresh?: () => unknown; projectList?: () => unknown } | undefined
    if (typeof svc?.open !== 'function') return false
    try { await svc.refresh?.() } catch { /* refresh best-effort */ }
    // #57: re-project the client's session catalog. The host does this ITSELF after every
    // create and fork — `dsh-api-session-controller/lib/client.js`, `create()` and `fork()`
    // both end in `this.projectList()` — because a session the client has never catalogued is
    // not addressable by `open()` no matter how often you call it. A plugin-created child is
    // exactly that case: durable, workspace-attached, absent from the client's roster. Measured
    // on 0.2.0-rc.2: without this the door created the child, `open` resolved, and the app
    // stayed on the parent (the door's own note now says `roster: …` so this is never a guess).
    try { svc.projectList?.() } catch { /* best-effort, like refresh */ }
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
      // #56/#57: the note must be ACTIONABLE. "the app did not switch" is true and useless;
      // naming the verbs the injected service actually exposes turns one failure into the
      // diagnosis (is there a refresh/reload to call, or is `open` the only verb and the
      // omission server-side?). A detected failure that isn't delivered is the same bug.
      return verifySwitched === undefined
        ? { ok: true, message: `${door.noun} created — open it in the sidebar` }
        : { ok: true, message: `${door.noun} created — the app did not switch; open it from the sidebar${rosterNote(sessions, child)}${verbsNote(sessions)}` }
    } catch (error) {
      return { ok: false, message: String((error as Error)?.message ?? error).slice(0, 90) }
    }
  }
}
