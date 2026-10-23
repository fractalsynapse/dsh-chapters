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
import {
  ghostKeyAction, ghostReducer, makeModelLabelFetcher, makePromptFetcher, shouldShowGhost,
  type GhostEvent, type GhostFetchResult, type GhostPhase, type GhostSuggestion,
} from './prompt-ghost.ts'

interface ClientSlots {
  inject(name: string, factory: () => unknown): void
  register(registration: Record<string, unknown>, component: unknown): unknown
}

interface Ctx {
  slots: ClientSlots
  get(name: string): unknown
}

// #77: `uiWorkspace` is not optional in practice — it owns `openSession(target)`, the verb the
// host's own fork button uses (`ctx.uiWorkspace.openSession(childId)` in dsh-client-ui-chat).
// `sessions` has no `open` at all, so without this row the door has never had a way to switch.
export const inject = ['slots', 'remote', 'remote.commands', 'sessions', 'uiWorkspace'] as const

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
  // #71 the prompt ghost chip — the overlay anchor is the composer card's top band
  // (`inset: 0 0 auto; height: 0`), the same hole the trigger menu pops from. The
  // chip floats there, placeholder-caption palette, click-to-accept; the Right-arrow
  // path needs no pixels at all. Fails open: worst case (host restyles the card) it
  // reads as a slightly misplaced suggestion, never broken chrome.
  '.dsh-chapters_ghostWrap{position:absolute;top:2px;left:14px;right:14px;display:flex;justify-content:flex-start;pointer-events:none;z-index:1}',
  '.dsh-chapters_ghost{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;max-width:min(70%,560px);padding:2px 10px;border:none;border-radius:12px;cursor:pointer;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}',
  '.dsh-chapters_ghost:hover{color:var(--dsw-alias-label-secondary)}',
  '.dsh-chapters_ghostText{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
  '.dsh-chapters_ghostGlyph{flex:none;font-weight:600}',
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

/**
 * The ghost chrome (#71): standard session hooks in, pure decisions out. It
 * holds NO logic — visibility, gestures, and the wire live in prompt-ghost.ts;
 * this component only binds those to React and the host Tooltip.
 */
interface GhostProps {
  sessionId: string
  useInput: (sel: (s: { draft: string; attachmentIds: readonly unknown[] }) => unknown) => unknown
  useSession: (sel: (s: { running?: boolean | null }) => unknown) => unknown
  inputActions?: { setDraft(text: string): void } | undefined
  fetchSuggestion: () => Promise<GhostFetchResult>
  fetchLabel: () => Promise<string | null>
}

function makeGhostView() {
  return function ChaptersPromptGhost(props: GhostProps) {
    const snap = props.useInput((s) => s) as { draft: string; attachmentIds: readonly unknown[] } | undefined
    const running = (props.useSession((s) => s.running) as boolean | null | undefined) ?? false
    const draft = snap?.draft ?? ''
    const hasAttachments = (snap?.attachmentIds.length ?? 0) > 0
    const [state, setState] = useState<{ phase: GhostPhase; boundary: number }>({ phase: 'idle', boundary: 0 })
    const [suggestion, setSuggestion] = useState<GhostSuggestion | null>(null)
    const [model, setModel] = useState<string | null>(null)
    // #79: the label answer is what tells this component whether the feature exists at all.
    // Until it arrives, nothing is fetched; when it says OFF, nothing is EVER fetched. Before
    // this, an idle edge pulled `/chapters-prompt suggest` on every boot and the server had to
    // refuse it — visible in the durable log as `prompt suggestions are off` command errors in
    // sessions that never enabled the feature.
    const [labelKnown, setLabelKnown] = useState(false)
    const alive = useRef(true)
    useEffect(() => () => { alive.current = false }, [])
    const dispatch = useCallback((ev: GhostEvent) => { setState((s) => ghostReducer(s, ev)) }, [])

    // The model label is a display fact: fetch once per mount, absence tolerated.
    // #79: the dep array used to be `[props]`, and React hands a NEW props object every render
    // — with this component subscribed to the whole input store, that meant a durable
    // `/chapters-prompt model` command per keystroke (measured: 4–26 command pairs per session,
    // on boots where the feature is OFF and the correct number is zero). The callback is read
    // through a ref so the mount-scoped guard cannot be defeated by an unstable identity.
    const fetchLabelRef = useRef(props.fetchLabel)
    fetchLabelRef.current = props.fetchLabel
    const labelFetched = useRef(false)
    useEffect(() => {
      if (labelFetched.current) return
      labelFetched.current = true
      void fetchLabelRef.current().then((m) => {
        if (!alive.current) return
        setModel(m)
        setLabelKnown(true)
      })
    }, [])

    // Idle edge: the first settled render and every running true→false transition
    // open a new boundary (the host-side cache watermark does the token economics;
    // this only decides WHEN to ask).
    const prevRunning = useRef<boolean | null>(null)
    useEffect(() => {
      const first = prevRunning.current === null
      const edge = !running && (first || prevRunning.current === true)
      prevRunning.current = running
      if (edge) dispatch({ type: 'idle-edge' })
    }, [running, dispatch])

    // One fetch per boundary, while idle. A late answer cannot resurrect an
    // accepted/dismissed chip — the reducer owns that race.
    const fetchedFor = useRef(-1)
    const { phase, boundary } = state
    useEffect(() => {
      if (!labelKnown || model === null) return
      if (phase !== 'idle' || fetchedFor.current === boundary) return
      fetchedFor.current = boundary
      void props.fetchSuggestion().then((r) => {
        if (!alive.current) return
        setSuggestion(r.ok ? { text: r.text, model: model !== null ? model : undefined } : null)
        dispatch({ type: 'fetched', ok: r.ok })
      })
    }, [phase, boundary, props, dispatch, labelKnown, model])

    const accept = useCallback(() => {
      if (suggestion === null) return
      props.inputActions?.setDraft(suggestion.text)
      dispatch({ type: 'accept' })
    }, [suggestion, props, dispatch])

    // The gesture: ArrowRight accepts, Esc dismisses — ONLY while the chip is
    // visible, ONLY for events whose target is the composer editor itself
    // (`data-composer-input`), attached at capture because the host keymap never
    // claims ArrowRight and Escape-with-no-menu passes. The listener detaches
    // with visibility, so a hidden ghost cannot eat a keystroke.
    const visible = shouldShowGhost(state.phase, running, draft, hasAttachments, suggestion)
    useEffect(() => {
      if (!visible) return
      const onKey = (event: KeyboardEvent) => {
        const action = ghostKeyAction(event.key)
        if (action === null) return
        const target = event.target as HTMLElement | null
        if (target === null || typeof target.closest !== 'function' || target.closest('[data-composer-input]') === null) return
        event.preventDefault()
        event.stopPropagation()
        if (action === 'accept') accept()
        else dispatch({ type: 'dismiss' })
      }
      document.addEventListener('keydown', onKey, true)
      return () => { document.removeEventListener('keydown', onKey, true) }
    }, [visible, accept, dispatch])

    if (!visible || suggestion === null) return null
    const tip = `next step suggested${model !== null ? ` by ${model}` : ''} — → or click puts it in the draft, Esc dismisses`
    return h('span', { className: 'dsh-chapters_ghostWrap' },
      h(Tooltip, {
        label: tip,
        side: 'top' as const,
        children: h('button', {
          type: 'button',
          className: 'dsh-chapters_ghost',
          'aria-label': 'Accept the suggested next prompt',
          onClick: accept,
        },
          h('span', { className: 'dsh-chapters_ghostGlyph', 'aria-hidden': 'true' }, '→'),
          h('span', { className: 'dsh-chapters_ghostText' }, suggestion.text)) as ReactElement<Record<string, unknown>>,
      }))
  }
}

export function apply(ctx: Ctx): void {
  injectStyles()
  const slots = ctx.slots
  const remote = (ctx.get('remote') ?? {}) as ClientRemote
  let sessions: ClientSessions | undefined
  try { sessions = ctx.get('sessions') as ClientSessions | undefined } catch { sessions = undefined }
  // Defensive: a host that cannot provide the navigator must leave the door registering and
  // reporting its own limitation, not failing at boot.
  let uiWorkspace: { openSession?: (id: string) => unknown } | undefined
  try { uiWorkspace = ctx.get('uiWorkspace') as { openSession?: (id: string) => unknown } | undefined } catch { uiWorkspace = undefined }
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
    }, { ...(uiWorkspace !== undefined ? { navigator: uiWorkspace } : {} ) }),
    component: makeDoorAction(door),
  }))
  slots.inject('conversation.chat.assistant-actions', () => rows.map(({ door, run, component }) => slots.register({
    name: 'conversation.chat.assistant-actions',
    id: door.id,
    order: door.order,
    inject: (sessionId: string) => ({ run: () => run(sessionId) }),
  }, component)))
  // #71: the ghost row. ONE component identity (built here, not per slot
  // re-inject), ONE wire body (prompt-ghost.ts), standard session hooks do the
  // rest. Registration into a slot another package declares rides slots.inject,
  // which waits for the declaration — the documented cross-package pattern.
  const ghostView = makeGhostView()
  const fetchSuggestion = makePromptFetcher(remote)
  const fetchLabel = makeModelLabelFetcher(remote)
  slots.inject('conversation.input.overlay', () => slots.register({
    name: 'conversation.input.overlay',
    id: 'chapters-prompt-ghost',
    order: 12,
    inject: (sessionId: string) => ({
      fetchSuggestion: () => fetchSuggestion(sessionId),
      fetchLabel: () => fetchLabel(sessionId),
    }),
  }, ghostView))
}
