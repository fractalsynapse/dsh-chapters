/**
 * Chapter renderer: durable events in a seq range → one Markdown file, deterministically.
 *
 * This module is pure and cordis-free. The model never writes chapter text (invariant 4 in AGENTS.md) — it
 * supplies ranges, and every byte of the body comes from the log. So correctness here IS the "retrievable
 * memory" promise.
 *
 * Two hazards this file exists to handle:
 *
 * 1. **Fence collision.** Conversation text routinely contains ``` blocks. A Markdown file that embeds a
 *    triple-backtick fence inside a triple-backtick fence terminates early and silently truncates the rest
 *    of the chapter. `longerFence()` solves this by measuring the longest backtick run in the payload and
 *    using one longer. Verified by test, because the failure is invisible by eye.
 * 2. **Silent holes.** An event that renders to nothing must never vanish quietly — it is recorded in
 *    `stats.unrenderedSeqs` so a gap becomes a visible assertion rather than lost history.
 * 3. **Borrowed context.** Host-injected instruction/snapshot/catalog text is project state, not
 *    conversation: it is screened at this chokepoint (src/injections.ts) and replaced by a countable
 *    marker, so a project's own docs never travel in the shared knowledge corpus.
 */
import { createHash } from 'node:crypto'
import { DEFAULT_REDACTIONS, redactText } from './redact.ts'
import { omittedMarker, screenConversation, stripReminderSpans } from './injections.ts'
import { blocksOf, callArgsText, resultCallId, sameCall, textOfBlocks, toolResultText } from './log-shape.ts'
import { detectPlans, planTopicsOf, PLAN_TOOL, type PlanFact } from './plans.ts'
import type {
  ArtifactRef, ChapterRange, PlanDocFile, RenderConfig, RenderedChapter,
  SessionEventLike, ToolResultCandidate, ToolResultOverride,
} from './types.ts'

/** The invocation-argument head printed in the transcript when no artifact is written. */
const CALL_HEAD_CHARS = 400
/** The plan head printed inline under the Plans block when the full text is a reference. */
const PLAN_HEAD_FALLBACK_CHARS = 900

/** chars/4 until the host tokenMeter is wired in. Labelled an estimate everywhere it surfaces. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/**
 * A fence strictly longer than any backtick run inside `body`, so embedded code blocks cannot close it.
 * Markdown requires the closing fence to be at least as long as the opening one.
 */
export function longerFence(body: string): string {
  let max = 0
  for (const match of body.matchAll(/`+/g)) max = Math.max(max, match[0].length)
  return '`'.repeat(Math.max(3, max + 1))
}

/** Wrapped in a fence long enough to survive any content, including nested fences. */
export function fenced(content: string, info = ''): string {
  const fence = longerFence(content)
  return `${fence}${info}\n${content}\n${fence}`
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** `artifacts/8f/8f3a1c9d….txt` — sharded so one directory never holds the whole subtree. */
export const artifactPath = (hash: string): string => `artifacts/${hash.slice(0, 2)}/${hash}.txt`

export function artifactRef(
  text: string,
  opts: { toolName: string; sourceSeq: number; inlined: boolean },
): ArtifactRef {
  const hash = sha256(text)
  return {
    sha256: hash,
    path: artifactPath(hash),
    bytes: Buffer.byteLength(text, 'utf8'),
    content: text,
    inlined: opts.inlined,
    toolName: opts.toolName,
    sourceSeq: opts.sourceSeq,
  }
}

/**
 * `textOf` kept as the local name the renderer's call sites already use; the
 * implementation moved to log-shape.ts so the plan detector reads a payload
 * exactly the way the transcript does (docs/plans-carriage.md § 1).
 */
const textOf = textOfBlocks

/**
 * Validate model-supplied ranges. Never trust them (hard rule): an overlap duplicates archived text and a
 * gap silently drops history, so both are errors here rather than data that quietly goes missing.
 */
export function validateRanges(
  chapters: ChapterRange[],
  archiveCeiling: number,
): ChapterRange[] {
  if (chapters.length === 0) throw new Error('no chapters supplied')
  chapters.forEach((c, i) => {
    if (c.startSeq > c.endSeq) {
      throw new Error(`chapter ${i} ("${c.title}") has startSeq ${c.startSeq} above endSeq ${c.endSeq}`)
    }
    if (c.endSeq > archiveCeiling) {
      throw new Error(
        `chapter ${i} ("${c.title}") ends at seq ${c.endSeq}, past the archive ceiling ${archiveCeiling}`,
      )
    }
    if (i > 0) {
      const prev = chapters[i - 1]!
      if (c.startSeq <= prev.startSeq) {
        throw new Error(`chapter ${i} ("${c.title}") descends: starts ${c.startSeq} after ${prev.startSeq}`)
      }
      if (c.startSeq <= prev.endSeq) {
        throw new Error(
          `chapter ${i} ("${c.title}") overlaps "${prev.title}": ${c.startSeq}-${prev.endSeq} in both`,
        )
      }
    }
  })
  return chapters
}

/** Enumerate tool results in a range so the model can decide keep/defer against real sizes. */
export function toolResultCandidates(
  events: SessionEventLike[],
  range: ChapterRange,
): ToolResultCandidate[] {
  const out: ToolResultCandidate[] = []
  for (const ev of events) {
    if (ev.type !== 'tool/result' || ev.seq < range.startSeq || ev.seq > range.endSeq) continue
    {
      const msg = (ev.data as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
      const cid = (msg?.source as Record<string, unknown> | undefined)?.callId
      if (typeof cid === 'string') {
        let last = -1
        for (const o of events) if (o.type === 'tool/result' && o.seq >= range.startSeq && o.seq <= range.endSeq) {
          const om = (o.data as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
          if ((om?.source as Record<string, unknown> | undefined)?.callId === cid && o.seq > last) last = o.seq
        }
        if (ev.seq !== last) continue // keep last copy of a redelivery
      }
    }
    const text = toolResultText(ev.data ?? {})
    const call = events.find((c) => c.type === 'tool/call' && c.seq < ev.seq && sameCall(c, ev))
    out.push({
      seq: ev.seq,
      toolName: String((call?.data as Record<string, unknown> | undefined)?.name ?? (ev.data as Record<string, unknown> | undefined)?.toolName ?? 'tool'),
      bytes: Buffer.byteLength(text, 'utf8'),
      estimatedTokens: estimateTokens(text),
      excerpt: text.slice(0, 160),
    })
  }
  return out
}

/**
 * Render one chapter. `overrides` is the model's sparse exception list; anything not named follows the
 * default rule (small results inline, large ones deferred). Either way the artifact is written, so a wrong
 * call costs a `read` and never loses data.
 *
 * Plans (docs/plans-carriage.md § 2) are read over the WHOLE `events` list, not just the range: a
 * submission and its verdict can straddle a chapter boundary, and pairing them inside one range only
 * would report an approved plan as `pending`. The plans block is appended AFTER the verbatim
 * transcript, so the transcript stays exactly what the log said.
 */
export function renderChapter(
  events: SessionEventLike[],
  range: ChapterRange,
  config: RenderConfig,
  overrides: readonly ToolResultOverride[] = [],
  topics: readonly string[] = [],
  /** Optional CodeGraph symbols verified against the project index. Written to
   *  frontmatter when non-empty; absent → no field emitted (backward compatible). */
  codegraphSymbols?: readonly string[],
): RenderedChapter {
  const inline = new Map(overrides.map((o) => [o.seq, o.inline]))
  // render → redact → write: the single chokepoint, so chapters AND the
  // deferred artifact files (whose bodies are the redacted text, via
  // ArtifactRef.content) are covered without caller changes.
  const redact = (t: string): string => redactText(t, config.redactions ?? DEFAULT_REDACTIONS).text
  const inRange = events
    .filter((e) => e.seq >= range.startSeq && e.seq <= range.endSeq)
    .sort((a, b) => a.seq - b.seq)

  // Host redelivery (measured 2026-09-28, treeseed run: 25 calls carried TWO
  // tool/result events for one callId — read x17, chapters_artifact x3,
  // web_fetch x2): keep only the LAST result per callId, else the verbatim
  // body inflates with the same text twice and counts double.
  const lastResultSeq = new Map<string, number>()
  for (const ev of inRange) {
    if (ev.type !== 'tool/result') continue
    const cid = resultCallId(ev)
    if (cid !== undefined) lastResultSeq.set(cid, ev.seq)
  }
  // Plans are scanned over the WHOLE event list, not just this range: a verdict
  // can land past a chapter boundary, and pairing inside one range only would
  // report an APPROVED plan as pending (docs/plans-carriage.md § 1).
  const scan = detectPlans(events, { ceiling: range.endSeq })
  const chapterPlans = scan.plans.filter((p) => p.seq >= range.startSeq && p.seq <= range.endSeq)
  const flipsTo = scan.flips.filter((f) => f.seq <= range.endSeq)
  const modeAtEnd: 'active' | 'inactive' | 'unknown' =
    flipsTo.length === 0 ? 'unknown' : flipsTo[flipsTo.length - 1]!.active ? 'active' : 'inactive'
  const body: string[] = [`# ${range.title}`, '', `> ${range.summary}`, '']
  const artifacts: ArtifactRef[] = []
  const unrenderedSeqs: number[] = []
  let toolCalls = 0
  let inlinedCount = 0
  let deferredCount = 0
  let conversationMessages = 0
  let invocationArtifacts = 0

  for (const ev of inRange) {
    const data = (ev.data ?? {}) as Record<string, unknown>
    switch (ev.type) {
      case 'user/message': {
        // The one boundary (src/injections.ts): host-injected context — a
        // project's own instruction files, runtime snapshots, skill catalogs,
        // and THIS plugin's TOC notices — is not conversation. Whole injected
        // events render as a countable marker; injected spans inside human
        // messages are removed the same way. Originals stay in the session log.
        const screen = screenConversation(data, textOf(data.content), 'user')
        if (screen.omittedEvent) {
          body.push(omittedMarker(screen.sourceKind, screen.removedChars), '')
          break
        }
        if (screen.removedChars > 0) body.push(omittedMarker('<system-reminder> span(s)', screen.removedChars), '')
        const text = redact(screen.text)
        if (text.length === 0) {
          if (screen.removedChars === 0) unrenderedSeqs.push(ev.seq) // a marker above IS a render
          break
        }
        conversationMessages += 1
        body.push(`**User:**`, '', fenced(text), '')
        break
      }
      case 'assistant/message': {
        const message = (data.message ?? data) as Record<string, unknown>
        const asstSpans = stripReminderSpans(textOf(message.content))
        if (asstSpans.removedChars > 0) body.push(omittedMarker('<system-reminder> span(s)', asstSpans.removedChars), '')
        const text = redact(asstSpans.text)
        const reasoning = redact(stripReminderSpans(blocksOf(message.content)
          .filter((b) => b.type === 'reasoning')
          .map((b) => (b as { text?: string }).text ?? '')
          .join('\n')).text)
        let rendered = false
        if (reasoning.length > 0) { body.push('<sub>_reasoning:_</sub>', '', fenced(reasoning), ''); rendered = true }
        if (text.length > 0) { body.push(`**Assistant:**`, '', fenced(text), ''); rendered = true }
        if (rendered) conversationMessages += 1
        else if (asstSpans.removedChars === 0) unrenderedSeqs.push(ev.seq)
        break
      }
      case 'tool/call': {
        toolCalls += 1
        const name = String(data.name ?? 'unknown')
        const args = redact(callArgsText(data))
        if (name === PLAN_TOOL) {
          // The Plans block below owns this plan's bytes (full artifact + head +
          // outline + verdict). Point at it rather than printing a JSON envelope
          // whose head would look like the plan and is not.
          const doc = chapterPlans.find((p) => p.seq === ev.seq)
          body.push(`- ↳ **${name}** plan "${doc?.title ?? '(unparsed)'}" — verbatim text and the user's verdict in the Plans section below (seq ${ev.seq})`)
          break
        }
        const floor = config.callArgArtifactTokens ?? 0
        if (floor > 0 && estimateTokens(args) > floor) {
          // Large invocation arguments are artifact-backed, so the bounded head
          // below can never be the only copy of what was attempted.
          const ref = artifactRef(args, { toolName: name, sourceSeq: ev.seq, inlined: false })
          artifacts.push(ref)
          invocationArtifacts += 1
          body.push(`- ↳ **${name}** \`${args.slice(0, CALL_HEAD_CHARS)}\`${args.length > CALL_HEAD_CHARS ? ' …' : ''} (seq ${ev.seq})`
            + ` — full arguments: ${ref.bytes} B ≈ ${estimateTokens(args)} tok, \`${ref.sha256.slice(0, 7)}…\` → \`${ref.path}\``)
          break
        }
        // Invocations stay inline as a bounded head: this is the "what was
        // attempted" half of the record (docs/architecture.md § Chapter Rendering).
        body.push(`- ↳ **${name}** \`${args.slice(0, CALL_HEAD_CHARS)}\`${args.length > CALL_HEAD_CHARS ? ' …' : ''} (seq ${ev.seq})`)
        break
      }
      case 'plan/mode':
        // NOT a hole and NOT prose: the mode flip is printed in the Plans block
        // below and folded into the `planMode:` frontmatter line. Naming the type
        // here is what keeps it out of unrenderedSeqs — an unnamed event would
        // look like a silently dropped byte (verify.md P4).
        break
      case 'tool/result': {
        {
          const cid = resultCallId(ev)
          if (cid !== undefined && lastResultSeq.get(cid) !== ev.seq) break // earlier copy of a redelivery
        }
        const text = redact(toolResultText(data))
        const tokens = estimateTokens(text)
        const wantsInline = inline.get(ev.seq) ?? tokens <= config.toolResultDeferFloorTokens
        const priorCall = [...inRange].reverse().find((c) => c.type === 'tool/call' && c.seq < ev.seq)
        const toolName = String((priorCall?.data as Record<string, unknown> | undefined)?.name ?? 'tool')
        const ref = artifactRef(text, { toolName, sourceSeq: ev.seq, inlined: wantsInline })
        artifacts.push(ref)
        if (wantsInline) {
          inlinedCount += 1
          body.push(`  - result (seq ${ev.seq}, ${ref.bytes} B, also at \`${ref.path}\`):`, '', fenced(text), '')
        } else {
          deferredCount += 1
          body.push(`  - result: ${ref.bytes} B ≈ ${tokens} tok, \`${ref.sha256.slice(0, 7)}…\` → \`${ref.path}\``)
        }
        break
      }
      case 'turn/start':
      case 'turn/end':
      case 'step/start':
      case 'step/end':
        break // lifecycle noise: intentionally absent from the body, ranges still recorded in frontmatter
      default:
        unrenderedSeqs.push(ev.seq)
    }
  }

  // ---- Plans block, AFTER the verbatim transcript (docs/plans-carriage.md § 2).
  // Absent entirely when the chapter holds no plan and no mode flip — a session
  // that never entered plan mode gains ZERO extra bytes, which is what keeps the
  // model tapes byte-identical (verify.md P8).
  const planFacts: PlanFact[] = []
  const planDocs: PlanDocFile[] = []
  const flipsInRange = scan.flips.filter((f) => f.seq >= range.startSeq && f.seq <= range.endSeq)
  if (chapterPlans.length > 0 || flipsInRange.length > 0) {
    body.push('', '---', '', '## Plans in this chapter', '')
    for (const p of chapterPlans) {
      const planBody = redact(p.text)
      const ref = artifactRef(planBody, { toolName: PLAN_TOOL, sourceSeq: p.seq, inlined: false })
      artifacts.push(ref)
      const tokens = estimateTokens(planBody)
      planFacts.push({
        seq: p.seq,
        status: p.status,
        title: p.title,
        sha256: ref.sha256,
        artifactPath: ref.path,
        bytes: ref.bytes,
        estTokens: tokens,
        resultSeq: p.resultSeq,
      })
      const kb = ref.bytes < 1024 ? `${ref.bytes} B` : `${(ref.bytes / 1024).toFixed(1)} KB`
      body.push(`### Plan — "${p.title}" — ${p.status.toUpperCase()}`, '')
      body.push(`- verdict: submitted seq ${p.seq}`
        + (p.resultSeq !== null
          ? ` → answered seq ${p.resultSeq}: \`${(p.verdict ?? '').slice(0, 200).replace(/`/g, '\'')}\``
          : ' — NO RESULT: the review was never answered (pending); do not treat this as approved'))
      body.push(`- full text: \`${ref.path}\` (${kb} ≈ ${tokens} tok, \`${ref.sha256.slice(0, 7)}…\`) — query it with chapters_artifact (path or sha): action 'toc' | 'search' | 'read'`)
      if (p.outline.length > 0) body.push(`- outline: ${p.outline.join(' · ')}`)
      const headChars = config.planInlineChars ?? PLAN_HEAD_FALLBACK_CHARS
      if (headChars > 0 && planBody.length > 0) {
        body.push(`- head (first ${headChars} chars, verbatim):`, '', fenced(planBody.slice(0, headChars)), '')
      }
      if (p.status === 'superseded') {
        body.push('- this submission was superseded by a later one of the same plan — the newest is operative')
      }
      // The plan ALSO becomes a document of its own (docs/plans-carriage.md § 11):
      // indexed by topic, searchable as a plan, and addressable across sessions —
      // which is what "how did this plan evolve, and what happened to it" needs.
      // The artifact stays the content-addressed retrieval handle; the document is
      // the queryable record. Same bytes, two addressing roles, one write each.
      planDocs.push({
        seq: p.seq,
        title: p.title,
        status: p.status,
        body: planBody,
        sha256: ref.sha256,
        topics: [...new Set(planTopicsOf(planBody))],
        estTokens: tokens,
      })
      body.push('')
    }
    for (const f of flipsInRange) {
      body.push(`- plan mode ${f.active ? 'ACTIVE' : 'inactive'} from seq ${f.seq} (log event plan/mode)`)
    }
    body.push(`- plan mode at chapter end: ${modeAtEnd}`)
  }

  const bodyText = body.join('\n')
  const estimatedTokens = estimateTokens(bodyText)
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(range.title)}`,
    `seqRange: [${range.startSeq}, ${range.endSeq}]`,
    `events: ${inRange.length}`,
    `tokens: ${estimatedTokens}  # chars/4 estimate`,
    // The declared anchor MUST hash exactly what parseChapterFile returns as
    // the body (file = frontmatter + bodyText + '\n' ⇒ parsed body carries the
    // trailing newline). Hashing bare bodyText made EVERY real chapter fail
    // the enrich guard's self-consistency check — caught by the enrich e2e
    // 2026-09-23, invisible for eras behind the host logger.
    `sha256: ${sha256(`${bodyText}\n`)}`,
    `topics: [${[...new Set(topics)].map((t) => JSON.stringify(t)).join(', ')}]`,
    `artifacts: ${artifacts.length}`,
    // Plans ride in frontmatter ONLY when this chapter actually carries one, so a
    // session that never entered plan mode writes byte-identical files to before
    // this feature (verify.md P8). Compact `seq:status:sha8` triples: the minimal
    // parser in indexing.ts reads flat scalar lists, never nested YAML. The full
    // facts live in the registry record; the prose lives in the Plans block.
    ...(planFacts.length > 0
      ? [`plans: [${planFacts.map((p) => `${p.seq}:${p.status}:${p.sha256.slice(0, 8)}`).join(', ')}]`]
      : []),
    ...(chapterPlans.length > 0 || flipsInRange.length > 0 ? [`planMode: ${modeAtEnd}`] : []),
    // CodeGraph symbols verified against the project index during this chapter's
    // turns. Written ONLY when non-empty so existing chapters stay byte-identical.
    ...(codegraphSymbols !== undefined && codegraphSymbols.length > 0
      ? [`codegraphSymbols: [${[...new Set(codegraphSymbols)].map((s) => JSON.stringify(s)).join(', ')}]`]
      : []),
    // Subagent lineage (issue #47): stamped ONLY when the authoring session's
    // header carries parentSession — a plain session's file is byte-identical to
    // the pre-feature shape (verify discipline same as the plans block, P8), and
    // the value is the host's own durable fact, never an inference.
    ...(config.subagentOf !== undefined && config.subagentOf !== ''
      ? ['subagent: true', `parentSession: ${JSON.stringify(config.subagentOf)}`]
      : []),
    `unrenderedSeqs: [${unrenderedSeqs.join(', ')}]`,
    '---',
    '',
  ].join('\n')

  return {
    range,
    topics: [...new Set(topics)],
    markdown: frontmatter + bodyText + '\n',
    artifacts,
    stats: {
      estimatedTokens,
      estimatedBytes: Buffer.byteLength(bodyText, 'utf8'),
      events: inRange.length,
      messages: conversationMessages,
      toolCalls,
      toolResultsInlined: inlinedCount,
      toolResultsDeferred: deferredCount,
      overTarget: estimatedTokens > config.chapterTokenTarget,
      unrenderedSeqs,
      plans: planFacts,
      planDocs,
      planMode: modeAtEnd,
      invocationArtifacts,
    },
  }
}

/**
 * The cumulative index that replaces compacted history. Built from registry records, never from an LLM —
 * which is the entire latency argument: no summarization call, no tokens, no paraphrase.
 */
export function renderIndex(entries: readonly { path: string; title: string; summary: string }[]): string {
  return entries
    .map((e, i) => `${i + 1}. [${e.title}](${e.path}) — ${e.summary}`)
    .join('\n')
}
