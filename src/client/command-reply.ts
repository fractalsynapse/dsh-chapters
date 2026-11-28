/**
 * #590: THE COMMAND REPLY ROW. The maintainer's directive: "I really don't want to suffer this
 * problem again" — a typed /chapters-* command whose reply the timeline refuses to show (#545:
 * the host's SURFACE_EVENT_TYPES excludes command events from any rebuilt timeline) used to mean
 * invisible work and a wasted investigation. The reply is ALWAYS in the durable journal — the
 * host records command/run + command/done pairs faithfully; only its renderer filters them. So
 * this row reads the journal through the host's OWN session.follow stream (the same wire the
 * chat projector consumes, BEFORE its surface filter), renders the newest exchange above the
 * composer, and updates from the stream's live frames — zero polling, zero litter, zero model
 * calls, and no server-side state invented for it.
 *
 * Suppression, stated not assumed: when the host DOES render the reply as a timeline card
 * (healthy live sessions), the row steps aside — it probes the document for the reply excerpt
 * before mounting its own, so a visible card and a dock row never duplicate.
 */
import { createElement as h, useEffect, useState, type ReactElement } from 'react'


// #594: the row's OWN stylesheet, geometry copied from the prompt bar's measured dock rules
// (the maintainer's live report: the first cut rendered 'way outside the timeline view' — a bare
// inline-styled div in a dock container that expects the bar's width calc). Self-injected, not
// borrowed from prompt-dock, because the bar may never mount (no prompt model) and the row must
// still be a card, not a stranger.
const REPLY_CSS_ID = 'dsh-chapters/command-reply.css'
const REPLY_CSS = [
  '.dsh-chapters_replyDock{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance) - 4 * var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));margin:0 auto}',
  '.dsh-chapters_replyBar{isolation:isolate;box-sizing:border-box;width:100%;position:relative;display:flex;align-items:center;gap:10px;border-radius:var(--dsw-radius-md);min-height:32px;padding:4px 12px;font-size:12px;box-shadow:var(--dsw-elevation-panel)}',
  '.dsh-chapters_replyBar::before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:"";position:absolute;inset:0;pointer-events:none}',
  '.dsh-chapters_replyLine{font-family:var(--dsw-font-code,monospace);flex:none;color:var(--dsw-alias-label-secondary)}',
  '.dsh-chapters_replyText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary-dimmed);line-height:18px;cursor:pointer}',
  '.dsh-chapters_replyFull{white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;max-height:180px;overflow-y:auto;flex:1;min-width:0;color:var(--dsw-alias-label-primary);line-height:18px;cursor:pointer}',
  '.dsh-chapters_replyError .dsh-chapters_replyLine{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-chapters_replyRunning .dsh-chapters_replyLine{color:var(--dsw-alias-state-warning-primary)}',
  '.dsh-chapters_replyBtn{width:24px;height:24px;flex:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;display:inline-flex;align-items:center;justify-content:center}',
  '.dsh-chapters_replyBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
].join('\n')
function ensureReplyCss(): void {
  if (typeof document === 'undefined') return
  try {
    if (document.getElementById(REPLY_CSS_ID) !== null) return
    const style = document.createElement('style')
    style.id = REPLY_CSS_ID
    style.setAttribute('data-plugin-css', REPLY_CSS_ID)
    style.textContent = REPLY_CSS
    document.head.appendChild(style)
  } catch { /* styling is cosmetic; the row still answers without it */ }
}

/** The newest command exchange, shaped for the row. */
export interface CommandReply {
  line: string
  kind: 'success' | 'error' | 'running' | string
  text: string
  seq: number
}

export const EXCERPT_CHARS = 200

export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat
}

/**
 * Does the host already render this reply? The probe runs BEFORE the row mounts (once per new
 * exchange), so an excerpt found in the document is the host's card, not our own echo. Absent
 * document (tests, odd hosts) reads as "not shown" — fail-visible, never fail-silent.
 */
export function hostCardShowsReply(excerpt: string, doc?: { body?: { innerText?: string }; querySelector?: (sel: string) => { innerText?: string } | null } | undefined): boolean {
  if (excerpt === '') return false
  let text = doc?.body?.innerText
  if (typeof text !== 'string') return false
  // #594 THE SELF-SUPPRESSION BUG, measured live by the maintainer on 0.2.60 (flash-then-vanish):
  // the probe runs AFTER React mounts the row, so the document already contains the row's own
  // excerpt — the first cut read its own echo as 'the host rendered the card' and stood aside
  // from itself. Subtract the row's own text before searching; only what remains OUTSIDE the
  // row can be the host's card.
  const own = typeof doc?.querySelector === 'function' ? doc.querySelector('[data-chapters-reply]') : null
  const ownText = own?.innerText
  if (typeof ownText === 'string' && ownText !== '') {
    const i = text.indexOf(ownText)
    if (i >= 0) text = text.slice(0, i) + text.slice(i + ownText.length)
  }
  return text.includes(excerpt.slice(0, 80))
}

/**
 * #590, the channel as MEASURED: the host's follow wire filters command events before the
 * browser (reload-leg evidence 2026-11-27: snapshot 27 records, 0 command events), so the row
 * reads the server's reply record instead — `chapters-reply last` through the exec channel the
 * bar already owns. Pulls are human-driven only, and every one is named:
 *   - mount (the restart+resume case: reload answers 'what did my last command say?'),
 *   - visibility return (tab away, tab back),
 *   - composer submit: a /chapters line that was in the composer and is now empty means the
 *     host just dispatched it — one pull follows. Bounded by human action, never ambient
 *     (#229's drumbeat ban stands: zero timers, zero polls).
 */
export interface CommandReplyRow { line?: string; kind?: string; text?: string; at?: string }

export function parseReplyRow(raw: string): CommandReply | null {
  if (raw.trim() === '') return null
  try {
    const p = JSON.parse(raw) as CommandReplyRow
    if (typeof p.line !== 'string' || p.line === '') return null
    // seq: the record's own timestamp — dismissal and 'newest wins' both ride it.
    return { line: p.line, kind: p.kind ?? 'success', text: p.text ?? '', seq: Number.isFinite(Date.parse(p.at ?? '')) ? Date.parse(p.at ?? '') : 1 }
  } catch { return null }
}

const composerTextOf = (): string => {
  try {
    const el = document.querySelector<HTMLElement>('[data-composer-input]')
    if (el === null) return ''
    return ('value' in el ? String((el as unknown as { value: string }).value ?? '') : (el.innerText ?? ''))
  } catch { return '' }
}

export function subscribeReply(exec: (line: string) => Promise<string>, onReply: (r: CommandReply | null) => void): () => void {
  let closed = false
  const pullOnce = async (): Promise<boolean> => {
    try {
      const raw = await exec('/chapters-reply last')
      const parsed = parseReplyRow(raw)
      if (closed) return true
      console.info(`[client:chapters] command reply pull: ${String(raw.length)} chars, parsed=${String(parsed !== null)}`)
      if (parsed === null) return false
      onReply(parsed)
      return true
    } catch { return false /* transport hiccup: the retry ladder decides */ }
  }
  // The composer empties at DISPATCH time; the handler writes the record asynchronously after.
  // A single submit-triggered pull races its own answer and reads empty (measured in the reload
  // leg: record present in the registry, every pull 0 chars). So the submit pull retries —
  // bounded, human-triggered, stops at the first parse: four tries, 500ms apart, then it waits
  // for the next sanctioned moment. Not a drumbeat: a doorbell that stops ringing.
  const pull = async (retry = false): Promise<void> => {
    if (await pullOnce()) return
    if (!retry) return
    for (let i = 0; i < 4; i += 1) {
      await new Promise((res) => setTimeout(res, 500))
      if (closed || await pullOnce()) return
    }
  }
  void pull()
  const onVis = (): void => { try { if (document.visibilityState === 'visible') void pull() } catch { /* no document: mount pull already ran */ } }
  try { document.addEventListener('visibilitychange', onVis) } catch { /* headless test env */ }
  let prior = composerTextOf()
  let observer: MutationObserver | undefined
  let attachTimer: ReturnType<typeof setTimeout> | undefined
  const onComposerMutate = (): void => {
    const now = composerTextOf()
    if (/^\s*\/chapters[-a-z]*/i.test(prior) && now.trim() === '') { console.info('[client:chapters] command reply submit detected'); void pull(true) }
    prior = now
  }
  const attachComposer = (): boolean => {
    try {
      const el = document.querySelector('[data-composer-input]')
      if (el === null) return false
      observer = new MutationObserver(onComposerMutate)
      observer.observe(el, { childList: true, subtree: true, characterData: true, attributes: true })
      console.info('[client:chapters] command reply composer observer attached')
      return true
    } catch { return true } // no MutationObserver at all: mount + visibility pulls remain; stop retrying
  }
  // #429's mount-retry shape, DOM-side: the dock mounts BEFORE the composer hydrates, so the
  // first probe can find nothing — and an observer attached to nothing silently never fires
  // (measured in the reload leg 2026-11-27: mounted, no row). 8x2s of querySelector costs zero
  // wire nodes; #229's ban is on command drumbeats, not DOM lookups.
  if (!attachComposer()) {
    let attempts = 0
    const retry = (): void => {
      if (closed || attempts >= 8 || attachComposer()) return
      attempts += 1
      attachTimer = setTimeout(retry, 2_000)
    }
    attachTimer = setTimeout(retry, 2_000)
  }
  return () => {
    closed = true
    if (attachTimer !== undefined) clearTimeout(attachTimer)
    try { document.removeEventListener('visibilitychange', onVis) } catch { /* paired with the guarded add */ }
    observer?.disconnect()
  }
}

export interface CommandReplyProps {
  exec: (line: string) => Promise<string>
}

export function CommandReplyRow(props: CommandReplyProps): ReactElement | null {
  // ALL hooks first, unconditionally (#310's hook-order rule — the early returns below must
  // never change how many hooks ran).
  const [reply, setReply] = useState<CommandReply | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [dismissedSeq, setDismissedSeq] = useState<number | null>(null)
  useEffect(() => {
    // #590 triage breadcrumb: registered -> mounted -> pulls. A row that never appears is one
    // of these links, and the console names which. Silent is the failure mode this feature
    // exists to end.
    console.info('[client:chapters] command reply row mounted')
    return subscribeReply(props.exec, setReply)
  }, [props.exec])
  const excerpt = reply === null || reply.kind === 'running' ? '' : excerptOf(reply.text)
  const [suppressed, setSuppressed] = useState(false)
  // The host rendered it — no duplicate row. Re-decided per exchange, so a later command still
  // gets its own answer.
  useEffect(() => {
    setExpanded(false)
    const sup = reply !== null && excerpt !== '' && hostCardShowsReply(excerpt, document)
    if (reply !== null) console.info(`[client:chapters] command reply render decision: seq=${String(reply.seq)} suppressed=${String(sup)}`)
    setSuppressed(sup)
  }, [reply?.seq, excerpt])
  if (reply === null || reply.seq === dismissedSeq) return null
  if (suppressed) return null
  ensureReplyCss()
  const kindClass = reply.kind === 'error' ? ' dsh-chapters_replyError' : reply.kind === 'running' ? ' dsh-chapters_replyRunning' : ''
  return h(
    'div',
    { className: 'dsh-chapters_replyDock', 'data-chapters-reply': 'true' },
    h(
      'div',
      {
        className: `dsh-chapters_replyBar${kindClass}`,
        title: reply.kind === 'running' ? `${reply.line} — running` : `${reply.line} — ${reply.kind}`,
        onClick: () => { if (excerpt !== '') setExpanded((e) => !e) },
      },
      h('span', { className: 'dsh-chapters_replyLine' }, reply.kind === 'running' ? `> ${reply.line} …` : `> ${reply.line}`),
      excerpt === '' ? null : h('span', { className: expanded ? 'dsh-chapters_replyFull' : 'dsh-chapters_replyText' }, expanded ? reply.text : excerpt),
      h(
        'button',
        {
          type: 'button',
          className: 'dsh-chapters_replyBtn',
          'aria-label': 'Dismiss command reply',
          onClick: (ev: { stopPropagation(): void }) => { ev.stopPropagation(); setDismissedSeq(reply.seq) },
        },
        '\u00d7',
      ),
    ),
  )
}
