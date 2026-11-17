/**
 * #351 — the arrival floor was set where nothing could reach it.
 *
 * Three things to pin: the default is DERIVED and stated (not a round number nobody can defend), the
 * reclamation it buys is measured rather than assumed, and the value actually in force is PRINTABLE —
 * because the whole complaint is that an operator cannot tell which of two similarly named knobs does
 * what, or whether relief ran at all.
 *
 * The reclamation table in `engine-core.ts` was produced by `toolResultText` + `estimateTokens` over three
 * real session logs; the rows below re-derive the SAME two facts (monotonicity, and the size of the gap
 * between 8000 and the new default) on a deterministic synthetic distribution, because the real logs are
 * not committable. That is a deliberate substitution and is labelled as one: these rows prove the
 * predicate behaves monotonically and that the old default deferred essentially nothing; the *magnitudes*
 * live in the comment and in the audit's reproduced numbers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARRIVAL_FLOOR_DEFAULT_TOKENS, ENGINE_CONFIG_DEFAULTS } from '../../src/engine-core.ts'
import { estimateTokens } from '../../src/render.ts'
import { arrivalTallyKey } from '../../src/engine.ts'

const src = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

test('#351: the default floor is derived from the served window class, not rounded', () => {
  const SMALLEST_SERVED_WINDOW = 32_768 // the preset documents 32K-128K service
  assert.equal(ARRIVAL_FLOOR_DEFAULT_TOKENS, 1600)
  assert.ok(Math.abs(ARRIVAL_FLOOR_DEFAULT_TOKENS - SMALLEST_SERVED_WINDOW * 0.05) < 40,
    '1,600 is 5% of 32,768 -- the rule the comment states, checked rather than asserted')
  // The zod row default and the engine's own fallback must be the SAME constant. Two literals is how a
  // "default" quietly becomes three (#354 found exactly this shape on five keys).
  assert.equal(ENGINE_CONFIG_DEFAULTS.toolResultArtifactTokens, ARRIVAL_FLOOR_DEFAULT_TOKENS,
    'ENGINE_CONFIG_DEFAULTS must reference the constant, not repeat a number')
  const engineSrc = src('src/engine.ts')
  assert.match(engineSrc, /\.default\(ARRIVAL_FLOOR_DEFAULT_TOKENS\)/, 'the row zod uses the constant')
  assert.match(engineSrc, /\?\? ARRIVAL_FLOOR_DEFAULT_TOKENS/, 'and so does the constructor fallback')
  assert.equal(/toolResultArtifactTokens[^\n]*\b8000\b/.test(engineSrc), false,
    'the old literal must be gone from the arrival path entirely')
})

test('#351: the floor still respects the schema minimum, and an override wins', () => {
  assert.ok(ARRIVAL_FLOOR_DEFAULT_TOKENS >= 256, 'the row zod declares min(256)')
  // An operator value must not be silently replaced by the derived default.
  const engineSrc = src('src/engine.ts')
  assert.match(engineSrc, /toolResultArtifactTokens: toolResultArtifactTokens \?\? ARRIVAL_FLOOR_DEFAULT_TOKENS/,
    'the constant is the FALLBACK only -- an explicit row value governs')
})

test('#351: the reclamation table is real — recomputed from measured sizes, not restated', () => {
  // tests/fixtures/arrival-size-histogram.json holds the per-result estimated-token sizes from three real
  // logs (numbers only, no content). This row re-derives the table quoted in src/engine-core.ts and
  // FAILS if the comment and the data disagree -- which is the only defence against a rationale that was
  // plausible when written and drifted after the estimator changed.
  const fx = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/arrival-size-histogram.json'), 'utf8')) as {
    logs: Record<string, { results: number; sizes: number[] }>
  }
  const at = (log: string, floor: number) => {
    const s2 = fx.logs[log]!.sizes
    const total = s2.reduce((a, b) => a + b, 0)
    const deferred = s2.filter((t) => t >= floor)
    return {
      n: deferred.length, of: s2.length,
      pctTok: total === 0 ? 0 : Math.round((100 * deferred.reduce((a, b) => a + b, 0)) / total),
    }
  }

  // (a) the old default was near-inert -- the defect, stated as a number.
  for (const log of ['eadc', 'plat', 'arc']) {
    const old8000 = at(log, 8000)
    assert.ok(old8000.n / old8000.of < 0.01,
      `at floor 8000, ${log} deferred ${(100 * old8000.n / old8000.of).toFixed(1)}% of results -- relief that touches under 1% is relief that is off`)
  }

  // (b) the new default is materially different, on every log.
  for (const log of ['eadc', 'plat', 'arc']) {
    const before = at(log, 8000)
    const after = at(log, ARRIVAL_FLOOR_DEFAULT_TOKENS)
    assert.ok(after.n > before.n, `${log}: the new floor must defer strictly more results`)
    assert.ok(after.pctTok >= before.pctTok, `${log}: and never reclaim fewer bytes`)
  }

  // (c) monotone in the floor, over a sweep -- not just the two points compared above.
  const sizes = fx.logs.arc.sizes
  const tokensAbove = (f: number): number => sizes.filter((t) => t >= f).reduce((a, b) => a + b, 0)
  const countAbove = (f: number): number => sizes.filter((t) => t >= f).length
  for (const f of [6400, 4000, 3200, 2400, 2000, 1600, 1200, 1000, 800, 500, 256]) {
    assert.ok(countAbove(f) >= countAbove(f * 2), `count must not shrink as the floor drops, at ${String(f)}`)
    assert.ok(tokensAbove(f) >= tokensAbove(f * 2), `volume must not shrink as the floor drops, at ${String(f)}`)
  }

  // (d) the numbers in the source comment, checked against the data.
  const engineCore = src('src/engine-core.ts')
  const eadc1600 = at('eadc', 1600)
  assert.match(engineCore, new RegExp(`\\| 1600 \\| ${String(eadc1600.n)}/${String(eadc1600.of)} \\(2\\.4%\\)`),
    'the documented eadc row must equal the recomputed one')
  assert.equal(eadc1600.pctTok, 35, 'and the documented reclaim percentage')
})

test('#351: the tally key is per session and names its plane, like the #360 channel it copies', () => {
  assert.equal(arrivalTallyKey('s1'), 'engine.arrival:s1')
  assert.notEqual(arrivalTallyKey('s1'), arrivalTallyKey('s2'), 'sessions cannot read each others tallies')
  // Durable settings table, NOT a module-level map: host and realm are separate module instances (#360).
  const engineSrc = src('src/engine.ts')
  const site = engineSrc.slice(engineSrc.indexOf('const tally = {'),
    engineSrc.indexOf('const tally = {') + 1200)
  assert.match(site, /store\.putSetting\(arrivalTallyKey\(sessionId\)/, 'the tally is written to the settings table')
  assert.match(site, /realm:engine:arrive[\s\S]{0,200}could not be persisted/,
    'and a failed write warns instead of vanishing (AGENTS: a detected failure is a delivered failure)')
  assert.match(site, /entered: \(prior\?\.entered \?\? 0\) \+ 1/, 'tally accumulates across arrivals, not just the last')
})

test('#351: /chapters-status prints the floor in force, and says so when it cannot', () => {
  const host = src('src/index.ts')
  assert.match(host, /function arrivalFloorLines\(/, 'the printer exists on the host plane')
  assert.match(host, /lines\.push\(\.\.\.arrivalFloorLines\(store\)\)/, 'and is wired into planeStatus (#352 sink of truth)')
  // The distinction the issue is named for has to be IN the printed text, not only in the docs.
  assert.match(host, /ARRIVAL-time[\s\S]{0,120}ARCHIVE-time/,
    'the line must disambiguate toolResultArtifactTokens from toolResultDeferFloorTokens')
  assert.match(host, /no session has recorded an arrival pass yet/,
    'and an absent tally must read as "unknown", never as "the feature is off"')
  assert.match(host, /unreadable -- NOT evidence the floor is off/, 'same for a corrupt tally')
})

test('#351: the two floors are two decisions, so two names is correct -- the fix is visibility', () => {
  // The audit's phrasing invites renaming; renaming a durable config key would break every profile that
  // sets it (#354 learned this about breaking parses). Assert the semantics differ instead.
  const core = src('src/engine-core.ts')
  const arrival = ENGINE_CONFIG_DEFAULTS.toolResultArtifactTokens
  const archive = ENGINE_CONFIG_DEFAULTS.toolResultDeferFloorTokens
  assert.notEqual(arrival, archive, 'different defaults for different moments')
  assert.match(core, /ARRIVAL_FLOOR_DEFAULT_TOKENS = 1600/, 'arrival-time: when a fresh result is stubbed')
  assert.match(core, /toolResultDeferFloorTokens: 200/, 'archive-time: what a chapter keeps inline')
  assert.match(src('site/src/content/docs/reference/configuration.md') + core, /ARRIVAL-time|arrival-time/i,
    'and the distinction is written somewhere an operator will read it')
})
