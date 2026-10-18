/**
 * The TOC notice: the single synthetic `user/message` that seeds a continuation.
 *
 * This module exists because of the 66-log lesson from `dsh-session-fork`
 * (docs/development.md § L1): a message source outside the kernel's accepted
 * vocabulary is not a cosmetic bug — stored logs that fail replay refuse to
 * load, retroactively. The kernel's seed validator is not published as a
 * callable, so the vocabulary here is pinned two ways and guarded by
 * test/notice.test.ts + the v4 admission rows in tests/unit/host-seed-contract.test.ts:
 *
 *  1. Behaviorally, from the Phase 0 seed probes and the 2026-10-18 v4 drift
 *     (issue #43) — the retired forms are reproduced as refusals, not dropped:
 *     a string `source` was rejected as `invalid source`; session format v4
 *     rejects the bare `kind: 'plugin'` wrapper with the kernel's own words,
 *     "format v4 message requires a producer-owned source kind"
 *     (`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:126`,
 *     `dsh-session-persistence-jsonl/lib/worker.cjs:10902` on 0.2.0-rc.2).
 *  2. Structurally, against the installed kernel: `role: 'user'`; a non-empty
 *     string `id`; array `content`; contiguous seed from `seq = 0`;
 *     `source.kind` a non-empty producer-owned string; `ContextForm` values
 *     `instructions | catalog | notice | relay | recall | snapshot`
 *     (`dsh-llm/lib/types/message.d.ts` — verified against 0.2.0-rc.2).
 *
 * v4 source attribution: each producer OWNS its kind. Third-party producers
 * use the `plugin:<id>` form — measured live, the 0.2.0-rc.2 host writes its
 * own logs with `plugin:dsh-codegraph` + `form: 'notice'`. So the notice
 * carries `{ kind: 'plugin:dsh-chapters', form: 'snapshot', sections: [...] }`
 * and NO `plugin` field (the v3→v4 migration's own `rewritePluginSource`
 * drops it: "kind is the producer's own kind and whose `plugin` field is
 * dropped"). `sourceLabel` renders `plugin:dsh-chapters` for BOTH the retired
 * wrapper and the colon kind — byte-identically — so omission markers in
 * already-archived chapters keep matching.
 * INVARIANT 2: exactly one event, at seq 0. Never a slice of the parent's log.
 */
import type { SessionEventLike } from './types.ts'

/** Our producer id. Changing this orphans every already-seeded continuation. */
export const NOTICE_PLUGIN = 'dsh-chapters'

/** The v4 producer-owned source kind (issue #43). `plugin:<producer>` is the
 *  form the 0.2.x kernel itself admits for third-party producers; the bare
 *  `plugin` wrapper it retired. */
export const NOTICE_SOURCE_KIND = `plugin:${NOTICE_PLUGIN}`

/** The section name our TOC rides under inside the snapshot. */
export const NOTICE_SECTION = 'chapters:toc'

/**
 * The kinds this plugin may emit, pinned to what the installed v4 kernel
 * admits (seed/load boundary + persistence row admission). The retired v3
 * `plugin` wrapper is deliberately NOT in this list — it is refused below
 * with the kernel's own refusal text.
 */
export const ACCEPTED_SOURCE_KINDS = ['user', NOTICE_SOURCE_KIND] as const

/** `ContextForm` values, exactly as published (semantic, never visual). */
export const ACCEPTED_CONTEXT_FORMS = [
  'instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall',
] as const

export interface TocNoticeOptions {
  /** Fresh unique id per notice — the kernel rejects a seed message without one. */
  newId: () => string
  time?: number
}

/**
 * Build the one seed event for a continuation. Throws rather than emit an
 * event the kernel would reject at seed time — a refusal here is cheap, a
 * bricked log is not.
 */
export function buildTocNotice(tocText: string, opts: TocNoticeOptions): SessionEventLike {
  if (tocText.trim().length === 0) throw new Error('chapters: TOC notice text must not be empty')
  const id = opts.newId()
  if (id.length === 0) throw new Error('chapters: notice message needs a non-empty id ("lacks an identified message")')
  const event: SessionEventLike = {
    type: 'user/message',
    seq: 0, // seeds must be contiguous from 0 (FINDINGS: a seq-3 seed is rejected)
    time: opts.time ?? Date.now(),
    surfaceOp: 'append',
    data: {
      id,
      role: 'user',
      source: {
        kind: NOTICE_SOURCE_KIND,
        form: 'snapshot' as const,
        sections: [{ name: NOTICE_SECTION, text: tocText }],
      },
      // content mirrors sections[0].text byte-identically: the model reads
      // `content`; the UI and attribution read `source`. One text, two faces.
      content: [{ type: 'text' as const, text: tocText }],
    },
  }
  assertKernelAcceptedUserMessage(event)
  return event
}

/**
 * Transcription of the kernel's seed-time checks (message-shape + v4 source
 * admission + the recorded rejections). Kept as an exported predicate so tests
 * pin our output against the same rules the host applies, and any future
 * notice variant fails HERE, at the boundary of authorship. The v4 rows are
 * drift-gated against the kernel's own admission function
 * (`dsh-session-format-v3-to-v4` `assertV4RowAdmission`) in
 * tests/unit/host-seed-contract.test.ts — this transcription is the fast lane,
 * the kernel is the authority.
 */
export function assertKernelAcceptedUserMessage(event: SessionEventLike): void {
  if (event.type !== 'user/message') throw new Error(`chapters: unexpected notice event type ${event.type}`)
  const data = event.data as
    | { id?: unknown; role?: unknown; source?: unknown; content?: unknown }
    | undefined
  if (data === undefined || typeof data !== 'object') throw new Error('chapters: notice event needs data')
  if (typeof data.id !== 'string' || data.id.length === 0) {
    throw new Error('chapters: seed user/message lacks an identified message')
  }
  if (data.role !== 'user') throw new Error('chapters: seed message must have role "user"')
  const source = data.source as { kind?: unknown; plugin?: unknown; form?: unknown } | undefined
  if (source === undefined || typeof source !== 'object' || typeof source.kind !== 'string' || source.kind.length === 0) {
    throw new Error('chapters: seed message has invalid source (object with non-empty string kind required)')
  }
  // The retired v3 wrapper, refused with the kernel's own v4 words — reproducing
  // the production refusal at our authorship boundary (issue #43).
  if (source.kind === 'plugin') {
    throw new Error('chapters: format v4 message requires a producer-owned source kind (use plugin:dsh-chapters; the bare plugin wrapper was retired)')
  }
  if (!(ACCEPTED_SOURCE_KINDS as readonly string[]).includes(source.kind)) {
    throw new Error(`chapters: source kind "${source.kind}" is outside the pinned vocabulary`)
  }
  if (source.form !== undefined && !(ACCEPTED_CONTEXT_FORMS as readonly string[]).includes(source.form as string)) {
    throw new Error(`chapters: context form "${String(source.form)}" is outside the published ContextForm union`)
  }
  if (!Array.isArray(data.content) || data.content.length === 0) {
    throw new Error('chapters: seed message has invalid content')
  }
}
