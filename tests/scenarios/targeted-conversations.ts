/**
 * Targeted-conversation scenario catalog (#456, maintainer strategy).
 *
 * The doctrine: TOC-related tests must not steer on synthetic filler. These scenarios are
 * targeted CONVERSATIONS ABOUT THIS PROJECT that trigger FILE READS of real repository
 * files, so real data drives the show — and because the topics VARY, split correctness is
 * checkable by construction: the expected chapter boundaries are a property of the scripted
 * conversation, never a memorized constant. The same transcripts feed enrichment-input and
 * suggested-next-step assertions, so one varied subject exercises the whole chain
 * (ranges → topics → enrich input → suggestion routing).
 *
 * Every referenced file must exist in THIS repo — the catalog self-checks at import,
 * because a scenario that reads nothing real is the weakness being fixed.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SessionEventLike } from '../../src/types.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

export interface ConversationTopic {
  /** stable id, used in expectations and as the vocabulary marker of the topic */
  id: string
  /** REAL repository files the session reads — the conversation's subject */
  files: string[]
  /** the human's question — prose carries the paths and the distinctive terms */
  ask: string
  /** terms woven into replies; distinctive per topic so topic bleed is visible */
  terms: string
}

export const TARGETED_TOPICS: readonly ConversationTopic[] = [
  {
    id: 'storage',
    files: ['src/registry.ts', 'docs/architecture.md'],
    ask: 'Why is the durable session log append-only, and how does the watermark survive removed stubs?',
    terms: 'watermark append-only immutability',
  },
  {
    id: 'preset',
    files: ['src/preset.ts', 'docs/contract.md'],
    ask: 'Why must the chapters preset drop host rows this host cannot import, and what does DECLARED BUT BROKEN do to composition?',
    terms: 'preset drop-guard declaration',
  },
  {
    id: 'matrix',
    files: ['scripts/matrix-run.mts', 'docs/development.md'],
    ask: 'How does the version sweep re-resolve the whole hat family per version and keep the README verdict honest about its provenance?',
    terms: 'provenance sweep verdict',
  },
]

for (const t of TARGETED_TOPICS) {
  for (const f of t.files) {
    if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`scenario file missing: ${f}`)
  }
}

/** The token estimator deriveRanges uses internally: JSON bytes / 4, per-event ceiling. */
const tokens = (e: SessionEventLike): number => Math.ceil(JSON.stringify(e.data ?? {}).length / 4)

const headOf = (file: string, chars: number): string =>
  fs.readFileSync(path.join(ROOT, file), 'utf8').slice(0, chars)

export interface BuiltConversation {
  events: SessionEventLike[]
  /** turn/end seqs in order — the only places a split may land */
  boundaries: number[]
  /** topic id per turn, aligned with boundaries */
  topicOfTurn: string[]
  /** estimated tokens per turn (same order as boundaries) */
  tokensPerTurn: number[]
  /** the human question of each turn (for per-chapter slices) */
  askOfTurn: string[]
}

/**
 * Build the transcript: per topic, per round — the human asks (naming real paths in prose),
 * each file is read through a genuine tool/call whose result carries REAL bytes, the
 * assistant replies with the topic's terms plus a real quoted line, and the turn ends.
 * Everything the signature extractor can see is content this project actually contains.
 */
export function buildConversation(
  topics: readonly ConversationTopic[] = TARGETED_TOPICS,
  roundsPerTopic = 2,
): BuiltConversation {
  const events: SessionEventLike[] = []
  const boundaries: number[] = []
  const topicOfTurn: string[] = []
  const tokensPerTurn: number[] = []
  const askOfTurn: string[] = []
  let seq = 0
  let turn = 0

  const emit = (partial: Omit<SessionEventLike, 'seq'> & { seq?: number }): void => {
    events.push({ ...partial, seq: seq++ } as SessionEventLike)
  }

  for (const t of topics) {
    for (let r = 1; r <= roundsPerTopic; r++) {
      const before = events.length
      const question = r === 1 ? t.ask : `${t.ask.split('?')[0]}? Go deeper on round ${r}.`
      askOfTurn.push(question)
      emit({
        type: 'user/message',
        data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: question }] },
      })
      const quoted: string[] = []
      for (const f of t.files) {
        emit({ type: 'tool/call', data: { name: 'read', arguments: { path: f } } })
        const bytes = headOf(f, 480)
        emit({ type: 'tool/result', data: { content: [{ type: 'text', text: `${f}: ${bytes}` }] } })
        quoted.push((bytes.split('\n').find((l) => l.trim().length > 12) ?? bytes).trim())
      }
      emit({
        type: 'assistant/message',
        data: {
          id: `a${turn}`, role: 'assistant', source: { kind: 'assistant' },
          content: [{
            type: 'text',
            text: `On ${t.id} — ${t.terms}: from ${t.files.join(' and ')}: ${quoted.join(' / ')}`,
          }],
        },
      })
      emit({ type: 'turn/end', data: { turn: ++turn } })
      boundaries.push(seq - 1)
      topicOfTurn.push(t.id)
      tokensPerTurn.push(events.slice(before).reduce((n, e) => n + tokens(e), 0))
    }
  }
  return { events, boundaries, topicOfTurn, tokensPerTurn, askOfTurn }
}

/**
 * A cut value that forces segmentation to split AT every topic change and NOWHERE ELSE,
 * computed from the transcript's own measurements: strictly above the largest first-round
 * (so a topic's opening round never cuts alone) and at or below the smallest whole topic
 * (so a full topic always cuts). Returns null when the topic sizes cannot bracket — the
 * test then says so instead of asserting a memorized target.
 */
export function cutInterval(built: BuiltConversation): { lo: number; hi: number } | null {
  const firstRound = new Map<string, number>()
  const whole = new Map<string, number>()
  for (let i = 0; i < built.boundaries.length; i++) {
    const topic = built.topicOfTurn[i]!
    if (!firstRound.has(topic)) firstRound.set(topic, built.tokensPerTurn[i]!)
    whole.set(topic, (whole.get(topic) ?? 0) + built.tokensPerTurn[i]!)
  }
  const lo = Math.max(...firstRound.values())
  const hi = Math.min(...whole.values())
  return lo < hi ? { lo, hi } : null
}

/** deriveRanges cuts at ceil(target*0.9); pick the smallest target whose cut lands in (lo, hi]. */
export function targetForInterval(iv: { lo: number; hi: number }): number {
  for (let target = iv.lo + 2; target <= iv.hi * 4; target++) {
    const cut = Math.max(1, Math.floor(target * 0.9))
    if (cut > iv.lo && cut <= iv.hi) return target
  }
  throw new Error('no target brackets the topic interval')
}

/**
 * #456 Tier B bridge: the COMPOSE journey's recorded conversation, hoisted verbatim into
 * the catalog as the pattern for the campaign. These strings are message-0/turn KEYS of
 * the committed tapes (boot.ts: 'Message 0 is the tape key') — any change here MUST be
 * followed by a governed `scripts/corpus-campaign.sh` re-distill, never a lone re-record.
 * The migration is byte-identical BY CONSTRUCTION: run the compose replay leg and it must
 * pass against the pre-existing tapes; that is the bridge's own proof.
 */
export const COMPOSE_JOURNEY = {
  docs: { arch: 'docs/architecture.md', dev: 'docs/development.md' },
  codewords: { topic1: 'SUNSTONE-41', topic2: 'BREADCRUST-77' },
  turnTopic1: 'Discussion about this workspace, no side tasks: read docs/architecture.md with ONE read call, offset 1 limit 20. In two or three sentences, what does that opening say about the durable session log? Include the codeword SUNSTONE-41 verbatim in your reply, then stop.',
  turnTopic2: 'New topic about this repo, same rules — no side tasks: read docs/development.md with ONE read call, offset 1 limit 20. In two or three sentences, what does it say about why the tests isolate homes and ports? Include the codeword BREADCRUST-77 verbatim, then stop.',
  turnCrossing: 'Bigger task on this repo: read site/src/content/docs/operations/changelog.md using the read tool in EXACTLY THREE calls, no more and no fewer: offset 1 limit 600, then offset 601 limit 600, then offset 1201 limit 600. Do NOT read any other range, do NOT read the whole file in one call, and do NOT use grep or bash. Afterwards finish with one short answer, then stop.',
  deliveryProbes: { topic2: 'New topic about this repo', crossing: 'Bigger task on this repo' },
} as const
