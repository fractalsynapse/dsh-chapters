/**
 * Lineage frontmatter rows (issue #47): a chapter rendered for a subagent child
 * declares `subagent: true` + `parentSession: "<id>"`; a chapter rendered without
 * it stays BYTE-IDENTICAL to the pre-feature shape — the same discipline as the
 * plans feature ("a plan-less path renders zero bytes", verify.md P8), because it
 * is what keeps every existing chapter file and every model tape un-re-recorded.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderChapter } from '../../src/render.ts'
import { entryFromChapter } from '../../src/indexing.ts'
import type { ChapterRange, RenderConfig, SessionEventLike } from '../../src/types.ts'

const CONFIG: RenderConfig = { toolResultDeferFloorTokens: 200, chapterTokenTarget: 8000 }
const range: ChapterRange = { startSeq: 0, endSeq: 3, title: 'Reading task', summary: 'child reads' }

const events = [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 0, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'read the paper' }] } },
  { type: 'assistant/message', seq: 2, time: 0, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'the paper claims X' }] } } },
  { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
] as unknown as SessionEventLike[]

test('no subagentOf → no lineage lines anywhere (byte-identity of the old shape)', () => {
  const plain = renderChapter(events, range, CONFIG)
  assert.ok(!plain.markdown.includes('subagent'), 'must not mention subagent at all')
  assert.ok(!plain.markdown.includes('parentSession'))
  // and the exact head/tail the pre-feature renderer produced, line for line:
  const fm = plain.markdown.split('\n')
  assert.equal(fm[1], 'title: "Reading task"')
  assert.ok(fm.some((l) => l.startsWith('unrenderedSeqs:')), 'unrenderedSeqs stays the last key block anchor')
})

test('subagentOf → subagent: true + parentSession lines in the YAML frontmatter only', () => {
  const r = renderChapter(events, range, { ...CONFIG, subagentOf: 'parent-abc' })
  const head = r.markdown.slice(0, r.markdown.indexOf('\n---\n', 4) + 5)
  assert.ok(head.includes('subagent: true'), head)
  assert.ok(head.includes('parentSession: "parent-abc"'), head)
  // the body after the closing fence must be IDENTICAL to the unlineaged render —
  // lineage is frontmatter-only, the transcript stays verbatim what the log said.
  const plain = renderChapter(events, range, CONFIG)
  const bodyOf = (md: string): string => md.slice(md.indexOf('\n---\n', 4) + 5)
  assert.equal(bodyOf(r.markdown), bodyOf(plain.markdown))
})

test('entryFromChapter tolerates the lineage keys (search index never trips on them)', () => {
  const r = renderChapter(events, range, { ...CONFIG, subagentOf: 'parent-abc' })
  const entry = entryFromChapter('chapters/ws/child-1/chapters/001-reading-task.md', r.markdown, 1)
  assert.equal(entry.kind, 'chapter')
  assert.equal(entry.title, 'Reading task')
})

test('empty-string subagentOf behaves as absent (no half-lines)', () => {
  const r = renderChapter(events, range, { ...CONFIG, subagentOf: '' })
  assert.ok(!r.markdown.includes('subagent'))
})
