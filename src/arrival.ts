/**
 * Arrival-time artifacting (record architecture.md amendment, 2026-09-19):
 * tool results at or above the floor never get to become context. The blob
 * goes to the content-addressed artifact store; the surface node is replaced
 * IN PLACE (the pruner's proven single-node form: a shadowing event + a
 * replacement append carrying `surfaceOp: replace`) with a stub that cites
 * the path and the query tool. Runs at the head of compactIfNeeded/compactNow,
 * i.e. inside the awaited `agent/pre-step` chain, BEFORE the next request is
 * composed — so the blob is prefilled zero times, ever.
 *
 * A plain factory over structural shims, per house rule (the r28 lesson:
 * the LOGIC must be L0-testable against the real host Session shape).
 */
import { artifactPath, sha256 } from './render.ts'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveStoreRoot } from './store.ts'

export interface ArrivalSessionShim {
  surface: { nodes: number[] }
  eventAt(seq: number): { type: string; data: unknown } | undefined | null
  append(type: string, data: unknown, opts?: unknown): unknown
}

export const ARRIVAL_MARKER = '[dsh:artifact'

export interface ArrivalOpts {
  cwd: string
  storeRoot: string
  floorTokens: number
  /** message → estimated tokens (host tokenMeter injected; tests use chars/4). */
  estimate: (message: unknown) => number
}

export interface ArrivalResult {
  stubbed: number
  detail?: string
}

const kb = (n: number): string => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`

export async function applyArrivalStubs(session: ArrivalSessionShim, opts: ArrivalOpts): Promise<ArrivalResult> {
  let stubbed = 0
  // #131: resolve each result's tool name once, so an artifact ANSWER can be exempted below.
  //
  // Arrival-time deferral was applied to `chapters_artifact`'s own output: asking to read a stored blob returned
  // ANOTHER stub pointing at ANOTHER blob, so the store became unreachable at exactly the sizes it exists for, and
  // the `arrival` leg's model called the tool 20 times before the run gave up. A query answer is the payload the
  // caller reached for — economizing it is a cycle, not context relief. The tool already bounds its own output per
  // action (`limit`, `maxTokens`), so nothing needs a second layer here.
  const nameByCall = new Map<string, string>()
  for (const seq of [...session.surface.nodes]) {
    const ev = session.eventAt(seq)
    if (ev?.type !== 'tool/call') continue
    const d = ev.data as { callId?: unknown, name?: unknown } | undefined
    if (typeof d?.callId === 'string' && typeof d?.name === 'string') nameByCall.set(d.callId, d.name)
  }
  const isArtifactAnswer = (message: Record<string, unknown>): boolean => {
    const src = message.source as { callId?: unknown } | undefined
    const wrappers = Array.isArray(message.content) ? message.content as { toolCallId?: unknown }[] : []
    const ids: unknown[] = [src?.callId, message.toolCallId, ...wrappers.map((w) => w?.toolCallId)]
    return ids.some((id) => typeof id === 'string' && nameByCall.get(id) === 'chapters_artifact')
  }
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const data = event.data as {
      message: { content?: { type?: string; text?: string }[] } & Record<string, unknown>
    } | undefined
    if (data?.message === undefined) continue
    // REAL shape (measured e2e, 2026-09-19): message.content blocks are
    // { type: 'tool-result', toolCallId, isError, content: [{type:'text',text}] }
    // — the text is nested one level below the wrapper. A unit fixture that
    // invented a flat shape hid this for a whole run; the fake mirrors the
    // real from now on.
    const blocks: any[] = Array.isArray(data.message.content) ? data.message.content
      : typeof data.message.content === 'string' ? [{ type: 'text', text: data.message.content }] : []
    // TWO real shapes, one per host generation — both measured, neither assumed.
    //  0.1.x: content = [{ type: 'tool-result', toolCallId, isError, content: [{type:'text',text}] }]
    //  0.2.0-rc.2: content = [{ type: 'text', text }]  ← flattened; measured 2026-10-22 in the
    //    arrival leg's own durable log (seq 51, 54,763 bytes; message keys role,source,toolCallId,
    //    content,isError,id; block keys type,text).
    // Recognizing only the first meant `wrappers.length === 0` on EVERY result of the new host:
    // nothing stubbed, `detail` unset, and no line anywhere — which is how arrival artifacting
    // vanished from the whole acceptance chain while the engine's entry line proved it was running.
    const wrappers = blocks.filter((b: any) => b?.type === 'tool-result')
    const carriers: any[] = wrappers.length > 0 ? wrappers : blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    if (carriers.length === 0) continue
    const textOf = (w: any): string => Array.isArray(w.content)
      ? w.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text ?? '').join('')
      : typeof w.content === 'string' ? w.content
      : typeof w.text === 'string' ? w.text : ''
    const text = carriers.map(textOf).join('')
    if (text.length === 0 || text.includes(ARRIVAL_MARKER)) continue
    if (isArtifactAnswer(data.message)) continue // #131 — a pointer to a pointer is not relief
    const tokens = opts.estimate(data.message)
    if (tokens < opts.floorTokens) continue
    const hash = sha256(text)
    const rel = artifactPath(hash)
    const abs = path.join(resolveStoreRoot(opts.cwd, opts.storeRoot), rel)
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 })
      // content-addressed: rewriting identical bytes is a no-op by definition
      await fs.writeFile(abs, text, 'utf8')
    } catch (error) {
      // the blob stays inline — arrival artifacting is an optimization, and a
      // disk problem must never eat the conversation (loud via detail).
      return { stubbed, detail: `artifact write failed (${String((error as Error)?.message ?? error)}); ${stubbed} node(s) stubbed before the failure` }
    }
    const stub = `${ARRIVAL_MARKER} ${hash.slice(0, 12)}] ${kb(text.length)} ≈ ${tokens} tok stored at ${rel} — query it with chapters_artifact (path '${rel}' or the sha): action 'toc' for the heading map with line numbers, 'search' for term hits as small blocks, 'read' for exact line ranges. The full result is NOT elsewhere in this context; re-running the original tool only recreates it.`
    // the stub goes back in the shape it arrived: nested wrappers keep their `content` blocks,
    // flattened v4 blocks keep their own `text` and their `type: 'text'` — a replacement that
    // changed the block type would be a new shape assumption on the read side.
    const stubbedCarriers = carriers.map((w: any, i: number) => (wrappers.length > 0 && Array.isArray(w.content))
      ? { ...w, content: [{ type: 'text', text: i === 0 ? stub : '' }] }
      : { ...w, text: i === 0 ? stub : '' })
    const message = {
      ...data.message,
      content: [...blocks.filter((b: any) => !carriers.includes(b)), ...stubbedCarriers],
    }
    try {
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: tokens,
        by: 'dsh-chapters-arrival',
      })
      session.append('tool/result', { ...data, message }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      stubbed++
    } catch (error) {
      return { stubbed, detail: `surface replace refused at seq ${seq} (${String((error as Error)?.message ?? error)})` }
    }
  }
  return { stubbed }
}
