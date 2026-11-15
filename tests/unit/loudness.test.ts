/**
 * Loudness (#61): every failure the code already detects must reach a human or a file.
 *
 * The premise is measured, not rhetorical — each P0 in #58/#59/#60 had a check that fired and was
 * discarded: `writeArchive` warned "N event(s) rendered no output"; `planSummarize` counted the oversize
 * chapters; the finalize catch composed a full diagnostic and dropped it; `(86 warning(s))` was the whole
 * delivery of 86 findings that named the husk and an unarchived 0–4082 hole.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { configureDiagnostics, diagnostic, diagnosticSink, diagnosticStatusLine } from '../../src/diag.ts'
import { formatWarnings } from '../../src/warnings.ts'
import { candidateListingTokens, toolResultCandidates } from '../../src/render.ts'
import { isPendingChapter } from '../../src/enrich-wire.ts'
import { renderGeneratedBlock } from '../../src/enrich-wire.ts'

const savedEnv = process.env.DSH_CHAPTERS_ENGINE_ERRORS
beforeEach(() => { delete process.env.DSH_CHAPTERS_ENGINE_ERRORS; configureDiagnostics(undefined) })
afterEach(() => {
  if (savedEnv !== undefined) process.env.DSH_CHAPTERS_ENGINE_ERRORS = savedEnv
  else delete process.env.DSH_CHAPTERS_ENGINE_ERRORS
  configureDiagnostics(undefined)
})

// ─────────────────────────────────────────────── the sink defaults ON

test('an unset env var means a file, not silence (#61)', () => {
  const dir = fs.mkdtempSync('/tmp/diag-')
  configureDiagnostics(path.join(dir, 'diagnostics.log'))
  assert.equal(diagnosticSink(), path.join(dir, 'diagnostics.log'), 'the default sink is the configured store path')
  diagnostic('door:save', 'chapter 4 refused: oversize')
  const written = fs.readFileSync(path.join(dir, 'diagnostics.log'), 'utf8')
  assert.match(written, /\[door:save\] chapter 4 refused: oversize/, 'and the record is on disk without any env setup')
  assert.match(written, /^\[\d{4}-\d\d-\d\dT/, 'with a timestamp — an undated diagnostic is a guess')
})

test('the env var still wins, and the literal off is the only silence (#61)', () => {
  const dir = fs.mkdtempSync('/tmp/diag2-')
  const forced = path.join(dir, 'env.log')
  configureDiagnostics(path.join(dir, 'default.log'))
  process.env.DSH_CHAPTERS_ENGINE_ERRORS = forced
  assert.equal(diagnosticSink(), forced, 'explicit env overrides the configured default')
  diagnostic('realm:compaction', 'finalization deferred')
  assert.ok(fs.existsSync(forced), 'and it is what gets written')
  assert.ok(!fs.existsSync(path.join(dir, 'default.log')), 'the default is not also written')

  process.env.DSH_CHAPTERS_ENGINE_ERRORS = 'off'
  assert.equal(diagnosticSink(), undefined, "'off' means off — an operator must be able to silence it")
  diagnostic('door:fork', 'should not land')
  assert.equal(fs.existsSync(path.join(dir, 'default.log')), false, 'and nothing is written anywhere')
  assert.match(diagnosticStatusLine(), /explicitly disabled|off/i, 'the status line SAYS it was turned off, not that it is missing')
})

test('the status line names where diagnostics go, in every state (#61)', () => {
  configureDiagnostics('/tmp/diag3/diagnostics.log')
  assert.match(diagnosticStatusLine(), /sink → \/tmp\/diag3\/diagnostics\.log/)
})

// ─────────────────────────────────────────────── warnings reach humans

test('formatWarnings prints texts, a withheld count, and never a bare number (#61)', () => {
  const many = Array.from({ length: 20 }, (_, i) => `chapter ${i} rendered no output`)
  const out = formatWarnings(many, 6)
  assert.match(out, /chapter 0 rendered no output/, 'the first texts are shown, not counted')
  assert.match(out, /…?and 14 more/, `the withheld count is explicit: ${out}`)
  const few = formatWarnings(['one warning'], 6)
  assert.equal(few, 'one warning', 'a single warning needs no ellipsis')
  assert.equal(formatWarnings([], 6), '', 'no warnings, no noise')
  const capped = formatWarnings(Array.from({ length: 100 }, (_, i) => `w${i}`), 1)
  assert.match(capped, /w0/, 'cap 1 still shows the first')
  assert.match(capped, /and 99 more/, 'and counts the rest')
})

test('a source-shape row: no door may print a warning COUNT without the TEXT (#61)', async () => {
  const tools = await fs.promises.readFile(new URL('../../src/tools.ts', import.meta.url), 'utf8')
  // the live failure: `(86 warning(s))` was the entire delivery of 86 findings
  assert.doesNotMatch(tools, /\$\{[a-zA-Z.]+\.length > 0 \? ` \(\$\{[a-zA-Z.]+\.length\} warning/,
    'doors must call formatWarnings, not interpolate a count')
  assert.match(tools, /formatWarnings\(/, 'and must actually call it')
})

// ─────────────────────────────────────────────── the tool caps itself

test('chapters_segment candidates are ranked, capped, and say what was withheld (#61)', () => {
  const big = 'x'.repeat(40000)
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } },
    ...[1, 2, 3, 4].map((seq) => ({ type: 'tool/result', seq, data: { message: { role: 'tool', source: { kind: 'tool', callId: `c${seq}` }, content: [{ type: 'tool-result', toolCallId: `c${seq}`, content: [{ type: 'text', text: big }]}] } } })),
  ] as never[]
  const all = toolResultCandidates(events as never, { title: 't', summary: 's', startSeq: 0, endSeq: 9 } as never, undefined)
  assert.equal(all.length, 4, 'uncapped is unchanged — the cap is opt-in per call, never a silent loss')
  const capped = toolResultCandidates(events as never, { title: 't', summary: 's', startSeq: 0, endSeq: 9 } as never, 5000)
  // #343 amended this row's expectation. It asserted `capped.length < 4` on the theory that a
  // 5000-token budget "cannot carry four 10K-token results" — but the door never emits those results.
  // It emits one ~160-char excerpt row each, so the LIST carries four rows well inside 5000 tokens,
  // and declining to show them was the blindfold, not the bound. What the cap must still do — hold the
  // door's own output down when the list is long — is pinned by the two rows after this one.
  assert.equal(capped.length, 4, 'four excerpt rows fit a 5000-token allowance; the cap bounds the list, not the payloads (#343)')
  assert.ok(capped.length >= 1, 'the biggest still gets judged — ranking is by size, descending')
  assert.ok(capped[0]!.bytes > 1000, 'and the biggest first')
})

/**
 * #343 — the row the one above could never be.
 *
 * Every fixture in the #61 test is the SAME oversized size, so "kept 1 of 4" is the CORRECT answer for
 * that shape: the row passed whether the scan stopped at the first miss or kept looking. It could not
 * fail for the right reason, which is how this shipped and made `chapters_segment` offer exactly one
 * candidate to every real session (measured live on the audit's own session: `listing 1 of 370 tool
 * results, 369 smaller ones omitted by the cap`).
 *
 * Two mistakes, and the second is why a `continue` alone is not the fix:
 *  1. the scan `break`s at the first item that does not fit — with a descending ranking, item #2
 *     whenever the largest payload alone busts the cap;
 *  2. the budget summed the RESULT PAYLOADS' tokens, while the door emits only
 *     `{seq, toolName, excerpt(≤160), deferred}` per row. One oversized payload therefore spent the
 *     entire allowance on bytes that never appear in the response.
 * The cap bounds the LIST (#61's actual complaint: the door emitted 49,932 characters of its own
 * output). These rows pin that, and the real-log measurement is in the PR: 1 → 93 candidates offered
 * on each of three production sessions at the shipped cap of 4000.
 */
test('#343: one oversized result must not blindfold the whole candidate list', () => {
  const huge = 'H'.repeat(200_000)          // ~50K est tokens — 12x the shipped cap, alone
  const small = 's'.repeat(2000)
  const mkResult = (seq: number, text: string) => ({
    type: 'tool/result', seq,
    data: { message: { role: 'tool', source: { kind: 'tool', callId: `c${seq}` }, content: [{ type: 'tool-result', toolCallId: `c${seq}`, content: [{ type: 'text', text }] }] } },
  })
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } },
    mkResult(1, huge),
    ...Array.from({ length: 20 }, (_, i) => mkResult(2 + i, small)),
  ] as never[]
  const range = { title: 't', summary: 's', startSeq: 0, endSeq: 30 } as never

  assert.equal(toolResultCandidates(events as never, range, undefined).length, 21, 'uncapped shows every candidate')
  const capped = toolResultCandidates(events as never, range, 5000)
  // Mistake (1)+(2) produced exactly 1. A payload-sized budget would STILL give 1 here even with
  // `continue`, because the always-kept huge row alone exceeds 5000 — so this assertion is the proof
  // that the budget is the list's own cost, not the payloads'.
  assert.ok(capped.length > 1,
    `#343: the list offered ${capped.length} of 21 candidates — one oversized payload must not consume the whole allowance`)
  assert.equal(capped[0]!.bytes, Buffer.byteLength(huge, 'utf8'), 'the biggest payload is still judged first')
  assert.equal(new Set(capped.map((c) => c.seq)).size, capped.length, 'each candidate appears once')
})

test('#343: the cap still bounds the list when there are many candidates', () => {
  // The other half: this is a bound, not a removal of the bound. Rows are ~30-60 est tokens each, so a
  // 4000-token allowance carries a bounded number of them and the rest are withheld (and reported).
  const mkResult = (seq: number) => ({
    type: 'tool/result', seq,
    data: { message: { role: 'tool', source: { kind: 'tool', callId: `c${seq}` }, content: [{ type: 'tool-result', toolCallId: `c${seq}`, content: [{ type: 'text', text: 'z'.repeat(4000) }] }] } },
  })
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } },
    ...Array.from({ length: 400 }, (_, i) => mkResult(i + 1)),
  ] as never[]
  const range = { title: 't', summary: 's', startSeq: 0, endSeq: 500 } as never
  const capped = toolResultCandidates(events as never, range, 4000)
  assert.ok(capped.length > 1 && capped.length < 400,
    `bounded but not blindfolded: ${capped.length} of 400 (must be >1 and <400)`)
  const listed = capped.reduce((a, c) => a + candidateListingTokens(c), 0)
  assert.ok(listed <= 4000 + candidateListingTokens(capped[0]!),
    `the emitted list stays inside the cap plus the always-kept first row (listed ${String(Math.round(listed))})`)
  const withheld = 400 - capped.length
  assert.ok(withheld > 0, 'and something IS withheld — otherwise this row proves nothing about the cap')
})

// ─────────────────────────────────────────────── enrichment minimum content

test('an empty chapter is never queued for enrichment — five model calls were (#61)', () => {
  const husk = { number: 1, title: 'Empty conversation span…', messages: 0, generated: undefined }
  const real = { number: 2, title: 'Fix the VRAM profile', messages: 3, generated: undefined }
  assert.equal(isPendingChapter(husk as never, 'model-a'), false, 'a chapter that rendered nothing has nothing to annotate')
  assert.equal(isPendingChapter(real as never, 'model-a'), true, 'a real one is still pending')
  const done = { number: 3, title: 'x', messages: 2, generated: { title: [{ by: 'model', model: 'model-a' }] } }
  assert.equal(isPendingChapter(done as never, 'model-a'), false, 'and an annotated one is not pending')
  const otherModel = { number: 4, title: 'x', messages: 2, generated: { title: [{ by: 'model', model: 'model-b' }] } }
  assert.equal(isPendingChapter(otherModel as never, 'model-a'), true, 'a different model re-qualifies it')
})

test('renderGeneratedBlock carries pluginVersion so attribution is not mtime-archaeology (#61)', () => {
  const block = renderGeneratedBlock({
    title: [{ by: 'model', model: 'x/y', at: '2026-10-22T12:00:00Z', pluginVersion: '0.1.40' }],
  } as never)
  assert.match(block, /pluginVersion: 0\.1\.40/, `the version must be in the bytes:\n${block}`)
  const legacy = renderGeneratedBlock({ title: [{ by: 'deterministic' }] } as never)
  assert.doesNotMatch(legacy, /pluginVersion: undefined/, 'and a record without it renders nothing false')
})

test('the version literal cannot drift from package.json (#61)', async () => {
  const { PLUGIN_VERSION } = await import('../../src/version.ts')
  const pkg = JSON.parse(await fs.promises.readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  assert.equal(PLUGIN_VERSION, pkg.version,
    'PLUGIN_VERSION is hand-mirrored into chapter provenance; if it drifts, attribution lies about the build that wrote a row')
})
