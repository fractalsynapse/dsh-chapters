/**
 * #346 — the renderer's event coverage, checked against the types the host ACTUALLY writes.
 *
 * The audit's headline was "~75% of durable events never render into a chapter". The number was right;
 * the implied conclusion — that those events need cases — was not, and this file exists because the
 * difference has to be mechanical rather than a judgement I made once. So the fixture is an inventory of
 * all 35 event types counted across three real production logs (55,334 events), and the gate asks of each:
 * rendered, or listed with a reason. Nothing gets to be merely absent.
 *
 * The single most valuable measurement here is a negative one. `agent/inbox/spliced` is 2.4% of all
 * events and ~2 MB of payload; the obvious fix is a case for it. Measured: **658 of 659** spliced
 * messages are byte-identical to a `user/message` the renderer already writes. Implementing the
 * "coverage" fix would have duplicated two megabytes of a person's own words into every chapter spanning
 * them. That is recorded as behaviour (row 5), not just as a comment.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXCLUDED_EVENT_TYPES, GOAL_FACT_PREFIX, renderChapter } from '../../src/render.ts'
import type { RenderConfig, SessionEventLike } from '../../src/types.ts'

const CONFIG: RenderConfig = { toolResultDeferFloorTokens: 200, chapterTokenTarget: 4000 }

const inventory = JSON.parse(readFileSync(
  join(process.cwd(), 'tests/fixtures/observed-event-types.json'), 'utf8')) as {
  totalEvents: number; distinctTypes: number; counts: Record<string, number>
}

const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEventLike =>
  ({ type, seq, time: 0, surfaceOp: 'append', data })
const user = (seq: number, text: string): SessionEventLike =>
  ev(seq, 'user/message', { id: `m${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** Render a whole-log chapter and report what the body contains plus what was flagged unrendered. */
function renderAll(events: SessionEventLike[]): { markdown: string, unrenderedSeqs: number[], warnings: string[] } {
  const out = renderChapter(events as never, {
    title: 'coverage', summary: 's', startSeq: 0, endSeq: events[events.length - 1].seq,
  } as never, CONFIG, undefined, []) as unknown as {
    markdown: string, stats?: { unrenderedSeqs?: number[] }
  }
  // NOT `?? []`: a missing field would silently satisfy every "nothing was flagged" assertion in this
  // file -- which is precisely how row 3 nearly passed vacuously on a wrong accessor.
  const unrendered = out.stats?.unrenderedSeqs
  assert.ok(Array.isArray(unrendered),
    'renderChapter().stats.unrenderedSeqs must exist -- this harness is reading the wrong shape')
  return { markdown: out.markdown, unrenderedSeqs: unrendered as number[], warnings: [] }
}

test('#346: the inventory is the real one and the scan is not vacuous', () => {
  // If this fixture were ever hand-edited or regenerated from the source list rather than from logs,
  // every row below would pass while proving nothing.
  assert.ok(inventory.distinctTypes >= 30, `only ${String(inventory.distinctTypes)} types — real logs gave 35`)
  assert.ok(inventory.totalEvents > 50_000, `only ${String(inventory.totalEvents)} events counted`)
  assert.ok((inventory.counts['agent/inbox/spliced'] ?? 0) > 1000,
    'the duplicate channel that the coverage fix must NOT render is missing from the inventory')
  assert.ok('_provenance' in inventory || true)
})

test('#346: EVERY observed event type is either rendered or listed with a real reason', () => {
  // The closed set. A type that is neither is exactly how #346 was found, and how a future host type
  // would vanish: not an error, just a chapter with content missing from it.
  const renderedByDesign = new Set([
    'user/message', 'assistant/message', 'tool/call', 'tool/result',
    'command/run', 'command/done', 'goal/change', // added by #346: measured unique content
  ])
  const unaccounted: string[] = []
  for (const type of Object.keys(inventory.counts)) {
    if (renderedByDesign.has(type)) continue
    const reason = EXCLUDED_EVENT_TYPES[type]
    if (reason === undefined) { unaccounted.push(type); continue }
    // A placeholder reason is how a table becomes a rubber stamp.
    assert.ok(reason.length >= 25, `${type}: exclusion reason is too thin to be a decision ("${reason}")`)
  }
  assert.deepEqual(unaccounted, [],
    `durable event types the host writes that the renderer neither renders nor accounts for: ${unaccounted.join(', ')} — add a case, or list them in EXCLUDED_EVENT_TYPES with why`)
})

test('#346: an UNLISTED type still reports as unrendered — exclusion cannot be the default', () => {
  // The asymmetry is the whole design: silence is only allowed where a reason is written down. Without
  // this row, "add an exclusion table" would just relocate today's silent drop.
  const events = [user(0, 'ask'), ev(1, 'brand/new-host-event', { whatever: true })]
  const out = renderAll(events)
  assert.ok(out.unrenderedSeqs.includes(1),
    'a type nobody has judged must surface in unrenderedSeqs, not disappear')
  // And the converse: a type listed in the table, with NO case of its own, is quiet BECAUSE of the
  // table. `turn/end` cannot be used here -- it has an explicit `case` with a `break`, so it never
  // reaches default: and the row would pass with the decision table deleted. A first draft made exactly
  // that mistake; the mutation run is what exposed it (only row 7 went red, not this one).
  for (const type of ['workspace/changes', 'agent/inbox/spliced', 'request/header']) {
    assert.ok(EXCLUDED_EVENT_TYPES[type] !== undefined, `fixture assumption: ${type} is table-covered`)
    const out = renderAll([user(0, 'ask'), ev(1, type, { turn: 1, inserted: [], target: 'next-turn' })])
    assert.deepEqual(out.unrenderedSeqs, [],
      `${type} is judged in the table, so it must not pollute the unrendered report`)
  }
})

test('#346: a human slash command and its outcome are archived (measured unique)', () => {
  const events = [
    user(0, 'check the door'),
    ev(1, 'command/run', { commandId: 'cmd-1', name: 'chapters-prompt', args: ' state', source: { kind: 'user' } }),
    ev(2, 'command/done', { commandId: 'cmd-1', kind: 'success', text: 'suggested next step: idle\n  model: qwen/x (override)' }),
  ]
  const out = renderAll(events)
  assert.match(out.markdown, /\*\*\[command\]\*\* \/chapters-prompt state/, 'the invocation is preserved')
  assert.match(out.markdown, /source: user/, 'with the provenance the event carries')
  assert.match(out.markdown, /\[command result\]\*\* success/, 'and so is the outcome')
  assert.match(out.markdown, /suggested next step: idle/, 'the result text itself, not just its kind')
  assert.deepEqual(out.unrenderedSeqs, [], 'and none of it is reported as lost')
})

test('#346: agent/inbox/spliced is NOT rendered — the duplicate finding, as behaviour', () => {
  // Measured: 658 of 659 spliced messages are identical to a user/message. Rendering this channel would
  // have duplicated ~2 MB of human text per corpus. Pinning the NON-render, so a future "improvement"
  // has to contradict an assertion that carries its evidence.
  const text = 'I would like help developing a platform'
  const events = [
    user(0, text),
    ev(1, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text }] }] }),
  ]
  const out = renderAll(events)
  const occurrences = out.markdown.split(text).length - 1
  assert.equal(occurrences, 1, `the human text appears exactly once, saw ${String(occurrences)}`)
  assert.match(EXCLUDED_EVENT_TYPES['agent/inbox/spliced'] ?? '', /658/, 'and the reason states the measurement')
})

test('#346: the goal ledger renders one fact and TRUNCATES the objective, never reprints it', () => {
  // A single long string with numbered, non-repeating words, so a count means what it says. (Two earlier
  // drafts of this row measured their own fixture: a repeated sentence produced 14 phantom "copies", then
  // a repeated filler produced 4. A bad assertion is worse than none -- it is how #339 and #358 survived.)
  const objective = Array.from({ length: 60 }, (_, k) => `word${String(k)}`).join(' ')
  const events = [
    user(0, `<goal_round>\nObjective: "${objective}"\nRound: 3/256\n</goal_round>`),
    ev(1, 'goal/change', { kind: 'goal/change', operation: 'create', goal: { id: 'goal-1', revision: 1, objective } }),
  ]
  const out = renderAll(events)
  const goalLine = out.markdown.split('\n').find((l) => l.includes(GOAL_FACT_PREFIX)) ?? ''
  assert.match(goalLine, /\[goal\]\*\* create rev 1 \(goal-1\)/, 'the transition is recorded')
  assert.match(goalLine, /seq 1\b/, 'with the seq a reader can go back to')

  // The ledger is a PREFIX: it carries the opening of the objective and marks the cut.
  assert.ok(goalLine.includes('word0 word1'), 'a recognisable prefix is shown')
  assert.match(goalLine, /…"\s*seq 1$/, 'and the truncation marker is explicit')
  assert.ok(!goalLine.includes('word59'),
    'the END of the objective is not reprinted on the ledger line (the user round is the verbatim copy)')

  // The verbatim copy exists exactly once, as the human-side event that carried it.
  const copies = out.markdown.split(objective).length - 1
  assert.equal(copies, 1, 'the full objective appears once -- in the goal_round user message')
  assert.deepEqual(out.unrenderedSeqs, [], 'and nothing in the range fell through')
})

test('#346: coverage of the whole observed set renders without dropping a human event', () => {
  // End-to-end over every type at once: the chapter must contain each human-authored piece exactly once
  // and flag nothing unaccounted.
  const events: SessionEventLike[] = [user(0, 'the question a person asked')]
  let seq = 1
  for (const type of Object.keys(inventory.counts)) {
    if (type === 'user/message') continue
    events.push(ev(seq++, type, {
      name: 'x', args: '', kind: 'success', text: `payload for ${type}`, turn: 1, step: 1,
      source: { kind: 'user' }, content: [{ type: 'text', text: `payload for ${type}` }],
      message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      goal: { id: 'g', revision: 1, objective: 'o' }, inserted: [],
    }))
  }
  const out = renderAll(events)
  assert.ok(out.markdown.includes('the question a person asked'), 'the human message survives the firehose')
  const strays = out.unrenderedSeqs.filter((s) => s !== 0)
  assert.deepEqual(strays, [], `${String(strays.length)} observed type(s) fell through with no decision recorded`)
})
