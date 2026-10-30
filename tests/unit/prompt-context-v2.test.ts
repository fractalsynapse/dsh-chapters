/**
 * #188 — the suggestion input v2: chapter history with plots, zero truncation, model-derived caps.
 *
 * The maintainer's contract, as rows. Three principles, each with a failure mode it forbids:
 *  1. History leads: title + detailed summary + EVERY plot per chapter, over the ancestor path —
 *     an index a model cannot research is worthless, and a director without trajectory is ignorant.
 *  2. Zero truncation: nothing the model reads is ever sliced. Over budget ⇒ drop the OLDEST
 *     chapter (announced), never cut a message; a protected set that cannot fit ⇒ refuse with the
 *     numbers. A refused suggestion costs one turn; a truncated one poisons the next.
 *  3. Caps belong to the model: derived from its real context window by ratio, overridable beside
 *     the model, config keys only as the no-window fallback.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractPlots, resolvePromptLimits, buildSuggestInput,
  type ChapterHistoryEntry,
} from '../../src/prompt.ts'

test('extractPlots: every PLOT line in order, consecutive duplicates collapsed, nothing else', () => {
  const body = [
    '**User:** do the thing',
    'PLOT: first hypothesis, next step A',
    '**Assistant:** working',
    'PLOT: first hypothesis, next step A',   // a checkpoint carried it forward verbatim
    'PLOT: second hypothesis, next step B',
    'the word PLOT: inside prose mid-line is not a plot line',
  ].join('\n')
  assert.deepEqual(extractPlots(body), ['first hypothesis, next step A', 'second hypothesis, next step B'])
  assert.deepEqual(extractPlots('no plots here'), [])
})

test('resolvePromptLimits: stored explicit beats derived beats config, and derivation is ratio × window × 4 chars/token', () => {
  const config = { maxChars: 4096, contextChars: 32000, contextRatio: 0.5 }
  // derived from a 32K window: 32768 × 0.5 tokens × 4 chars = 65536
  const derived = resolvePromptLimits({ config, window: 32768 })
  assert.equal(derived.contextChars, 65536)
  assert.equal(derived.maxChars, 4096)
  assert.equal(derived.sources.contextChars, 'derived')
  // a 1M window gets 30× the budget from the SAME rule
  const big = resolvePromptLimits({ config, window: 1_000_000 })
  assert.equal(big.contextChars, 2_000_000)
  // stored explicit wins over derivation…
  const stored = resolvePromptLimits({ config, window: 32768, stored: { maxChars: '2000', contextChars: '50000' } })
  assert.equal(stored.maxChars, 2000)
  assert.equal(stored.contextChars, 50000)
  assert.equal(stored.sources.maxChars, 'stored')
  // …and no window falls back to config, loudly sourced — never a silent guess
  const fallback = resolvePromptLimits({ config, window: null })
  assert.equal(fallback.contextChars, 32000)
  assert.equal(fallback.sources.contextChars, 'config')
  // a garbage stored value is ignored, not parsed as NaN into a budget
  const junk = resolvePromptLimits({ config, window: 32768, stored: { contextChars: 'lots' } })
  assert.equal(junk.contextChars, 65536)
  assert.equal(junk.sources.contextChars, 'derived')
})

const ch = (n: number, plots: string[] = []): ChapterHistoryEntry => ({
  number: n, title: `Chapter ${n}`, summary: `Detailed summary of chapter ${n}.`, plots,
})

test('the assembly carries the protected set and the chapter history with plots', () => {
  const r = buildSuggestInput({
    goalDirective: 'An ACTIVE GOAL governs this session: ship the thing.',
    plan: '# Plan — step one, step two',
    rules: '[dev2/001] Never log raw tokens.',
    title: 'the session',
    chapters: [ch(1, ['objective X, next Y']), ch(2)],
    lastTurn: [{ role: 'user', text: 'What now?' }, { role: 'assistant', text: 'Here is the answer.' }],
  }, 100_000, 4096)
  assert.ok('input' in r, 'fits comfortably ⇒ an input, not a refusal')
  const input = (r as { input: string }).input
  assert.match(input, /ship the thing/, 'the goal rides along whole')
  assert.match(input, /step one, step two/, 'the plan rides along')
  assert.match(input, /Never log raw tokens/, 'the rules ride along')
  assert.match(input, /Chapter 1[\s\S]*Detailed summary of chapter 1/, 'title + detailed summary per chapter')
  assert.match(input, /objective X, next Y/, 'and its plots — the trajectory')
  assert.match(input, /What now\?[\s\S]*Here is the answer\./, 'the last turn, request through final response')
})

test('ZERO TRUNCATION: a message longer than any old inline cap appears WHOLE — never sliced with an ellipsis', () => {
  const huge = 'x'.repeat(12_000)
  const r = buildSuggestInput({
    chapters: [], lastTurn: [{ role: 'user', text: huge }],
  }, 100_000, 4096)
  assert.ok('input' in r)
  const input = (r as { input: string }).input
  assert.ok(input.includes(huge), 'the whole message is in the input')
  assert.ok(!input.includes('…'), 'and nothing wears an ellipsis — a slice is a hallucination invite')
})

test('over budget: the OLDEST chapter drops first, announced, until the history fits', () => {
  const chapters = [ch(1, ['plot one']), ch(2, ['plot two']), ch(3, ['plot three'])]
  // budget tight enough for the skeleton + last two chapters but not all three
  const full = buildSuggestInput({ chapters, lastTurn: [{ role: 'user', text: 'go' }] }, 100_000, 4096)
  assert.ok('input' in full)
  const fullLen = (full as { input: string }).input.length
  const budget = fullLen - 40 // force exactly one chapter out
  const r = buildSuggestInput({ chapters, lastTurn: [{ role: 'user', text: 'go' }] }, budget, 4096)
  assert.ok('input' in r, 'the ladder recovers instead of refusing')
  const input = (r as { input: string }).input
  assert.ok(!input.includes('Detailed summary of chapter 1.'), 'the OLDEST chapter is the one that went')
  assert.ok(input.includes('Detailed summary of chapter 3.'), 'the recent trajectory stays')
  assert.match(input, /dropped to fit/, 'and the drop is ANNOUNCED — silent omission is how a model confabulates')
})

test('a protected set that cannot fit refuses WITH THE NUMBERS — never truncates', () => {
  const huge = 'y'.repeat(5_000)
  const r = buildSuggestInput({
    goalDirective: huge,
    chapters: [ch(1)],
    lastTurn: [{ role: 'user', text: 'go' }],
  }, 2_000, 4096)
  assert.ok('refusal' in r, 'refusal, not a sliced input')
  const refusal = (r as { refusal: string }).refusal
  assert.match(refusal, /2000/, 'the budget is named')
  assert.match(refusal, /5000|exceed/, 'and the size that broke it')
  // chapters all dropped first — the refusal only happens when protected alone cannot fit
  const r2 = buildSuggestInput({ chapters: [ch(1), ch(2)], lastTurn: [{ role: 'user', text: 'go' }] }, 2_000, 4096)
  assert.ok('input' in r2, 'droppable history absorbs the pressure before refusal is considered')
})
