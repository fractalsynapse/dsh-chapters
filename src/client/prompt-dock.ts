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

import { createElement as h, useCallback, useEffect, useReducer, useRef, type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import {
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
  inputActions?: { setDraft?: (text: string) => void; submit?: () => void }
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
  '.dsh-chapters_promptError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:20px;flex:none;max-width:34%}',
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
const canRunHere = (state: PromptBarState): boolean => state.text !== null && state.text !== ''

export function PromptDock(props: DockProps): ReactElement | null {
  const { sessionId, inputActions, exec } = props
  const [state, dispatch] = useReducer(promptBarReducer, initialBarState(), (s) => ({ ...s, running: props.running ?? true }))
  // #79's discipline, kept because the failure it prevents was real: one pull per mount, then per edge.
  // A fetch in an effect with no such guard re-fires on every render.
  const pulling = useRef(false)
  const mounted = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (exec === undefined || pulling.current) return
    pulling.current = true
    try {
      const text = await exec(BAR_STATE_COMMAND)
      const ev = parseBarState(text) as PromptBarEvent | null
      if (ev !== null) dispatch(ev)
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
    if (mounted.current) return
    mounted.current = true
    void refresh()
  }, [refresh])

  // Autorun fires off the IDLE edge, never off a render. `running` comes from the host when it publishes it;
  // absent means unknown, and unknown means do not start a turn the human cannot see coming.
  useEffect(() => {
    dispatch({ t: 'running', running: props.running ?? true })
  }, [props.running])

  const run = useCallback((): void => {
    if (state.text === null || state.text === '') return
    inputActions?.setDraft?.(state.text)
    inputActions?.submit?.()
    dispatch({ t: 'collapse' })
  }, [inputActions, state.text])

  useEffect(() => {
    if (!shouldAutoFire(state)) return
    run()
  }, [state, run])

  if (sessionId === undefined || !barVisible(state as PromptBarState)) return null

  const populate = (): void => {
    // Collapsed: reading. Expanded: the maintainer's click-to-edit gesture — setDraft REPLACES the draft,
    // which is what they asked for ("the prompt replaces the chat input contents so you can edit it"), and
    // nothing is submitted. Run is a separate, deliberate button.
    if (!state.expanded) { dispatch({ t: 'expand' }); return }
    if (state.text !== null && state.text !== '') inputActions?.setDraft?.(state.text)
  }

  const autorunDisabled = props.running === undefined
  return h('div', { className: 'dsh-chapters_promptDock', 'data-prompt-bar': 'true' },
    h('div', { className: `dsh-chapters_promptBar${state.expanded ? ' dsh-chapters_promptExpanded' : ''}` },
      h('span', { className: 'dsh-chapters_promptGlyph' }, h(Glyph)),
      h('span', { className: 'dsh-chapters_promptLabel' }, barLabel(state as PromptBarState) ?? ''),
      // A goal re-cut is held for the human's keystroke: the host reserves goal edits for a turn containing a
      // direct human message, and an autorun message is not one. The bar says so on its face rather than
      // letting Run appear to be a normal button that silently fails in the tool.
      ...(state.intent === 'goal-edit' ? [h('span', { key: 'intent', className: 'dsh-chapters_promptError', 'aria-label': 'This step edits the goal' }, 'edits the goal · run it yourself')] : []),
      h('button', {
        type: 'button', className: 'dsh-chapters_promptText',
        'aria-label': state.expanded ? 'Put this suggested prompt in the input box' : 'Show the full suggested prompt',
        onClick: populate,
      }, state.expanded
        ? h('span', { className: 'dsh-chapters_promptFull' }, state.text ?? '')
        : h('span', { className: 'dsh-chapters_promptEllipsis' }, state.text ?? '')),
      ...(state.error === '' ? [] : [h('span', { key: 'err', className: 'dsh-chapters_promptError', role: 'alert' }, state.error)]),
      h('div', { className: 'dsh-chapters_promptActions' },
        h(Action, {
          label: 'Run the suggested next step', glyph: '▶', onClick: run,
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
          onClick: () => { dispatch({ t: 'autorun', on: state.autorun !== 'armed' }); void refresh() },
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
