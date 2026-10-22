/**
 * dsh-chapters client entry: the per-message door buttons.
 *
 * Registers the two deterministic archive doors into the assistant action row
 * (`conversation.chat.assistant-actions` — the slot the official feedback
 * package populates beside copy/branch). Clicking one executes its host
 * command — `/chapters-fork`, `/chapters-continue` — through `remote.commands`,
 * the exact wire the composer's input line rides, then SWITCHES the app to the
 * fresh child:
 *
 *   1. `sessions.open(child)` — the client sessions service carries open() on
 *      its prototype (Playwright-verified against this host; a keys-dump alone
 *      hid it, which is why an earlier round wrongly gave up on this path);
 *   2. fallback: click the child's sidebar row after expanding collapsed
 *      groups (plugin children can render under collapsed 'Ungrouped' heads);
 *   3. last resort: an inline note — the child is durable either way.
 *
 * There is deliberately NO second implementation of door logic here: the
 * buttons are mouths for the host commands (watermark, segmentation, budget,
 * titles, refusal-with-numbers all server-side, all tested), and the runner
 * they share is `src/client/doors.ts` — one body, one row per door. The purity
 * gate in tsdown.client.config.ts keeps this file cross-plugin-free.
 *
 * @module dsh-chapters/src/client
 */

import { createElement as h, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
// The host's own tooltip bubble — a platform module served by the loader table,
// external like react. Every action in this row labels through it.
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { DOOR_ACTIONS, makeDoorRunner, type ClientRemote, type ClientSessions, type DoorAction, type DoorResult } from './doors.ts'

interface ClientSlots {
  inject(name: string, factory: () => unknown): void
  register(registration: Record<string, unknown>, component: unknown): unknown
}

interface Ctx {
  slots: ClientSlots
  get(name: string): unknown
}

export const inject = ['slots', 'remote', 'remote.commands', 'sessions'] as const

/** Props composed by the slot framework: owner (`messageId`) + our injected verb. */
interface DoorActionProps {
  messageId: string
  run: () => Promise<DoorResult>
}

/**
 * Style parity with the native IconActions row: rules copied verbatim from the
 * host's MessageIconActions module (`._xzv4MW_action` in dsh-client-ui-chat's
 * compiled client + the feedback package's :disabled) — same metrics, tokens,
 * hover. Update this string if the host restyles its action row. Both doors
 * share these metrics.
 *
 * The final rule hides the native branch action IN THE MESSAGE ROW only
 * (user-approved cosmetic decision, docs/architecture.md): built-in chrome, so
 * the selector is its accessible label scoped to action-row buttons; both
 * locale spellings covered. If the host rewords the label the button simply
 * reappears — fails open, visibly.
 */
const CSS = [
  '.dsh-chapters_forkAction{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}',
  '.dsh-chapters_forkAction svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}',
  '.dsh-chapters_forkAction:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
  '.dsh-chapters_forkAction:disabled{cursor:default;opacity:.4}',
  '.dsh-chapters_forkNote{color:var(--dsw-alias-label-tertiary);padding-left:4px;font-size:13px;line-height:20px}',
  'button[class*="_action"][aria-label="Branch into a new conversation"],button[class*="_action"][aria-label="\u5728\u65b0\u5bf9\u8bdd\u4e2d\u5206\u652f"]{display:none !important}',
].join('\n')
const CSS_TAG_ID = 'dsh-chapters/assistant-action.css'

function injectStyles(): void {
  try {
    if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-chapters'
    tag.dataset.pluginCss = CSS_TAG_ID
    tag.textContent = CSS
    document.head.appendChild(tag)
  } catch { /* styling is cosmetic; the action still works without it */ }
}

/** One component body for every door row; only the label and glyph differ. */
function makeDoorAction(door: DoorAction) {
  return function ChaptersDoorAction({ run }: DoorActionProps) {
    const [busy, setBusy] = useState(false)
    const [note, setNote] = useState<string | null>(null)
    const alive = useRef(true)
    useEffect(() => () => { alive.current = false }, [])
    const onClick = useCallback(() => {
      if (busy) return
      setBusy(true)
      setNote(null)
      void run().then((result) => {
        if (!alive.current) return
        setBusy(false)
        setNote(result.message === '' ? null : result.message)
        setTimeout(() => { if (alive.current) setNote(null) }, 8000)
      })
    }, [busy, run])
    const button = h('button', {
      type: 'button',
      'aria-label': door.label,
      disabled: busy,
      onClick,
      className: 'dsh-chapters_forkAction',
    },
      h('svg', { viewBox: '0 0 16 16', width: '15', height: '15', fill: 'currentColor', 'aria-hidden': 'true' },
        h('path', { d: door.iconPath })))
    return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
      h(Tooltip, { label: door.label, side: 'bottom' as const, children: button as ReactElement<Record<string, unknown>> }),
      note !== null
        ? h('span', { className: 'dsh-chapters_forkNote' }, note)
        : null)
  }
}

export function apply(ctx: Ctx): void {
  injectStyles()
  const slots = ctx.slots
  const remote = (ctx.get('remote') ?? {}) as ClientRemote
  let sessions: ClientSessions | undefined
  try { sessions = ctx.get('sessions') as ClientSessions | undefined } catch { sessions = undefined }
  // No early return on missing descriptors: the buttons register regardless
  // and the click reports the gap. A missing button is worse than a button
  // that explains itself. Components and runners are built ONCE here — slot
  // factories may re-run, and a fresh component identity per call would
  // remount the row.
  // #54: the switch verifier. `dsh.sessions.current` is published by the host's own
  // dsh-client-ui-workspace (grep-confirmed, not folklore) — the same key the e2e specs
  // read to name a session exactly, which is the point: the door now checks the fact the
  // user would notice, not whether a void call threw.
  const currentSessionId = (): string | null => {
    try {
      const raw = window.localStorage.getItem('dsh.sessions.current')
      if (raw === null) return null
      const parsed = JSON.parse(raw) as { sessionId?: string } | null
      return parsed?.sessionId ?? null
    } catch { return null }
  }
  const rows = DOOR_ACTIONS.map((door) => ({
    door,
    run: makeDoorRunner(remote, sessions, door, async (child) => {
      for (let i = 0; i < 8; i++) {
        if (currentSessionId() === child) return true
        await new Promise((r) => setTimeout(r, 250))
      }
      return currentSessionId() === child
    }),
    component: makeDoorAction(door),
  }))
  slots.inject('conversation.chat.assistant-actions', () => rows.map(({ door, run, component }) => slots.register({
    name: 'conversation.chat.assistant-actions',
    id: door.id,
    order: door.order,
    inject: (sessionId: string) => ({ run: () => run(sessionId) }),
  }, component)))
}
