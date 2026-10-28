/**
 * The Suggested Next Step dock row (#113) — thin by design.
 *
 * Every decision lives in `prompt-bar.ts` where a row can pin it; this file only moves pixels and bytes
 * between the host slot and that reducer. That split is the reason it exists: the ghost was rejected for
 * behaviour that had no home, and "one turn, one offer" cannot be tested in a component.
 *
 * Placement is measured, not styled: `conversation.input.dock` is the host's full-width stack rendered
 * ABOVE the composer card (todo `order: 0`, goal `10`, queue `20`), so `order: 30` puts this row under every
 * other dock entry and directly above the input — and because it is a docked row rather than an overlay, it
 * can neither cover the placeholder nor collide with the send buttons. The ghost's ugliest defect was
 * structural, and the structure fixes it.
 *
 * The bar is PUSH-SHAPED, PULL-FED. A registrant can own a reactive observable (`hooks: { x }` → prop
 * `useX`) — that is how the goal bar gets its `activation` — but a plugin cannot publish a projection, and
 * the only plugin-reachable call path is `remote.commands.execute`. So the component pulls the `state` verb
 * on edges it can actually observe. Stated here because the alternative is a reader assuming a subscription
 * that does not exist.
 *
 * @module dsh-chapters/src/client/prompt-dock
 */

import { createElement as h, useCallback, useEffect, useReducer, useRef, useState, type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  BAR_RUN_COMMAND,
  deriveRunning,
  BAR_STATE_COMMAND,
  barLabel,
  barVisible,
  initialBarState,
  parseBarAutorun,
  parseBarState,
  promptBarReducer,
  shouldAutoFire,
  type PromptBarEvent,
  type PromptBarState,
} from './prompt-bar.ts'

/** The dock's owner + standard-kit props we read. Everything is optional-typed on purpose: this is a host
 *  shape crossing a plugin boundary, and an absent field must degrade visibly, not throw at boot (#58). */
export interface DockProps {
  sessionId?: string
  inputActions?: { insertText?: (text: string) => void; setDraft?: (text: string) => void; submit?: () => void }
  /** The host's session-status hook, when this build hands docks one (`useSessionStatus` is in the dock's
   * documented prop list). Folded through `deriveRunning` because its shape is not ours to assume. */
  useSessionStatus?: (selector?: unknown) => unknown
  /** The session snapshot hook; its snapshot carries `running`, which is Autorun's idle edge. */
  useSession?: (selector?: unknown) => unknown
  /** The host publishes running/idle through the composer kit on some builds; if it is absent, autorun
   *  refuses to fire rather than guessing that the session is idle. Fail-safe, not fail-open. */
  running?: boolean
  /** Run a host command line for THIS session and return its text. One verb for every call the bar makes
   * (the `state` pull and the `off` write), because the bar is a mouth for the command plane — a second
   * private channel would be a second contract to keep in step, which is what `doors.ts` already avoids. */
  exec?: (line: string) => Promise<string>
}

const CSS = [
  // Metrics copied from the goal bar's measured module so the two rows read as one family: a 36px card,
  // host elevation + radius tokens, and the host's own composer width vars so it tracks the card above it.
  '.dsh-chapters_promptDock{box-sizing:border-box;width:calc(100% - 4 * var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));margin:0 auto}',
  '.dsh-chapters_promptBar{isolation:isolate;box-sizing:border-box;width:100%;border-radius:var(--dsw-radius-md);height:36px;box-shadow:var(--dsw-elevation-panel);border:0;align-items:center;gap:10px;padding:4px 5px 4px 12px;display:flex;position:relative}',
  '.dsh-chapters_promptBar::before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:"";pointer-events:none;position:absolute;inset:0}',
  '.dsh-chapters_promptExpanded::before{align-items:flex-start;position:absolute;inset:0}',
  '.dsh-chapters_promptGlyph{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex}',
  '.dsh-chapters_promptLabel{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}',
  '.dsh-chapters_promptText{min-width:0;color:var(--dsw-alias-label-primary-dimmed);font-size:13px;line-height:20px;cursor:pointer;border:0;background:0 0;padding:0;text-align:left;flex:1}',
  '.dsh-chapters_promptEllipsis{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;display:block}',
  '.dsh-chapters_promptFull{white-space:pre-wrap;overflow:auto;max-height:9rem;display:block}',
  '.dsh-chapters_promptError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:20px;flex:none;max-width:34%}',  '.dsh-chapters_promptNote{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;min-width:0}',
  '.dsh-chapters_promptIntent{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}',

  '.dsh-chapters_promptActions{flex:none;align-items:center;gap:10px;display:flex}',
  '.dsh-chapters_promptBtn{corner-shape:round;width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;padding:0;display:inline-flex;font-size:13px}',
  '.dsh-chapters_promptBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
  '.dsh-chapters_promptBtn:disabled{opacity:.4;cursor:default}',
].join('\n')
const CSS_ID = 'dsh-chapters/prompt-dock.css'

const ensureCss = (): void => {
  if (typeof document === 'undefined') return
  if (document.getElementById(CSS_ID) !== null) return
  const style = document.createElement('style')
  style.id = CSS_ID
  style.setAttribute('data-plugin-css', CSS_ID)
  style.textContent = CSS
  document.head.appendChild(style)
}

/** The analysis glyph, drawn to the goal icon's metric (16 viewBox, stroke currentColor, width 1).
 *  A prism-and-arrow: the feature reads the situation and points at the next move. */
const Glyph = (): ReactElement => h(
  'svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true', 'stroke-width': '1' },
  h('path', { d: 'M2.5 3.5h11L8 9.5 2.5 3.5Z', stroke: 'currentColor' }),
  h('path', { d: 'M8 9.5V14', stroke: 'currentColor' }),
  h('path', { d: 'M6 12l2 2 2-2', stroke: 'currentColor' }),
)

/** One action button, labelled through the host tooltip exactly as the goal bar labels its own. */
const Action = (props: { label: string; glyph: string; onClick: () => void; disabled?: boolean; title?: string }): ReactElement => {
  const button = h('button', {
    type: 'button', className: 'dsh-chapters_promptBtn', 'aria-label': props.label,
    ...(props.disabled === true ? { disabled: true } : {}),
    ...(props.title !== undefined ? { title: props.title } : {}),
    onClick: props.onClick,
  }, props.glyph)
  // Props matched to the call `doors.ts` already makes successfully: the host Tooltip takes
  // { label, side, children } and nothing else that I have verified. Inventing extra props (portal, delayMs)
  // failed the overload on the first compile, which is the right way to learn it.
  return h(Tooltip, { label: props.label, side: 'bottom' as const, children: button as ReactElement<Record<string, unknown>> })
}

/** Run is allowed whenever there is an offer; AUTORUN is what the intent and the goal gate. Keeping the
 * human's own button enabled is deliberate — the point of the protocol is to route a goal edit to a keystroke,
 * never to disable the human's ability to send it. */
/**
 * The words the collapsed row shows, per state. `idle` and `analyzing` must say something, because an empty
 * row is indistinguishable from a broken one — the whole reason this feature took a day to read: the bar was
 * live, enabled, and rendering nothing but whitespace.
 */
function lineFor(state: PromptBarState): string {
  if (state.status === 'ready') return state.text ?? ''
  if (state.status === 'analyzing') return 'Analyzing the session…'
  if (state.status === 'failed') return state.error !== null && state.error !== '' ? `Cannot recommend: ${state.error}` : 'Cannot recommend a next step right now'
  return 'No suggestion yet — I will recommend one after your next turn'
}

const canRunHere = (state: PromptBarState): boolean => state.text !== null && state.text !== ''

/** How long a state pull may take before we call it failed. Generous on purpose: this is a local RPC that
 * answers in milliseconds when the session is attachable, and the failure it guards against is a hang. */
const PULL_TIMEOUT_MS = 15_000

/** Retry ceiling for the FIRST pull only, in attempts and spacing. A mount-time race must not be able to
 * starve the bar forever, and a real `off` answer stops the loop on the first reply either way. */
/** Cadence of the keep-poll. A local RPC that answers in milliseconds; the cost is one command per
 * interval, and it ends the moment the state is `off`. */
const POLL_SPACING_MS = 10_000

function execWithTimeout(exec: (line: string) => Promise<string>, line: string, ms: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`no answer within ${String(ms)}ms`)) }, ms)
    exec(line).then(
      (text) => { clearTimeout(timer); resolve(text) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

export function PromptDock(props: DockProps): ReactElement | null {
  const { sessionId, inputActions, exec } = props
  const [state, dispatch] = useReducer(promptBarReducer, initialBarState(), (s) => ({ ...s, running: props.running ?? true }))
  // #79's discipline, kept because the failure it prevents was real: one pull per mount, then per edge.
  // A fetch in an effect with no such guard re-fires on every render.
  const pulling = useRef(false)
  // TWO different facts, two different refs — conflating them is the bug I just shipped: `pulled` is the
  // once-per-mount pull guard, `alive` is "may this component still call dispatch/setState". Initializing the
  // pull guard to true made every mount skip its first pull, so the bar sat at its `off` default and rendered
  // nothing at all — a regression that looked, from outside, like the feature having stopped working.
  const probed = useRef(false)
  const pulled = useRef(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const [busy, setBusy] = useState(false)
  void 0
  const answered = useRef(false)
  const replyStatus = useRef<string>('unknown')
  const stateRef = useRef<PromptBarState>(initialBarState())
  stateRef.current = state
  if (!probed.current) {
    probed.current = true
    // One print, on the first mount: which composer verbs does THIS host actually hand a dock? The click-to-draft
    // requirement needs one, `setDraft` is accepted but never reaches the editor, and guessing at the surface
    // again would be a third wrong theory in a row.
    console.info(`[client:prompt] inputActions keys: ${Object.keys(inputActions ?? {}).join(',') || 'NONE'}`)
  }

  const refresh = useCallback(async (): Promise<void> => {
    if (exec === undefined || pulling.current) return
    pulling.current = true
    try {
      // Bounded, and loudly so. Tonight's whole diagnosis cost was paid because this await had no ceiling:
      // a wire that never answers produced no dispatch, no catch and no `finally`, which looked identical to
      // "the feature is switched off". A hung command is now a named failure with a number on it (#61).
      const text = await execWithTimeout(exec, BAR_STATE_COMMAND, PULL_TIMEOUT_MS)
      // Handed to the leg through the page, because the state block is the contract and I need to see the
      // bytes the browser parsed, not the bytes the server meant. Overwritten each pull; read on failure.
      try { (window as unknown as { __dshPromptReply?: string }).__dshPromptReply = text } catch { /* test seam only */ }
      const ev = parseBarState(text) as PromptBarEvent | null
      if (ev !== null) { answered.current = true; replyStatus.current = (ev as { status?: string }).status ?? replyStatus.current; dispatch(ev) }
      const autorun = parseBarAutorun(text)
      if (autorun !== null) dispatch({ t: 'autorun', on: autorun === 'armed' })
    } catch (error) {
      // #61: a detected failure is a DELIVERED failure. Keeping the last known state is right; saying
      // nothing was not — with a bare `catch {}` a wire that never answers is indistinguishable from a
      // feature that is switched off, and that is exactly how this bar looked "unverifiable" in a browser
      // while the real fault was one line of swallowed output.
      // A failed pull is not a state: the bar keeps what it last knew rather than rendering `off`,
      // which would read as "suggestions are disabled" when the wire merely hiccoughed.
      console.warn(`[client:prompt] pull failed: ${String((error as Error)?.message ?? error).slice(0, 180)}`)
    } finally { pulling.current = false }
  }, [exec])

  useEffect(() => {
    ensureCss()
    if (pulled.current) return
    pulled.current = true
    // Retry until SOMETHING answers. `answered` flips on any parseable reply, including an honest `off`, so
    // this loop cannot make a disabled session look enabled — it only closes the window where a pull fired
    // before the session could take a command and the bar then stayed blank for the rest of the session.
    // Keep reading while the feature is live. This host publishes no idle edge — the same absence that
    // makes Autorun refuse to fire — so a pull that only ran at mount would answer `idle` once and then go
    // quiet for the rest of the session. The poll stops on `off`, which is the only state that means the
    // human (or the config) switched it away, so a disabled session costs one read and nothing more.
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      await refresh()
      if (replyStatus.current === 'off') return
      // The reply, not the React state. The old condition read `stateRef.current`, which is only advanced by a
      // render — and while the row is hidden there is no render to wait for, so the poll stopped after its
      // first read and the bar could never observe the offer that landed a minute later. Measured: every
      // `state read` in the boot log precedes its `ready` write, with none following. 
      timer = setTimeout(() => { void tick() }, POLL_SPACING_MS)
    }
    void tick()
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }, [refresh])

  // Autorun fires off the IDLE edge, never off a render. `running` comes from the host when it publishes it;
  // absent means unknown, and unknown means do not start a turn the human cannot see coming.
  useEffect(() => {
    dispatch({ t: 'running', running: props.running ?? true })
  }, [props.running])

  // Run is a COMMAND, not a keystroke. The composer-write path (`inputActions.setDraft` + `submit`) looked
  // like the obvious implementation and does not work on this host build: `setDraft` is accepted, and the
  // editor stays empty — measured, twice, after I had convinced myself it was the test's locator or a focus
  // ordering problem. The plugin already has a dependable wire to its own server plane, and the server has
  // exactly one human-authored submission path (the follow-up autorun uses), so Run rides that. The
  // consequence is also the point: what the human clicks and what the loop arms are the same code.
  const run = useCallback((): void => {
    if (state.text === null || state.text === '' || exec === undefined) return
    setBusy(true)
    void exec(BAR_RUN_COMMAND)
      .then((out) => {
        if (!alive.current) return
        if (/^cannot run:/i.test(out.trim())) dispatch({ t: 'polled', status: 'failed', text: state.text, error: out.trim().slice(0, 200), turnSeq: state.turnSeq } as PromptBarEvent)
        else dispatch({ t: 'collapse' })
      })
      .catch((error: unknown) => { console.warn(`[client:prompt] run failed: ${String((error as Error)?.message ?? error).slice(0, 160)}`) })
      .finally(() => { if (alive.current) setBusy(false) })
  }, [exec, state.text, state.turnSeq])

  useEffect(() => {
    if (!shouldAutoFire(state)) return
    run()
  }, [state, run])

  // Autorun's idle edge stays UNWIRED on this host, and that is now a measured fact rather than a guess:
  // `useSessionStatus` is in the dock's documented prop list, but calling it here threw twice — first a React
  // hook-order abort (#310, because it sat below the early return), then `TypeError: l is not a function` once
  // hoisted. Two blind attempts is the limit; the contract says which hooks exist, not their arity or context.
  // So the gate keeps its original, correct behavior: with no signal, `running` is undefined, Autorun is
  // visibly unavailable and says why, and `deriveRunning` (9 rows) stands ready for whichever shape the host
  // does publish. A loop that starts turns the human cannot foresee is the one failure mode not on offer.
  // `useSessionStatus` is `SnapshotSelectorHook<SessionStatusSnapshot>` — a SELECTOR hook (declared in
  // dsh-client-ui-session's client types), which is why calling it with a session id threw
  // `TypeError: l is not a function`: the host used my string as the selector. An identity selector takes
  // whatever the snapshot's shape happens to be, and `deriveRunning` folds it, so this code does not bet on
  // field names I have not read. Still hoisted above the early return: hook count must not change per render.
  // The idle signal IS published — on `useSession`, whose snapshot carries `running` (measured by printing the
  // hook surfaces once: `useSession=sessionId|pendingSubmissions|running|subagent|removed|openState`). My
  // first two attempts were wrong in different ways: a scalar `props.running` that no host supplies, then
  // `useSessionStatus`, which is provided but yields no readable keys under an identity selector. `deriveRunning`
  // folds `{running}`, so this is the last mile, and the hook is called unconditionally through a stable
  // fallback because hook order must not change between renders.
  const useSessionHook = props.useSession ?? (() => undefined)
  const sessionSnapshot = useSessionHook((snapshot: unknown) => snapshot)
  const running = props.running ?? deriveRunning(sessionSnapshot)
  const autorunDisabled = running === undefined

  if (sessionId === undefined || !barVisible(state as PromptBarState)) return null

  const populate = (): void => {
    // Collapsed: reading. Expanded: the maintainer's click-to-edit gesture — setDraft REPLACES the draft,
    // which is what they asked for ("the prompt replaces the chat input contents so you can edit it"), and
    // nothing is submitted. Run is a separate, deliberate button.
    // Printed on every branch, because "the button did nothing" and "the button took the other path" looked
    // identical from outside for three runs.
    console.info(`[client:prompt] populate expanded=${String(state.expanded)} hasInsertText=${String(typeof inputActions?.insertText)} hasSetDraft=${String(typeof inputActions?.setDraft)} textLen=${String(state.text?.length ?? -1)}`)
    if (!state.expanded) { dispatch({ t: 'expand' }); return }
    if (state.text === null || state.text === '') return
    // Delivered, not assumed. The click-to-draft gesture is the interaction the maintainer asked for, so a
    // silent no-op here is indistinguishable from "the feature does not work" — and that ambiguity cost the
    // rest of this leg's diagnosis. Absent verb, absent text: both say so.
    // The host's composer kit is `{ captureInsertion, insertText, setDraft, addAttachments, removeAttachment,
    // pruneAttachments, submit }` (measured on 0.2.0-rc.2). `setDraft` writes the STORE, and the store is
    // mirrored into the editor only at mount while the editor is empty — which is why a click that "worked"
    // (no refusal, no throw) left the box visibly empty. `insertText` is the verb that reaches the editor, so
    // click-to-draft uses it and keeps `setDraft` only as a fallback for builds that lack it.
    if (typeof inputActions?.insertText === 'function') {
      // `insertText` inserts AT THE CARET, and clicking this button moves the caret out of the editor — so the
      // call ran and put the words nowhere. Focusing the composer first is the whole difference, and it is done
      // with a tolerant query rather than a class name: the host's own module hashes (`wSkVaW_…`) are not mine
      // to depend on, and a bar that silently stops drafting after a host restyle is worse than one that tries.
      try {
        const box = document.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')
        box?.focus()
      } catch { /* a host without the editor mounted: the insert below still records the intent */ }
      // Measured on host 0.2.0-rc.2: called from a dock this throws
      // `Cannot read properties of undefined (reading 'draftRev')`, and the kit's other verb (`setDraft`) writes
      // a store the editor mirrors only at mount. Neither reaches the composer. A silent no-op is what cost the
      // last six runs, so the refusal now appears on the bar and points at Run, which does work.
      const refuse = (why: string): void => {
        console.warn(`[client:prompt] click-to-draft refused: ${why}`)
        dispatch({ t: 'note', note: 'This host does not let a plugin write the composer, so the prompt cannot be edited before sending — Run submits it as your turn' })
      }
      try {
        inputActions.insertText(state.text)
        // Throwing is the easy case. The harder one is the verb that returns successfully and changes nothing,
        // which is what `setDraft` does on 0.2.0-rc.2 and what a silent button looks like forever. Verify the
        // editor actually holds the words; if it does not, say so on the bar.
        const box = document.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')
        const head = state.text.slice(0, 24)
        if ((box?.innerText ?? '').indexOf(head) === -1) {
          // One animation frame: the host may write the DOM after its own microtask.
          setTimeout(() => {
            const b2 = document.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')
            if ((b2?.innerText ?? '').indexOf(head) === -1) refuse('insertText reported success and left the editor empty')
          }, 400)
        }
      } catch (error) {
        refuse(String((error as Error)?.message ?? error).slice(0, 160))
      }
      // Read the editor back from inside the component, so "insertText is a no-op on this host" is a fact with
      // a number next to it rather than a conclusion the test reaches after the fact.
      setTimeout(() => {
        try {
          const box = document.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')
          console.info(`[client:prompt] after insertText: editorText=${String(box?.innerText?.length ?? 'NO-BOX')} focused=${String(document.activeElement === box)}`)
        } catch { /* diagnostics never break the gesture */ }
      }, 250)
      return
    }
    if (typeof inputActions?.setDraft === 'function') {
      inputActions.setDraft(state.text)
      return
    }
    console.warn('[client:prompt] click-to-draft refused: this host exposes neither insertText nor setDraft')
  }

  // Called unconditionally through a stable fallback, so the hook order cannot change between renders.
  return h('div', { className: 'dsh-chapters_promptDock', 'data-prompt-bar': 'true' },
    h('div', { className: `dsh-chapters_promptBar${state.expanded ? ' dsh-chapters_promptExpanded' : ''}` },
      h('span', { className: 'dsh-chapters_promptGlyph' }, h(Glyph)),
      h('span', { className: 'dsh-chapters_promptLabel' }, barLabel(state as PromptBarState) ?? ''),
      // A goal re-cut is held for the human's keystroke: the host reserves goal edits for a turn containing a
      // direct human message, and an autorun message is not one. The bar says so on its face rather than
      // letting Run appear to be a normal button that silently fails in the tool.
      ...(state.intent === 'goal-edit' ? [h('span', { key: 'intent', className: 'dsh-chapters_promptIntent', 'aria-label': 'This step edits the goal' }, 'edits the goal · run it yourself')] : []),
      h('button', {
        type: 'button', className: 'dsh-chapters_promptText',
        'aria-label': state.expanded ? 'Put this suggested prompt in the input box' : 'Show the full suggested prompt',
        onClick: populate,
      }, state.expanded
        ? h('span', { className: 'dsh-chapters_promptFull' }, state.text ?? '')
        : h('span', { className: 'dsh-chapters_promptEllipsis' }, lineFor(state))),
      ...(state.note === '' ? [] : [h('span', { key: 'note', className: 'dsh-chapters_promptNote', role: 'status' }, state.note)]),
      ...(state.error === '' ? [] : [h('span', { key: 'err', className: 'dsh-chapters_promptError', role: 'alert' }, state.error)]),
      h('div', { className: 'dsh-chapters_promptActions' },
        h(Action, {
          label: 'Run the suggested next step', glyph: '▶', onClick: run, disabled: busy,
          ...(state.text === null || state.text === '' || !canRunHere(state) ? { disabled: true } : {}),
          ...(state.intent === 'goal-edit'
            ? { title: 'Goal edits need a human turn. Run still works; autorun will never do this one.' }
            : {}),
        }),
        h(Action, {
          label: state.autorun === 'armed' ? 'Autorun off' : 'Autorun',
          glyph: state.autorun === 'armed' ? '⟳' : '⟲',
          disabled: autorunDisabled,
          ...(autorunDisabled
            ? { title: 'Autorun needs the host to publish an idle signal; this build does not, so nothing would fire safely.' }
            : {}),
          // A SERVER write, like `off` below. Flipping local state alone was the defect: `refresh()` re-reads the
          // loop state (`:193`), the server still says `disarmed`, and the label snaps back — so the user watched
          // their own click be refused and the loop could never be started from the bar. The command surface is
          // `/chapters-prompt autorun on|off` (src/commands.ts:462-478), which also reports the goal displacement.
          onClick: () => {
            void (async () => {
              const arm = state.autorun !== 'armed'
              if (exec !== undefined) await exec(`/chapters-prompt autorun ${arm ? 'on' : 'off'}`)
              dispatch({ t: 'autorun', on: arm })
              await refresh()
            })()
          },
        }),
        h(Action, {
          label: 'Turn prompt suggestions off for this session', glyph: '✕',
          // `off` is a server write, not a local hide: generation stops, the configured model is KEPT so
          // back-on is one action, and the bar disappears instead of lingering with a stale offer.
          onClick: () => { void (async () => { if (exec !== undefined) await exec('/chapters-prompt off'); dispatch({ t: 'off' }) })() },
        }),
      ),
    ),
  )
}
