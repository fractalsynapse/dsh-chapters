/**
 * #456 Tier A — targeted-conversation TOC/enrichment/suggestion tests.
 *
 * The maintainer's doctrine: these systems "have all been a pain in the ass because of the
 * weakness of the tests" — the old legs steered on synthetic filler with memorized shapes.
 * Here the SHOW IS DRIVEN BY REAL DATA: scripted conversations ABOUT THIS PROJECT that read
 * real repository files, whose topic variation makes split correctness checkable by
 * construction. Every assertion follows the conversation; the mutation rows prove it: shuffle
 * the topics and the expectations MUST move, because they are properties of the input, not
 * constants of the test.
 *
 * Chains exercised (all production functions, no fakes of the logic under test):
 *   deriveRanges (segmentation) → topic attribution via chapterTopics (signature floor)
 *   validateRanges (coverage contract)  ·  buildEnrichInput (P2 input)
 *   lastTurnFromEvents + queryTopics/selectRules (suggested-next-step conditioning)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRanges } from '../../src/continue-core.ts'
import { chapterTopics } from '../../src/signature.ts'
import { validateRanges } from '../../src/render.ts'
import { buildEnrichInput } from '../../src/enrich.ts'
import { lastTurnFromEvents } from '../../src/prompt.ts'
import { queryTopics } from '../../src/session-rules.ts'
import { selectRules, type MirrorRule } from '../../src/rules.ts'
import {
  TARGETED_TOPICS, buildConversation, cutInterval, targetForInterval,
  type BuiltConversation, type ConversationTopic,
} from '../scenarios/targeted-conversations.ts'

const topicByTurn = (built: BuiltConversation): Map<number, string> =>
  new Map(built.boundaries.map((seq, i) => [seq, built.topicOfTurn[i]!]))

const buildFor = (order: readonly ConversationTopic[]): BuiltConversation => {
  const built = buildConversation(order, 2)
  const iv = cutInterval(built)
  assert.ok(iv !== null, 'topic sizes bracket a cut; scenario files changed drastically?')
  return built
}

const targetFor = (built: BuiltConversation): number => {
  const iv = cutInterval(built)
  assert.ok(iv !== null)
  return targetForInterval(iv)
}

const filesOf = new Map(TARGETED_TOPICS.map((t) => [t.id, t.files]))

test('#456: a varied conversation splits AT the topic changes and NOWHERE ELSE', () => {
  const built = buildFor(TARGETED_TOPICS)
  const { chapters } = deriveRanges(built.events, built.boundaries[built.boundaries.length - 1]!, targetFor(built), 0)
  // one chapter per topic, exactly — boundaries were forced by the measured cut interval
  assert.equal(chapters.length, TARGETED_TOPICS.length, JSON.stringify(chapters.map((c) => [c.startSeq, c.endSeq])))
  const ownerByEnd = topicByTurn(built)
  for (const [i, ch] of chapters.entries()) {
    const want = TARGETED_TOPICS[i]!
    assert.equal(ownerByEnd.get(ch.endSeq), want.id, 'chapter closes at its own topic boundary — the split landed on the topic change')
    assert.equal(ch.startSeq, i === 0 ? 0 : chapters[i - 1]!.endSeq + 1, 'chapters are contiguous — no turn lost between subjects, none double-covered')
    const topics = chapterTopics(built.events, ch.startSeq, ch.endSeq)
    for (const f of want.files) assert.ok(topics.includes(f), `${want.id} chapter topics name ${f}: ${topics}`)
    for (const other of TARGETED_TOPICS.filter((t) => t.id !== want.id)) {
      for (const f of other.files) assert.ok(!topics.includes(f), `no bleed from ${other.id}: ${f} must not appear in a ${want.id} chapter`)
    }
  }
  // the archive contract holds on these ranges: contiguous, ascending, complete
  const validated = validateRanges(chapters, built.boundaries[built.boundaries.length - 1]!, 0)
  assert.equal(validated.length, chapters.length)
})

test('#456: control — an unvaried conversation has nothing to attribute: no phantom topic drift', () => {
  const only = buildFor([TARGETED_TOPICS[0]!])
  const anchor = only.boundaries[only.boundaries.length - 1]!
  const { chapters } = deriveRanges(only.events, anchor, targetFor(only), 0)
  assert.ok(chapters.length >= 1)
  for (const ch of chapters) {
    const topics = chapterTopics(only.events, ch.startSeq, ch.endSeq)
    for (const f of TARGETED_TOPICS[0]!.files) assert.ok(topics.includes(f), 'every chapter of a single-subject session keeps the subject')
    for (const other of TARGETED_TOPICS.slice(1)) {
      for (const f of other.files) assert.ok(!topics.includes(f), 'no subject the conversation never had')
    }
  }
})

test('#456: mutation — reorder the topics and the attribution MUST move with them', () => {
  const reordered = [TARGETED_TOPICS[2]!, TARGETED_TOPICS[0]!, TARGETED_TOPICS[1]!]
  const built = buildFor(reordered)
  const { chapters } = deriveRanges(built.events, built.boundaries[built.boundaries.length - 1]!, targetFor(built), 0)
  assert.equal(chapters.length, 3)
  for (const [i, ch] of chapters.entries()) {
    const want = reordered[i]!
    const topics = chapterTopics(built.events, ch.startSeq, ch.endSeq)
    for (const f of want.files) assert.ok(topics.includes(f), `position ${i} follows the conversation, not a memorized order: expected ${f}`)
    for (const other of reordered.filter((t) => t.id !== want.id)) {
      for (const f of other.files) assert.ok(!topics.includes(f), `stale expectation would put ${f} at position ${i}`)
    }
  }
})

test("#456: enrichment inputs carry the chapter's OWN subject — real bytes, not a constant", () => {
  const built = buildFor(TARGETED_TOPICS)
  const { chapters } = deriveRanges(built.events, built.boundaries[built.boundaries.length - 1]!, targetFor(built), 0)
  const inputs = chapters.map((ch, i) => {
    const want = TARGETED_TOPICS[i]!
    const sliceEvents = built.events.filter((e) => e.seq >= ch.startSeq && e.seq <= ch.endSeq)
    const texts = sliceEvents
      .filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
      .map((e) => ((e.data as { content?: { text?: string }[] }).content ?? []).map((b) => b.text ?? '').join(''))
    return buildEnrichInput(
      { title: ch.title },
      { requests: [texts[0]!], firstAssistant: texts[1]!, lastAssistant: texts[texts.length - 1]! },
      texts[1]!,
    )
  })
  for (const [i, input] of inputs.entries()) {
    const want = TARGETED_TOPICS[i]!
    assert.ok(input.includes(want.terms.split(' ')[0]!), `enrich input ${i} holds the ${want.id} vocabulary`)
    assert.ok(input.includes(want.files[0]!) || input.includes(want.terms.split(' ')[1]!), 'and its real subject matter')
    for (const other of TARGETED_TOPICS.filter((t) => t.id !== want.id)) {
      assert.ok(!input.includes(other.terms), `${want.id} enrich input must not smuggle ${other.id} terms`)
    }
  }
  // distinct subjects produce distinct inputs — no constant smuggles through
  assert.notEqual(inputs[0], inputs[1], 'different topics must not produce identical enrich inputs')
  // determinism: the same conversation produces the same input twice
  const again = buildEnrichInput(
    { title: chapters[0]!.title },
    {
      requests: [((built.events[0]!.data as { content: { text?: string }[] }).content ?? [{}])[0]!.text!],
      firstAssistant: undefined, lastAssistant: undefined,
    },
    '',
  )
  const again2 = buildEnrichInput(
    { title: chapters[0]!.title },
    {
      requests: [((built.events[0]!.data as { content: { text?: string }[] }).content ?? [{}])[0]!.text!],
      firstAssistant: undefined, lastAssistant: undefined,
    },
    '',
  )
  assert.equal(again, again2, 'pure function of the inputs')
})

test('#456: suggested next step answers the CURRENT topic, not the opening one', () => {
  const built = buildFor(TARGETED_TOPICS)
  const tail = lastTurnFromEvents(built.events)
  const tailText = tail.map((t) => t.text).join(' ')
  const last = TARGETED_TOPICS[TARGETED_TOPICS.length - 1]!
  const first = TARGETED_TOPICS[0]!
  for (const f of last.files) assert.ok(tailText.includes(f), `the tail the director sees is the ${last.id} present`)
  assert.ok(!tailText.includes(first.terms.split(' ')[0]!), 'the opening subject does not masquerade as the current one')

  // rule arrival on the CURRENT subject: a follow-up about provenance ranks provenance rules first
  const rules: MirrorRule[] = TARGETED_TOPICS.map((t, i) => ({
    id: `harness/${i}`, relPath: `rules/${t.id}.md`, status: 'core', category: t.id,
    title: t.terms, body: `${t.terms} ${t.ask}`, bodyTokens: 40,
  }))
  const ranked = selectRules(rules, queryTopics(`what next for the ${last.terms.split(' ').join(' ')} work?`))
  assert.equal(ranked[0]!.category, last.id, 'topicality follows the conversation, pinned-neutral')
})
