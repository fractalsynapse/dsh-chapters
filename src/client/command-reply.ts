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

/** One raw journal event as the follow wire carries it (measured against the pinned host's
 *  typert types: SessionEventEntry {type:'event', event: SessionWireEvent}). */
export interface WireEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

/** The newest command exchange, shaped for the row. Payload field names are the host's own,
 *  measured from the maintainer's live durable log (command/run {commandId,name,args},
 *  command/done {commandId,kind,text}). */
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
 * The newest command exchange in journal order. A done pairs with its run by commandId (the
 * done carries no name — measured); a run with no done above it is IN FLIGHT and renders as
 * 'running' — the honest answer to "did it hang?" that started this whole issue.
 */
export function lastCommandReply(events: readonly WireEvent[]): CommandReply | null {
  let done: Extract<WireEvent, { data: unknown }> | null = null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e === undefined) continue
    if (e.type === 'command/done') { done = e; break }
    if (e.type === 'command/run') {
      const d = e.data as { commandId?: string; name?: string; args?: string }
      return { line: `/${d.name ?? '?'}${d.args ?? ''}`, kind: 'running', text: '', seq: e.seq }
    }
  }
  if (done === null) return null
  const dd = done.data as { commandId?: string; kind?: string; text?: string }
  let line = '/command'
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e === undefined || e.type !== 'command/run') continue
    const rd = e.data as { commandId?: string; name?: string; args?: string }
    if (rd.commandId === dd.commandId) { line = `/${rd.name ?? '?'}${rd.args ?? ''}`; break }
  }
  return { line, kind: dd.kind ?? 'success', text: dd.text ?? '', seq: done.seq }
}

/**
 * Does the host already render this reply? The probe runs BEFORE the row mounts (once per new
 * exchange), so an excerpt found in the document is the host's card, not our own echo. Absent
 * document (tests, odd hosts) reads as "not shown" — fail-visible, never fail-silent.
 */
export function hostCardShowsReply(excerpt: string, doc?: { body?: { innerText?: string } } | undefined): boolean {
  if (excerpt === '') return false
  const text = doc?.body?.innerText
  if (typeof text !== 'string') return false
  return text.includes(excerpt.slice(0, 80))
}

/** The follow wire, typed narrowly: remote.session.follow(request, signal) -> async iterable of
 *  frames {type:'snapshot', records:[{type:'event',event}]} | {type:'event', event}. */
interface FollowFrame {
  type: string
  records?: readonly { type: string; event?: WireEvent }[]
  event?: WireEvent
}

export interface JournalRemote {
  session?: {
    follow?: (request: { address: { kind: 'session'; sessionId: string } }, signal?: AbortSignal) => AsyncIterable<FollowFrame>
  }
}

/**
 * Subscribe to the session journal and report the newest command exchange on every relevant
 * frame. Returns the teardown. A missing face (older host, federation gap) yields a silent
 * no-subscribe — the row simply never appears, which is the pre-#590 status quo, never a crash.
 */
export function subscribeJournal(remote: JournalRemote | undefined, sessionId: string, cb: (reply: CommandReply | null) => void): () => void {
  const follow = remote?.session?.follow
  if (typeof follow !== 'function') return () => { /* no journal face: nothing to tear down */ }
  const ac = new AbortController()
  let closed = false
  void (async () => {
    const events: WireEvent[] = []
    try {
      for await (const frame of follow({ address: { kind: 'session', sessionId } }, ac.signal)) {
        if (closed) return
        if (frame.type === 'snapshot') {
          for (const rec of frame.records ?? []) if (rec.event !== undefined) events.push(rec.event)
          cb(lastCommandReply(events))
        } else if (frame.type === 'event' && frame.event !== undefined) {
          const ev = frame.event
          if (ev.type === 'command/run' || ev.type === 'command/done') {
            events.push(ev)
            cb(lastCommandReply(events))
          }
        }
      }
    } catch { /* stream closed or wire error: the row keeps its last truth; a remount re-reads */ }
  })()
  return () => { closed = true; ac.abort() }
}

export interface CommandReplyProps {
  subscribe: (cb: (reply: CommandReply | null) => void) => () => void
}

export function CommandReplyRow(props: CommandReplyProps): ReactElement | null {
  // ALL hooks first, unconditionally (#310's hook-order rule — the early returns below must
  // never change how many hooks ran).
  const [reply, setReply] = useState<CommandReply | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [dismissedSeq, setDismissedSeq] = useState<number | null>(null)
  useEffect(() => props.subscribe(setReply), [props.subscribe])
  const excerpt = reply === null || reply.kind === 'running' ? '' : excerptOf(reply.text)
  const [suppressed, setSuppressed] = useState(false)
  // The host rendered it — no duplicate row. Re-decided per exchange, so a later command still
  // gets its own answer.
  useEffect(() => { setExpanded(false); setSuppressed(reply !== null && hostCardShowsReply(excerpt, document)) }, [reply?.seq, excerpt])
  if (reply === null || reply.seq === dismissedSeq) return null
  if (suppressed) return null
  const color = reply.kind === 'error' ? 'var(--color-danger, #d33)' : reply.kind === 'running' ? 'var(--color-warning, #b80)' : 'var(--color-fg-dimmed, #888)'
  return h(
    'div',
    {
      'data-chapters-reply': 'true',
      style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '4px 10px', borderLeft: `3px solid ${color}`, opacity: 0.92 },
      title: reply.kind === 'running' ? `${reply.line} — running` : `${reply.line} — ${reply.kind}`,
      onClick: () => { if (excerpt !== '') setExpanded((e) => !e) },
    },
    h('span', { style: { fontFamily: 'monospace', color } }, reply.kind === 'running' ? `> ${reply.line} …` : `> ${reply.line}`),
    excerpt === '' ? null : h(
      'span',
      { style: { color: 'var(--color-fg, #ccc)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: expanded ? 'pre-wrap' : 'nowrap', maxWidth: '60ch', flex: 1 } },
      expanded ? reply.text : excerpt,
    ),
    h(
      'button',
      {
        type: 'button',
        'aria-label': 'Dismiss command reply',
        style: { marginLeft: 'auto', border: 'none', background: 'none', color, cursor: 'pointer' },
        onClick: (ev: { stopPropagation(): void }) => { ev.stopPropagation(); setDismissedSeq(reply.seq) },
      },
      '×',
    ),
  )
}
