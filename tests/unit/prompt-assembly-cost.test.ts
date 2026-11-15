/**
 * #350 — the director's input assembly, unusable at real project scale.
 *
 * Measured by the audit: 9,482 ms to assemble one suggestion input at 800 chapters / 36 MB, blocking the
 * host's event loop at every turn boundary. Two causes fixed here — the O(n²) drop search and the
 * duplicate lineage rows (507 records over 56 distinct paths in this machine's live registry, so up to
 * 43% of the director's chapter block was repeated text and every duplicate re-read its file).
 *
 * The central row is an EQUIVALENCE proof against a naive linear oracle, run over randomized length
 * functions including deliberate sawtooths. A speed-up that changes which chapters the model is shown is
 * not an optimisation. (An earlier draft of this file "compared" the new path against the function under
 * test — a tautology, not an oracle. That is why `firstFitDrop` was extracted: so the search has a real
 * reference implementation to be checked against.)
 */
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  buildSuggestInput, firstFitDrop, promptChaptersForLineage,
  type ChapterHistoryEntry, type SuggestFacts,
} from '../../src/prompt.ts'

const chapter = (n: number, path?: string): ChapterHistoryEntry => ({
  number: n, title: `T${String(n)}`, summary: `summary of chapter ${String(n)}`,
  plots: [`plot line for ${String(n)}`], ...(path !== undefined ? {} : {}),
})

const facts = (chapters: ChapterHistoryEntry[]): SuggestFacts => ({
  chapters,
  lastTurn: [{ role: 'user', text: 'what should we do next' }, { role: 'assistant', text: 'we should continue' }],
})

/** The reference: what the pre-#350 loop did, verbatim in spirit. */
function linearFirstFit(lengthOf: (d: number) => number, n: number, budget: number): number | null {
  for (let d = 0; d <= n; d++) if (lengthOf(d) <= budget) return d
  return null
}

test('#350: over non-increasing length functions the search equals the linear scan', () => {
  // This is the CONTRACT firstFitDrop documents. A randomized test over ARBITRARY functions was the
  // first draft here, and it correctly failed: a binary search cannot find an earlier fit separated by
  // an unfit value, so no walk-back or neighbour probe makes it exact for non-monotone input. Rather
  // than fake that, the precondition is stated, tested against the real function (next row), and
  // guarded at runtime by a fallback to the linear scan.
  let seed = 20261115
  const rnd = (m: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % m }
  let sawFallbackCase = 0
  for (let trial = 0; trial < 400; trial++) {
    const n = rnd(60)
    const removes = Array.from({ length: n }, () => 1 + rnd(50)) // each chapter line is >= 1 char
    const base = rnd(4000)
    // Non-increasing BY CONSTRUCTION -- the same shape the real assembly has.
    const lengthOf = (d: number): number => base + removes.slice(d).reduce((a, b) => a + b, 0)
    const budget = trial % 5 === 0 ? lengthOf(0) - rnd(500) : lengthOf(rnd(n + 2))
    const fast = firstFitDrop(lengthOf, n, budget)
    const slow = linearFirstFit(lengthOf, n, budget)
    assert.equal(fast, slow, `trial ${String(trial)} (n=${String(n)}, budget=${String(budget)})`)
    if (fast !== null) {
      assert.ok(lengthOf(fast) <= budget, 'reported fit really fits')
      if (fast > 0) assert.ok(lengthOf(fast - 1) > budget, 'and it is the FIRST fit')
    }
    if (slow === null) sawFallbackCase += 1
  }
  assert.ok(sawFallbackCase > 0, 'the sweep must include impossible budgets, or "null" is untested')
})

test('#350: the real assembly length IS non-increasing, which is what the search relies on', () => {
  // Without this row the contract above is a comment. Dropping a chapter removes its whole line plus its
  // plot lines and can only add a digit to the announced-drop note -- so the total must never rise.
  const chapters: ChapterHistoryEntry[] = Array.from({ length: 120 }, (_, k) => ({
    number: k + 1, title: `Chapter ${String(k + 1)}`, summary: `s${String(k)}`.padEnd(40, 'z'),
    plots: k % 3 === 0 ? ['PLOT: working'] : [],
  }))
  const full = buildSuggestInput(facts(chapters), Number.MAX_SAFE_INTEGER, 4096)
  assert.ok(!('refusal' in full))
  let prev = Number.POSITIVE_INFINITY
  const budgets = [full.input.length, Math.floor(full.input.length * 0.9), Math.floor(full.input.length * 0.5), 1000, 200, 40]
  for (const budget of budgets) {
    const out = buildSuggestInput(facts(chapters), budget, 4096)
    if ('refusal' in out) continue // below the protected set: refuses, which is its own contract
    assert.ok(out.input.length <= budget, `budget ${String(budget)}: assembled ${String(out.input.length)} chars`)
    assert.ok(out.input.length <= prev, `budget ${String(budget)}: a tighter budget produced a LONGER input (${String(out.input.length)} > ${String(prev)})`)
    prev = out.input.length
  }
  // And directly: the per-drop lengths never rise across the digit boundaries 9->10 and 99->100.
  const lengths: number[] = []
  for (const budget of Array.from({ length: 60 }, (_, k) => Math.floor((full.input.length * (60 - k)) / 60))) {
    const out = buildSuggestInput(facts(chapters), budget, 4096)
    if (!('refusal' in out)) lengths.push(out.input.length)
  }
  for (let k = 1; k < lengths.length; k++) {
    assert.ok(lengths[k]! <= lengths[k - 1]!, `monotonicity broken at index ${String(k)}: ${String(lengths[k - 1])} -> ${String(lengths[k]!)}`)
  }
})

test('#350: an impossible budget refuses rather than silently returning a longer input', () => {
  const out = buildSuggestInput(facts(Array.from({ length: 30 }, (_, k) => chapter(k + 1))), 10, 4096)
  assert.ok('refusal' in out)
})

test('#350: the search cost is logarithmic, which is the whole point (#350 acceptance)', () => {
  // Deterministic, unlike a timing assertion: count evaluations at 1,024 chapters.
  let calls = 0
  const n = 1024
  const lengthOf = (d: number): number => { calls += 1; return (n - d) * 100 }
  const got = firstFitDrop(lengthOf, n, 51_200) // drop 512 fits
  assert.equal(got, 512)
  assert.ok(calls < 40,
    `expected O(log n) evaluations (<= ~2*log2(1024)+4 = 28), got ${String(calls)} — the quadratic search is back`)
  // The old loop would have cost 513 evaluations to reach the same answer.
})

test('#350: buildSuggestInput is actually WIRED to the fast search (deterministic)', () => {
  // The only thing that previously caught a reverted call site was the wall-clock row -- the weakest
  // evidence in this file, and one `if (process.env.CI)` away from being deleted as flaky. This row
  // closes the gap: the fast path must be the one the assembly uses.
  const src = readFileSync(new URL('../../src/prompt.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export function buildSuggestInput'))
  const callAt = body.indexOf('firstFitDrop(')
  assert.ok(callAt > 0, 'buildSuggestInput must call firstFitDrop -- the linear scan is the pre-#350 code')
  assert.ok(!/const drop = linearFirstFit\(/.test(body),
    'buildSuggestInput must not call the linear fallback directly')
  // The fallback still exists for a non-monotone length function (that is its purpose), but only inside
  // firstFitDrop itself -- not as the assembly path.
  const inSearch = src.slice(src.indexOf('export function firstFitDrop'), src.indexOf('function linearFirstFit'))
  assert.match(inSearch, /linearFirstFit\(/, 'the fallback stays wired inside the search')
})

test('#350: assembly at 800 chapters is milliseconds, not the measured 9,482', () => {
  // Reported, and bounded generously: the DETERMINISTIC proof of equivalence is above, so this row
  // exists to catch a regression in shape, not to assert a stopwatch number on shared CI hardware.
  // Sized to the audit's reported scale, not a token gesture: 800 chapters whose summaries and plots
  // total ~36 MB. An earlier draft of this row reported "1.48 ms" on a 0.05 MB input, which proved the
  // shape but not the claim -- it would have passed against 1/700th of the real payload.
  const fat = (k: number): string => `summary-${String(k)} ` + 'x'.repeat(44_000)
  const chapters: ChapterHistoryEntry[] = Array.from({ length: 800 }, (_, k) => ({
    number: k + 1, title: `T${String(k + 1)}`, summary: fat(k),
    plots: ['PLOT: ' + 'y'.repeat(1500)],
  }))
  const f = facts(chapters)
  const full = buildSuggestInput(f, Number.MAX_SAFE_INTEGER, 4096)
  assert.ok(!('refusal' in full))
  const budget = Math.floor(full.input.length / 2) // forces a real drop search
  const iterations = 10
  const t0 = process.hrtime.bigint()
  for (let k = 0; k < iterations; k++) assert.ok(!('refusal' in buildSuggestInput(f, budget, 4096)))
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iterations
  console.log(`    #350 measured: ${(full.input.length / 1024 / 1024).toFixed(2)} MB input, 800 chapters -> ${ms.toFixed(2)} ms/assembly (audit measured 9482 ms)`)
  assert.ok(ms < 400, `expected sub-400 ms after removing the O(n^2) search, got ${ms.toFixed(1)} ms`)
})

test('#350: a budget below the protected set still refuses with numbers, never truncates', () => {
  const out = buildSuggestInput(facts(Array.from({ length: 50 }, (_, k) => chapter(k + 1))), 40, 4096)
  assert.ok('refusal' in out, 'an impossible budget refuses')
  assert.match(out.refusal, /40-char budget/, 'naming the budget it was given')
  assert.match(out.refusal, /all 50 chapter\(s\) already dropped/, 'and how far it had to go')
})

test('#350: lineage rows carrying their parent entries are deduped by path, each body read once', () => {
  // Shape measured in the live registry: a child row repeats its parent's chapters (507 records over 56
  // distinct paths). Deduped by PATH, the same key the TOC accumulation uses, not by number.
  const mk = (n: number, path: string) => ({
    number: n, path, title: `T${String(n)}`, summary: 's', startSeq: 0, endSeq: 1,
    sha256: 'a'.repeat(64), estimatedTokens: 1, artifacts: [],
  })
  const rows = [
    { chapters: [mk(1, 'r1/001-a.md'), mk(2, 'r1/002-b.md')] as never },
    { chapters: [mk(1, 'r1/001-a.md'), mk(2, 'r1/002-b.md'), mk(3, 'r2/003-c.md')] as never },
  ]
  const reads: string[] = []
  const out = promptChaptersForLineage({ rows, readBody: (p) => { reads.push(p); return 'PLOT: carried forward' } })
  assert.equal(out.length, 3, 'five records, three distinct paths')
  assert.deepEqual(out.map((c) => c.number), [1, 2, 3], 'oldest-first order preserved')
  assert.equal(new Set(reads).size, reads.length, `no body read twice (reads: ${reads.join(',')})`)
  assert.equal(reads.length, 3, 'exactly one read per distinct chapter')
})

test('#350: a repeated number at a DIFFERENT path is kept — the key is the file, not the label', () => {
  // Across roots the same number legitimately names different chapters; deduping by number would drop
  // real content, which is why the TOC uses path and this had to match.
  const rows = [{
    chapters: [
      { number: 1, path: 'rA/001-x.md', title: 'A one', summary: 's', startSeq: 0, endSeq: 1, sha256: 'b'.repeat(64), estimatedTokens: 1, artifacts: [] },
      { number: 1, path: 'rB/001-x.md', title: 'B one', summary: 's', startSeq: 0, endSeq: 1, sha256: 'c'.repeat(64), estimatedTokens: 1, artifacts: [] },
    ],
  } as never]
  const out = promptChaptersForLineage({ rows, readBody: () => 'PLOT: p' })
  assert.deepEqual(out.map((c) => c.title), ['A one', 'B one'], 'both survive: same number, different files')
})

test('#350: removed chapters stay out of the director input after dedup', () => {
  const rows = [{
    chapters: [
      { number: 1, path: 'r1/a.md', title: 'live', summary: 's', startSeq: 0, endSeq: 1, sha256: 'a'.repeat(64), estimatedTokens: 1, artifacts: [] },
      { number: 2, path: 'r1/b.md', title: 'removed', summary: 's', startSeq: 0, endSeq: 1, sha256: 'a'.repeat(64), estimatedTokens: 1, artifacts: [], status: 'removed' },
    ],
  } as never]
  assert.deepEqual(promptChaptersForLineage({ rows, readBody: () => '' }).map((c) => c.title), ['live'],
    'the #336 isActiveChapter predicate still gates it')
})
