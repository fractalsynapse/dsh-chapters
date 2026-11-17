/**
 * Tests for the pure chapter renderer. Run with the dependency-free loop in docs/development.md:
 *   node --test test/
 * No harness boot, no tokens, no DSH_HOME — this is layer L0/L1 and where the remaining design bugs live.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { artifactPath, duplicateCoveredSeqs, estimateTokens, fenced, longerFence, nextUnarchivedSeq, renderChapter, renderIndex, sha256, toolResultCandidates, validateRanges } from '../../src/render.ts'
import type { ChapterRange, RenderConfig, SessionEventLike } from '../../src/types.ts'

const CONFIG: RenderConfig = { toolResultDeferFloorTokens: 200, chapterTokenTarget: 4000 }

const msg = (seq: number, role: 'user' | 'assistant', text: string): SessionEventLike => ({
  type: `${role}/message`, seq, time: 0, surfaceOp: 'append',
  data: { id: `m${seq}`, role, source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const call = (seq: number, name: string, args: string, callId = `c${seq}`): SessionEventLike => ({
  type: 'tool/call', seq, data: { callId, name, arguments: args },
})
const result = (seq: number, text: string, callId = `c${seq - 1}`): SessionEventLike => ({
  type: 'tool/result', seq,
  data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } },
})

// ------------------------------------------------------------------ fence safety

test('a fence longer than any embedded run is chosen', () => {
  assert.equal(longerFence('plain'), '```')
  assert.equal(longerFence('has ``` inside'), '````')
  assert.equal(longerFence('has `````` six'), '```````')  // 6-run needs 7, one longer is sufficient
})

test('CHAPTER: conversation text containing a triple-backtick fence does not truncate the chapter', () => {
  // The invisible data-loss bug an XML format would have prevented; solved in the renderer instead.
  const hostile = 'Here is the fix:\n```ts\nconst x = 1\n```\nAnd the closing thought that MUST survive.'
  const chapter = renderChapter([msg(0, 'user', hostile)], { title: 'T', summary: 's', startSeq: 0, endSeq: 0 }, CONFIG)

  assert.match(chapter.markdown, /And the closing thought that MUST survive\./)
  // opening fence of the wrapped block must outlast every run inside it
  const wrapper = longerFence(hostile)
  assert.ok(chapter.markdown.includes(`${wrapper}ts\n`) || chapter.markdown.includes(`${wrapper}\n`))
  assert.equal(chapter.stats.unrenderedSeqs.length, 0)
})

test('fenced() round-trips arbitrary backtick content', () => {
  for (const body of ['a```b', 'a````b', '```\n```', 'no fences']) {
    const wrapped = fenced(body)
    const outer = wrapped.split('\n')[0]!
    const innerRuns = body.match(/`+/g) ?? []
    for (const run of innerRuns) assert.ok(run.length < outer.length, `inner ${run.length} vs outer ${outer.length}`)
  }
})

// ------------------------------------------------------------------ ranges

test('validateRanges refuses overlaps, descents, past-ceiling ranges AND gaps', () => {
  const c = (title: string, startSeq: number, endSeq: number) => ({ title, summary: 's', startSeq, endSeq })
  assert.throws(() => validateRanges([c('a', 0, 10), c('b', 5, 20)], 30), /overlaps/)
  assert.throws(() => validateRanges([c('a', 10, 5)], 30), /startSeq 10 above endSeq 5/)
  assert.throws(() => validateRanges([c('a', 0, 40)], 30), /past the archive ceiling 30/)
  assert.throws(() => validateRanges([c('b', 9, 10), c('a', 0, 5)], 30), /descends/)
  assert.doesNotThrow(() => validateRanges([c('a', 0, 5), c('b', 6, 10)], 10))
  // AMENDED 2026-10-22 (#59): this row used to assert a gap was ACCEPTED and merely "visible via
  // coverage arithmetic" — i.e. the caller was trusted to report a hole. The field proved what that
  // trust costs: a 203-event completed turn exists in no chapter. AGENTS.md already said "a gap
  // silently drops it"; the check now exists too.
  assert.throws(() => validateRanges([c('a', 0, 4), c('b', 7, 9)], 9), /gap|dropped|hole/i)
})

test('a submitted range starting above the watermark is refused, not skipped past (#59)', () => {
  // The floor is the watermark: archiving 20..30 while 10..19 sits unarchived would advance
  // max(endSeq) past it and strand those events forever.
  assert.throws(() => validateRanges([{ title: 'a', summary: 's', startSeq: 20, endSeq: 30 }], 30, 10),
    /watermark|above/i)
  assert.doesNotThrow(() => validateRanges([{ title: 'a', summary: 's', startSeq: 10, endSeq: 30 }], 30, 10))
})

// ------------------------------------------------------------------ tool results

test('small tool results stay inline and large ones are deferred with a readable path', () => {
  const small = result(2, 'exit code 0')
  const big = result(4, 'X'.repeat(4000))
  const events: SessionEventLike[] = [call(1, 'bash', 'npm test'), small, call(3, 'read', 'file.ts'), big]

  const chapter = renderChapter(events, { title: 'Work', summary: 's', startSeq: 0, endSeq: 9 }, CONFIG)
  assert.equal(chapter.stats.toolResultsInlined, 1)
  assert.equal(chapter.stats.toolResultsDeferred, 1)
  // #348 CHANGED THIS EXPECTATION (the second contract change in this line of work, named as such).
  // The old assertion pinned the bare STORE-relative fragment -- exactly the string that is not openable
  // from the workspace root, which is the defect. Two forms are now legitimate, and a third (a bare
  // unopenable path with no hint) is not:
  //   - with a citationBase from the door: `→ \`.dsh-chapters/<root>/artifacts/…\`` (read can open it)
  //   - without one, as here (a pure renderer call): the fragment PLUS the tool that can fetch it.
  // Row `#348: without a base the line names chapters_artifact` in artifact-citation.test.ts pins the
  // fallback; `with a base, the citation is a path that actually resolves on disk` pins the prefixed form.
  assert.match(chapter.markdown, /→ `artifacts\/[0-9a-f]{2}\/[0-9a-f]{64}\.txt \(via chapters_artifact\)`/,
    'a store-relative path may only be printed when the line also names what retrieves it')
  assert.ok(!/→ `artifacts\/[0-9a-f]{2}\/[0-9a-f]{64}\.txt`/.test(chapter.markdown),
    'the old bare form is the defect, not a supported shape')
  assert.equal(chapter.artifacts.length, 2, 'artifacts are written EITHER WAY, so deferral never loses data')
})

test('the model can force a large result to stay inline, and the artifact is still written', () => {
  const events: SessionEventLike[] = [call(1, 'bash', 'make'), result(2, 'E'.repeat(4000))]
  const chapter = renderChapter(events, { title: 'Build', summary: 's', startSeq: 0, endSeq: 9 }, CONFIG, [{ seq: 2, inline: true }])

  assert.equal(chapter.stats.toolResultsInlined, 1)
  assert.equal(chapter.artifacts.length, 1)
  assert.equal(chapter.artifacts[0]!.inlined, true)
  assert.match(chapter.markdown, /also at `artifacts\//)
})

test('identical tool results dedupe to one content-addressed path', () => {
  const same = 'X'.repeat(4000)
  const events: SessionEventLike[] = [call(1, 'read', 'a'), result(2, same), call(3, 'read', 'b'), result(4, same)]
  const chapter = renderChapter(events, { title: 'Reads', summary: 's', startSeq: 0, endSeq: 9 }, CONFIG)
  assert.equal(chapter.artifacts[0]!.path, chapter.artifacts[1]!.path)
  assert.equal(new Set(chapter.artifacts.map((a) => a.sha256)).size, 1)
})

test('artifactPath shards by hash prefix', () => {
  const h = sha256('abc')
  assert.equal(artifactPath(h), `artifacts/${h.slice(0, 2)}/${h}.txt`)
})

test('candidates report real sizes so the model never guesses at byte counts', () => {
  const events: SessionEventLike[] = [call(1, 'bash', 'ls'), result(2, 'short'), call(3, 'bash', 'find'), result(4, 'Y'.repeat(2000))]
  const candidates = toolResultCandidates(events, { title: 'x', summary: 'y', startSeq: 0, endSeq: 9 })
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0]!.toolName, 'bash')
  assert.ok(candidates[1]!.bytes > 1900 && candidates[1]!.estimatedTokens > 400)
})

// ------------------------------------------------------------------ completeness

test('nothing in range vanishes silently', () => {
  const events: SessionEventLike[] = [
    msg(0, 'user', 'question'),
    { type: 'mystery/event', seq: 1, data: { whatever: true } },   // unknown type
    msg(2, 'assistant', 'answer'),
  ]
  const chapter = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 2 }, CONFIG)
  assert.deepEqual(chapter.stats.unrenderedSeqs, [1])
  assert.match(chapter.markdown, /unrenderedSeqs: \[1]/)
})

test('lifecycle events are omitted from the body but the range records them', () => {
  const events: SessionEventLike[] = [
    { type: 'turn/start', seq: 0, data: {} }, msg(1, 'user', 'hi'),
    { type: 'step/end', seq: 2, data: {} }, { type: 'turn/end', seq: 3, data: {} },
  ]
  const chapter = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 3 }, CONFIG)
  assert.equal(chapter.stats.unrenderedSeqs.length, 0, 'lifecycle is deliberately skipped, not an accident')
  assert.doesNotThrow(() => validateRanges(chapter.range ? [chapter.range] : [], 3))
})

test('oversized chapters report overTarget so the next boundary splits them; text is never clipped', () => {
  const events = [msg(0, 'user', 'Z'.repeat(20000))]
  const chapter = renderChapter(events, { title: 'Big', summary: 's', startSeq: 0, endSeq: 0 }, CONFIG)
  assert.equal(chapter.stats.overTarget, true)
  assert.ok(chapter.markdown.includes('Z'.repeat(500)), 'full content present despite being over target')
})

// ------------------------------------------------------------------ index

test('the index is deterministic and costs no inference', () => {
  const entries = [
    { path: 'c/001-a.md', title: 'Project Setup', summary: 'Scaffolding.' },
    { path: 'c/002-b.md', title: 'Auth Debugging', summary: 'CORS fixed.' },
  ]
  const first = renderIndex(entries)
  assert.equal(first, renderIndex(entries), 'same input, byte-identical index')
  assert.match(first, /^1\. \[Project Setup]\(c\/001-a\.md\) — Scaffolding\./m)
  assert.ok(estimateTokens(first) < 60, 'a two-entry index stays tiny — the whole point on a 32K model')
})

test('empty input is a loud error, not an empty chapter that looks like success', () => {
  assert.throws(() => validateRanges([], 10), /no chapters supplied/)
})

// ------------------------------------------------- redaction at the chokepoint

test('CHAPTER: credentials never survive into the chapter body OR the deferred artifact (record §9)', () => {
  const aws = 'AKIAIOSFODNN7EXAMPLE'
  const bigResult = 'log line with aws key AKIAIOSFODNN7EXAMPLE embedded ' + 'filler tail text '.repeat(60)
  const events: SessionEventLike[] = [
    msg(0, 'user', `deploy with key ${aws} please`),
    msg(1, 'assistant', `done — note the key was ${aws}`),
    call(2, 'bash', 'aws s3 sync . s3://bucket'),
    result(3, bigResult),
  ]
  const chapter = renderChapter(events, { title: 'Deploy', summary: 's', startSeq: 0, endSeq: 3 }, CONFIG)
  assert.equal(chapter.markdown.includes(aws), false, 'secret absent from chapter markdown')
  assert.match(chapter.markdown, /⟦redacted:credential sha256=[0-9a-f]{8}⟧/)
  // the deferred artifact file body is redacted too (same chokepoint)
  const artifact = chapter.artifacts.find((a) => a.toolName === 'bash')
  assert.ok(artifact, 'a deferred artifact exists for the big result')
  assert.equal(artifact!.content.includes(aws), false, 'secret absent from artifact file content')
  assert.match(artifact!.content, /⟦redacted:credential sha256=[0-9a-f]{8}⟧/)
  // the stable marker appears in BOTH with the same hash (same secret → same marker)
  const markerInBody = /⟦redacted:credential sha256=([0-9a-f]{8})⟧/.exec(chapter.markdown)![1]
  const markerInArtifact = /⟦redacted:credential sha256=([0-9a-f]{8})⟧/.exec(artifact!.content)![1]
  assert.equal(markerInBody, markerInArtifact)
})

test('stats.messages counts user+assistant message events only (record §7.3)', () => {
  const evs = [
    { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'q' }] } },
    { type: 'tool/call', seq: 1, data: { name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', seq: 2, data: { content: [{ type: 'text', text: 'a' }] } },
    { type: 'turn/end', seq: 3, data: {} },
  ] as never
  const r = renderChapter(evs, { title: 'T', summary: 's', startSeq: 0, endSeq: 3 }, { chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200 })
  assert.equal(r.stats.messages, 2)
  assert.equal(r.stats.events, 4)
})

test('host redelivery: two tool/result events for one callId render keep-last, once (treeseed 2026-09-28 audit)', () => {
  const events = [
    msg(0, 'user', 'read the file'),
    call(1, 'read', '{"file_path":"a.ts"}', 'cX'),
    result(2, 'FIRST-COPY-OF-THE-RESULT', 'cX'),
    result(3, 'FINAL-COPY-OF-THE-RESULT', 'cX'),
  ]
  const chapter = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 9 }, CONFIG)
  assert.match(chapter.markdown, /FINAL-COPY-OF-THE-RESULT/, 'the last copy renders')
  assert.doesNotMatch(chapter.markdown, /FIRST-COPY-OF-THE-RESULT/, 'the earlier copy is skipped, not double-inlined')
  assert.equal(chapter.stats.toolResultsInlined + chapter.stats.toolResultsDeferred, 1, 'one result archived, not two')
  const cands = toolResultCandidates(events, { startSeq: 0, endSeq: 9 })
  assert.equal(cands.length, 1, 'the candidate enumeration dedupes too')
  assert.equal(cands[0]!.seq, 3, 'keep-last by seq')
})

// ───────────────────────────────────────────── #334: shadowed payloads, not stubs

/**
 * The bytes arrive in this shape on real hosts: a big `tool/result`, then the plugin's own
 * arrival-time shadowing pair (a `compaction/prune by:'dsh-chapters-arrival'` plus a second
 * `tool/result` for the SAME callId whose text is a short stub). Measured over three production
 * sessions: 44 callIds carry >1 result, **0 are byte-identical**, and all 44 are this shape — the
 * old keep-LAST rule therefore archived the stub and discarded 932,462 characters of payload.
 */
const shadowedPair = (origSeq: number, stubSeq: number, callId: string, payload: string): SessionEventLike[] => [
  call(origSeq - 1, 'bash', '{}', callId),
  result(origSeq, payload, callId),
  { type: 'compaction/prune', seq: stubSeq - 1, data: { shadowedRange: { start: origSeq, end: origSeq }, shadowedSeqs: [origSeq], by: 'dsh-chapters-arrival' } } as never,
  {
    type: 'tool/result', seq: stubSeq,
    surfaceOp: { op: 'replace', startSeq: origSeq, endSeq: origSeq } as never,
    data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: `[dsh:artifact abc123def456] 4.9 KB stored at artifacts/ab/abc123.txt — query it with chapters_artifact` }] }] } },
  } as never,
]

test('#334: a shadowing stub never replaces the payload in the chapter', () => {
  const payload = 'ORIGINAL-PAYLOAD-HEAD ' + 'p'.repeat(6000) + ' TAIL-MARKER-9df31a'
  const events = [msg(0, 'user', 'go'), ...shadowedPair(2, 4, 'cA', payload)]
  const chapter = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 9 }, CONFIG)

  assert.ok(chapter.artifacts.some((a) => a.content.includes('TAIL-MARKER-9df31a')),
    'the durable payload is archived — this is the byte the old rule silently lost')
  assert.ok(!chapter.artifacts.some((a) => a.content.length < 600 && a.content.includes('dsh:artifact')),
    'the stub is never what the chapter stores as the result')
  assert.match(chapter.markdown, /shadowing stub; the full payload is archived at seq 2/,
    'and the substitution is ON THE RECORD, not silent in either direction')
})

test('#334: the archived bytes do not depend on where the chapter edge falls', () => {
  // The invariant-4 half: the choice used to be made over `inRange`, so spanning the stub archived
  // the pointer while ending before it archived the payload — same log, different bytes, decided
  // by the model.
  const payload = 'EDGE-STABLE ' + 'q'.repeat(4000) + ' END-MARKER-77aa'
  const base = [msg(0, 'user', 'go'), ...shadowedPair(2, 4, 'cA', payload)]
  const carries = (c: { artifacts: { content: string }[] }): boolean => c.artifacts.some((a) => a.content.includes('END-MARKER-77aa'))

  const spanning = renderChapter(base, { title: 'T', summary: 's', startSeq: 0, endSeq: 9 }, CONFIG)
  const beforeEdge = renderChapter(base, { title: 'T', summary: 's', startSeq: 0, endSeq: 3 }, CONFIG)
  const stubOnly = renderChapter(base, { title: 'T', summary: 's', startSeq: 3, endSeq: 9 }, CONFIG)

  assert.ok(carries(spanning), 'a chapter spanning the pair carries the payload')
  assert.ok(carries(beforeEdge), 'a chapter ending before the stub carries the payload')
  assert.ok(carries(stubOnly), 'a chapter holding ONLY the stub still carries the payload, from its original seq')
  assert.equal(spanning.artifacts.filter((a) => a.content.includes('END-MARKER-77aa')).length, 1,
    'exactly one copy of the payload per chapter — never rendered twice')
})

test('#334: a genuine byte-identical redelivery still keeps the newest copy', () => {
  // Control, so "largest wins" cannot quietly become "first wins": equal payloads tie-break to the
  // later seq, which is the behaviour #61 measured and documented.
  const events = [msg(0, 'user', 'go'), call(1, 'read', '{}', 'cX'), result(2, 'SAME-TEXT', 'cX'), result(3, 'SAME-TEXT', 'cX')]
  const cands = toolResultCandidates(events, { title: 't', summary: 's', startSeq: 0, endSeq: 9 }, undefined)
  assert.equal(cands.length, 1, 'deduped to one candidate')
  assert.equal(cands[0]!.seq, 3, 'ties keep the newest copy')
})

test('#334: the candidate list offers the PAYLOAD, not a stub the model cannot un-defer', () => {
  const payload = 'CANDIDATE-OFFERED ' + 'r'.repeat(5000)
  const events = [msg(0, 'user', 'go'), ...shadowedPair(2, 4, 'cA', payload)]
  const cands = toolResultCandidates(events, { title: 't', summary: 's', startSeq: 0, endSeq: 9 }, undefined)
  assert.equal(cands.length, 1, 'one candidate for the call')
  assert.ok(cands[0]!.excerpt.includes('CANDIDATE-OFFERED'),
    'the door shows the payload — a stub here is a byte the model can never ask to keep')
  assert.ok(cands[0]!.bytes > 4000, `sized as the payload, not the ~120-char stub (got ${String(cands[0]!.bytes)} B)`)
})

// ───────────────────────────────────────────── #336: the watermark floor is two-sided

test('#336: a range starting BELOW the watermark is refused, not silently duplicated', () => {
  // Live registry before this fix: 42 of 64 rows self-overlapping, 1,453 duplicate records. The floor
  // check refused only a start ABOVE the watermark, so an under-floor start committed the same seqs
  // again under fresh chapter numbers — two live records, one body, "immutable numbers" broken.
  const range = (startSeq: number, endSeq: number, title = 'T'): ChapterRange => ({ title, summary: 's', startSeq, endSeq })
  // ch.1 = [0..100] committed ⇒ floor 101.
  assert.throws(
    () => validateRanges([range(0, 200)], 200, 101),
    /below the watermark 101.*already archived.*#336/s,
    'a range that re-archives committed seqs must be refused, naming the watermark and the overlap')
  // The legal submission still passes, so this cannot be a blanket refusal.
  assert.doesNotThrow(() => validateRanges([range(101, 200)], 200, 101), 'starting AT the watermark is legal')
  // And the original (upper) arm still fires — the fix must not have replaced one side with the other.
  assert.throws(() => validateRanges([range(150, 200)], 200, 101), /above the watermark 101/)
})

test('#336: one watermark derivation — a chapter covering seq 0 does not re-archive forever', () => {
  // The two doors disagreed exactly where real logs are densest: every durable log begins with
  // `permission/preset` at seq 0. save-core seeded at 0 with `lastArchived > 0 ? +1 : 0`, so a chapter
  // ending at seq 0 gave fromSeq 0 again; continue-core seeded at -1 and gave 1.
  assert.deepEqual(nextUnarchivedSeq([]), 0, 'nothing archived ⇒ start at 0')
  assert.deepEqual(nextUnarchivedSeq([{ endSeq: 0 }]), 1, 'a chapter covering ONLY seq 0 ⇒ start at 1')
  assert.deepEqual(nextUnarchivedSeq([{ endSeq: 4 }, { endSeq: 2 }]), 5, 'highest endSeq + 1, order-independent')
})

test('#336: the duplicate detector sees what a Set structurally cannot', () => {
  // repair.ts built `covered` as a Set<number> and reported only MISSING seqs — a seq in two chapters
  // is indistinguishable there from a seq in one, which is why 1,453 duplicate records shipped.
  const chapters = [
    { number: 1, startSeq: 0, endSeq: 10 },
    { number: 2, startSeq: 5, endSeq: 20 },   // overlaps ch.1 on 5..10
    { number: 3, startSeq: 21, endSeq: 25 },  // clean
  ]
  const dupes = duplicateCoveredSeqs(chapters)
  assert.equal(dupes.size, 6, 'seqs 5..10 are each owned by two chapters')
  assert.deepEqual(dupes.get(5), [1, 2], 'and the report names both owners')
  assert.equal(dupes.has(11), false, 'the non-overlapping tail is not flagged')
  // The control that keeps this from being vacuous: no overlap, no findings.
  assert.equal(duplicateCoveredSeqs([chapters[0]!, chapters[2]!]).size, 0)
})

// ───────────────────────────────────────────── #345: inline code cannot be closed by its own content

test('#345: a tool-call argument containing backticks does not break its own line', () => {
  // The real shape: a bash call whose arguments quote shell backticks. `longerFence` protects fenced
  // blocks (hazard #1 in this file's header) but the invocation head was a bare single-backtick span.
  const hostile = '{"command":"grep -n \\"`a`\\|\\`#\\`#\\|Table of contents\\" file.ts"}'
  const events = [
    msg(0, 'user', 'search for it'),
    call(1, 'bash', hostile, 'c1'),
    result(2, 'found nothing', 'c1'),
  ]
  const chapter = renderChapter(events, { title: 'T', summary: 's', startSeq: 0, endSeq: 9 }, CONFIG)
  const line = chapter.markdown.split('\n').find((l) => l.includes('**bash**'))!
  assert.ok(line !== undefined, 'the invocation line exists')
  // Count backtick runs: an ODD number of delimiters means the span is unbalanced and the `(seq N)`
  // citation after it renders as code/emphasis instead of text.
  const runs = (line.match(/`+/g) ?? [])
  assert.equal(runs.length % 2, 0, `unbalanced inline code in: ${line}`)
  assert.match(line, /\(seq 1\)$/, 'and the seq citation is still plain text at the end of the line')
})

test('#345: inlineCode picks a delimiter longer than any run inside, and pads edge backticks', async () => {
  const { inlineCode } = await import('../../src/render.ts')
  assert.equal(inlineCode('plain'), '`plain`')
  assert.equal(inlineCode('has `one` run'), '``has `one` run``')
  assert.equal(inlineCode('a ``` triple ``` inside'), '````a ``` triple ``` inside````')
  // CommonMark: content beginning or ending with a backtick needs padding spaces, else the run is
  // read as the delimiter itself.
  assert.equal(inlineCode('`tick'), '`` `tick ``')
  assert.match(inlineCode('one\ntwo'), /^`one two`$/, 'newlines fold — the head stays one line')
  // The property, for any input: the delimiters never appear inside the span unescaped.
  for (const s of ['', '`', '``', 'a`b', '```x', 'x```', '`````']) {
    const out = inlineCode(s)
    const open = /^(`+)/.exec(out)![1]!
    const close = /(`+)$/.exec(out)![1]!
    assert.equal(open, close, `open/close match for ${JSON.stringify(s)}`)
    assert.ok(!open.includes('`````') || true)
    assert.equal(out.slice(open.length, out.length - close.length).includes(open), false,
      `content of ${JSON.stringify(s)} cannot contain its own delimiter ${open}`)
  }
})
