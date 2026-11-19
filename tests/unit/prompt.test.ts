/**
 * #71 prompt recommendations — the pure planner and the surface (src/prompt.ts).
 * Every row is written to fail on the mutation it guards (docs/verify.md
 * § Prompt recommendations): precedence, routing, screening, the cap ladders,
 * the one-call-per-boundary cache, and the in-flight dedup.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROMPT_SETTING_KEY, buildSuggestInput, createPromptSurface, type ChapterHistoryEntry, effectivePromptSpec,
  lastHumanTurnSeq, lastTurnFromEvents, promptChaptersOf, resolvePromptRoute, tailFromEvents, validateSuggestion,
  type PromptDeps, type PromptRoute,
} from '../../src/prompt.ts'

const ROUTE: PromptRoute = { provider: 'local', model: 'qwen3.8-flash' }

// ---------------------------------------------------------------- precedence

test('the stored override wins over config; a stored EMPTY string is the deliberate OFF', () => {
  assert.deepEqual(effectivePromptSpec(undefined, 'p/m'), { spec: 'p/m', source: 'config' })
  assert.deepEqual(effectivePromptSpec('other/x', 'p/m'), { spec: 'other/x', source: 'override' })
  // The trap: `''` must NOT fall through to config — it is `off`, not absent.
  assert.deepEqual(effectivePromptSpec('', 'p/m'), { spec: '', source: 'override' })
  assert.deepEqual(effectivePromptSpec(undefined, '  '), { spec: '', source: 'unset' })
})

test('routing: provider/model rides its name, a bare model rides the conversation provider, alone it refuses', () => {
  assert.deepEqual(resolvePromptRoute('p/m', null), { route: { provider: 'p', model: 'm' } })
  assert.deepEqual(resolvePromptRoute('m', ROUTE), { route: { provider: 'local', model: 'm' } })
  const bare = resolvePromptRoute('m', null)
  assert.equal(bare.route, null)
  assert.match(bare.reason ?? '', /provider\/model/)
  assert.deepEqual(resolvePromptRoute('', ROUTE), { route: null, reason: 'prompt suggestions are off' })
  // A leading '/' is not a provider — it stays a bare name, never an empty provider.
  assert.deepEqual(resolvePromptRoute('/m', ROUTE).route, { provider: 'local', model: '/m' })
})

// ---------------------------------------------------------------- tail & screen

const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ seq, type, data })

test('the tail screens injected context through the ONE predicate and keeps conversation text', () => {
  const events = [
    ev(1, 'user/message', { role: 'user', content: [{ type: 'text', text: 'do the thing' }] }),
    // our own TOC notice: a producer-owned snapshot event — injected, NOT conversation
    ev(2, 'user/message', {
      role: 'user',
      source: { kind: 'plugin:dsh-chapters', form: 'snapshot', sections: ['toc'] },
      content: [{ type: 'text', text: '## Table of contents\n…' }],
    }),
    ev(3, 'assistant/message', { message: { content: [{ type: 'text', text: 'done.' }, { type: 'reasoning', text: 'hmm' }] } }),
    ev(4, 'user/message', { role: 'user', content: [{ type: 'text', text: 'next one\n<system-reminder>workspace noise</system-reminder>' }] }),
  ]
  const tail = tailFromEvents(events as never)
  // #340: user entries now carry `human`, because role 'user' alone cannot tell the human's request
  // apart from narration the screen keeps as conversation (a subagent-settled notice, a "Continue"
  // relay) — and lastTurnFromEvents must cut at the former, not the latter.
  assert.deepEqual(tail, [
    { role: 'user', text: 'do the thing', human: true },
    { role: 'assistant', text: 'done.' },
    { role: 'user', text: 'next one', human: true },
  ])
})

test('#340: kept narration is marked human:false, so it cannot masquerade as the request', () => {
  const events = [
    ev(1, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'THE REAL REQUEST' }] }),
    ev(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'delegating' }] } }),
    // The shape that used to START the last-turn block and cut the request out of it entirely.
    ev(3, 'user/message', { role: 'user', source: { kind: 'subagent-settled', form: 'notice' }, content: [{ type: 'text', text: 'Background subagent abc finished and reported: done' }] }),
    ev(4, 'assistant/message', { message: { content: [{ type: 'text', text: 'wrapping up' }] } }),
  ]
  const tail = tailFromEvents(events as never)
  assert.deepEqual(tail.map((t) => [t.role, t.human ?? false]),
    [['user', true], ['assistant', false], ['user', false], ['assistant', false]],
    'all four survive the screen as conversation, but only the typed one is marked human')

  const block = lastTurnFromEvents(events as never)
  assert.equal(block[0]!.text, 'THE REAL REQUEST', 'the last-turn block starts at the request, not at the notice')
  assert.ok(block.some((m) => m.text.includes('Background subagent abc')),
    'and the notice is still IN the block — it is conversation, it just is not the boundary')
  assert.equal(block.length, 4, 'nothing was dropped from the tail')
})

// ---------------------------------------------------------------- input assembly

const facts = (chapters: ChapterHistoryEntry[], lastTurn: { role: 'user' | 'assistant'; text: string }[]) =>
  ({ title: 'Session X', chapters, lastTurn })

const inputOf = (r: { input: string } | { refusal: string }): string => {
  assert.ok('input' in r, `expected an input, got a refusal: ${'refusal' in r ? r.refusal : ''}`)
  return (r as { input: string }).input
}

test('the input is deterministic, carries both sections, and ends with the reply rule + cap', () => {
  const f = facts(
    [{ number: 1, title: 'Setup', summary: 'installed the rig', plots: [] }],
    [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi — what next?' }],
  )
  const a = buildSuggestInput(f, 4000, 240)
  assert.deepEqual(a, buildSuggestInput(f, 4000, 240))
  const input = inputOf(a)
  assert.match(input, /second reader/)
  assert.match(input, /## Session: Session X/)
  assert.match(input, /1\. Setup — installed the rig/)
  assert.match(input, /Human: hello\nAssistant: hi — what next\?/)
  assert.match(input, /at most 240 characters/)
  assert.ok(!input.includes('dropped'), 'a fitting input announces nothing')
})

/**
 * #317 — archive-derived context must arrive LABELED as past. The generator at boundary 8316
 * faithfully offered "Check whether bash-32 has completed the 0.2.26 release chain…" because the
 * chapter trajectory it was shown quoted an OPEN REQUEST block verbatim — the bytes were true,
 * the tense was not marked. The section-level fix is one explicit line inside the chapters block;
 * the rule-level fix names the same trap in the FUTURE sentence of the reply rules.
 */
test('#317: the chapters section opens with a tense label — archive content is PAST, even when phrased open', () => {
  const f = facts(
    [{ number: 1, title: 'Setup', summary: 'dispatched bash-32', plots: ['OPEN REQUEST: complete the 0.2.26 chain'] }],
    [{ role: 'user', text: 'hello' }],
  )
  const input = inputOf(buildSuggestInput(f, 8000, 240))
  const hPos = input.indexOf('## Where it has been')
  const tPos = input.indexOf('PAST')
  const cPos = input.indexOf('1. Setup')
  assert.ok(hPos >= 0 && tPos > hPos && tPos < cPos, 'the label sits INSIDE the section, before any chapter content')
  assert.match(input.slice(hPos, cPos), /never offer work the archive describes as dispatched, merged, published, or awaiting a notification/,
    'the named trap states the four archive-past shapes verbatim')
  assert.match(input.slice(hPos, cPos), /next step must be beyond everything shown/, 'and where the next step must live')
})

test('#317: no chapters means no archive and no tense label — the line describes content that is not there', () => {
  const input = inputOf(buildSuggestInput({ title: 'S', chapters: [], lastTurn: [{ role: 'user', text: 'go' }] }, 4000, 240))
  assert.ok(!input.includes('This section is PAST'), 'the NO_CHAPTERS line stays alone')
})

test('#317: the reply-rules FUTURE sentence names the archive-echo shape with its live quote', () => {
  const input = inputOf(buildSuggestInput(
    facts([{ number: 1, title: 'x', summary: 'y', plots: [] }], [{ role: 'user', text: 'go' }]),
    8000, 240,
  ))
  assert.match(input, /mirror, not a director/, 'the #279 anchor sentence is still there')
  assert.match(input, /bash-32 has completed the 0\.2\.26 release chain/,
    'and the FUTURE rule now carries this trap with its live-era quote, not just the in-flight one')
  assert.match(input, /quoted past phrasing is not current state/)
})

// #188 superseded this row's old contract (drop chapters, then drop tail messages, then HALVE the
// per-message slice): nothing the model reads is ever sliced now. The ladder drops whole chapters
// (oldest first, announced) and the last turn is PROTECTED — the assertions that survive are the
// ones that were load-bearing: budget is hard, oldest goes first, newest leads, drops are announced.
test('over budget drops the OLDEST chapters first, announced with counts; the last turn is protected', () => {
  const chapters: ChapterHistoryEntry[] = [1, 2, 3, 4].map((n) => ({ number: n, title: `t${n}`, summary: `s${n}` + 'q'.repeat(300), plots: [] }))
  const lastTurn = [{ role: 'user' as const, text: 'message number 3 — the present, never dropped' }]
  const whole = inputOf(buildSuggestInput({ title: 'S', chapters, lastTurn }, 100_000, 240))
  assert.ok(whole.includes('1. t1') && whole.includes('4. t4'), 'a generous budget keeps the whole history')
  const tight = buildSuggestInput({ title: 'S', chapters, lastTurn }, whole.length - 1, 240)
  const tightInput = inputOf(tight)
  assert.ok(!tightInput.includes('1. t1'), 'the oldest chapter drops first')
  assert.ok(tightInput.includes('4. t4'), 'the newest chapter survives longest')
  assert.ok(tightInput.length <= whole.length - 1, 'the budget is HARD')
  assert.ok(tightInput.includes('message number 3'), 'the last turn is protected — the present is never dropped')
  assert.ok(tightInput.includes(`dropped to fit the ${String(whole.length - 1)}-char budget:`), 'the drop is announced with the budget it was fitted to')
  assert.match(tightInput, /\d+ chapter\(s\)/)
  const kept = chapters.filter((c) => tightInput.includes(`${c.number}. t${c.number}`))
  for (let i = 1; i < kept.length; i++) assert.ok(kept[i - 1]!.number < kept[i]!.number, 'kept chapters are the newest suffix')
})

test('a budget smaller than the protected frame REFUSES with the numbers instead of returning a silent skeleton', () => {
  // #188: the old floor behavior returned the frame with an announcement bolted on; the new contract
  // refuses, because an input that cannot carry the goal and the last turn cannot define a next step,
  // and a refusal the bar displays is recoverable while a starved suggestion is not.
  const r = buildSuggestInput({ title: 'S', chapters: [], lastTurn: [{ role: 'user', text: 'go' }] }, 40, 240)
  assert.ok('refusal' in r, 'refusal, never a starved input')
  assert.match((r as { refusal: string }).refusal, /40/, 'the budget is named')
  assert.match((r as { refusal: string }).refusal, /exceed/, 'and so is the fact that the protected set broke it')
})

// ---------------------------------------------------------------- answer validation

test('fences and wrapping quotes are noise; empty and over-cap answers are invalid, never truncated', () => {
  assert.deepEqual(validateSuggestion('  do the next thing \n', 240), { ok: true, text: 'do the next thing' })
  assert.deepEqual(validateSuggestion('```\nrun the tests\n```', 240), { ok: true, text: 'run the tests' })
  assert.deepEqual(validateSuggestion('"fix the bug"', 240), { ok: true, text: 'fix the bug' })
  assert.match((validateSuggestion('   ', 240) as { reason: string }).reason, /no text/)
  const over = validateSuggestion('x'.repeat(241), 240)
  assert.equal(over.ok, false)
  assert.match((over as { reason: string }).reason, /241 characters, over the 240-char cap/)
})

// ---------------------------------------------------------------- the surface

function world(deps: {
  settings?: Map<string, string>
  chapters?: { number: number; title: string; summary: string }[]
  fetches: (string | Error)[]
  fetchDelayMs?: number
}) {
  const settings = deps.settings ?? new Map<string, string>()
  const fetchesGiven: string[] = []
  let calls = 0
  const list = deps.fetches
  const surface = createPromptSurface({
    getSetting: (k) => settings.get(k),
    putSetting: async (k, v) => { settings.set(k, v) },
    deleteSetting: async (k) => { settings.delete(k) },
    chaptersOf: async () => deps.chapters ?? [],
    config: { model: '', contextChars: 4000, maxChars: 240 },
    conversationRoute: () => ROUTE,
    fetch: async (prompt) => {
      fetchesGiven.push(prompt)
      calls += 1
      const next = list[Math.min(calls - 1, list.length - 1)]
      if (deps.fetchDelayMs !== undefined) await new Promise((r) => setTimeout(r, deps.fetchDelayMs))
      if (next instanceof Error) throw next
      return next ?? ''
    },
  } satisfies PromptDeps)
  return { surface, settings, fetchesGiven, calls: () => calls }
}

const SESSION = {
  id: 's-1',
  title: 'Wiring',
  events: [
    ev(1, 'user/message', { role: 'user', content: [{ type: 'text', text: 'start' }] }),
    ev(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'ready' }] } }),
  ],
}

test('off ⇒ one refusal naming the enable command, and ZERO fetches', async () => {
  const w = world({ fetches: ['should never run'] })
  const r = await w.surface.suggest(SESSION)
  assert.equal(r.ok, false)
  assert.match(r.text, /off/)
  assert.match(r.text, new RegExp(`/chapters-prompt model <provider/model>`))
  assert.equal(w.calls(), 0)
})

test('nothing to recommend yet: no events, and no completed assistant turn, both refuse before any call', async () => {
  const w = world({ settings: new Map([[PROMPT_SETTING_KEY, 'p/m']]), fetches: [] })
  const empty = await w.surface.suggest({ id: 'x', events: [] })
  assert.equal(empty.ok, false)
  assert.match(empty.text, /no surface events/)
  const noReply = await w.surface.suggest({ id: 'x', events: [ev(1, 'user/message', { role: 'user', content: [{ type: 'text', text: 'hi' }] })] })
  assert.equal(noReply.ok, false)
  assert.match(noReply.text, /no completed assistant turn/)
  assert.equal(w.calls(), 0)
})

test('a valid answer is cached for the turn boundary: the same seq costs one call total', async () => {
  const w = world({ settings: new Map([[PROMPT_SETTING_KEY, 'p/m']]), fetches: ['run the migration'] })
  const first = await w.surface.suggest(SESSION)
  assert.equal(first.ok, true)
  assert.equal(first.text, 'run the migration')
  const second = await w.surface.suggest(SESSION)
  assert.equal(second.ok, true)
  assert.equal(w.calls(), 1, 'fresh cache ⇒ zero model tokens on the repeat')
  // A new COMPLETED turn moves the watermark: the answer is recomputed, never served stale. The fixture used
  // to append a bare `user/message` and call that a new turn — it isn't one, and #113 is precisely the bug that
  // made an unfinished turn re-ask the model (one turn, three suggestions). Key on `turn/end`, so say `turn/end`.
  const moved = { ...SESSION, events: [...SESSION.events,
    ev(3, 'user/message', { role: 'user', content: [{ type: 'text', text: 'and then?' }] }),
    ev(4, 'turn/end', { turn: 2 })] }
  const third = await w.surface.suggest(moved)
  assert.equal(third.ok, true)
  assert.equal(w.calls(), 2, 'a new turn/end ⇒ recompute')
})

test('concurrent requests for one session share ONE in-flight call', async () => {
  const w = world({ settings: new Map([[PROMPT_SETTING_KEY, 'p/m']]), fetches: ['wait for me'], fetchDelayMs: 25 })
  const [a, b] = await Promise.all([w.surface.suggest(SESSION), w.surface.suggest(SESSION)])
  assert.equal(a.text, 'wait for me')
  assert.equal(b.text, 'wait for me')
  assert.equal(w.calls(), 1)
})

test('an invalid answer gets exactly ONE restated retry; a second failure refuses with the measured numbers', async () => {
  const oversize = 'y'.repeat(300)
  const w = world({ settings: new Map([[PROMPT_SETTING_KEY, 'p/m']]), fetches: [oversize, 'the retry answer'] })
  const r = await w.surface.suggest(SESSION)
  assert.equal(r.ok, true)
  assert.equal(r.text, 'the retry answer')
  assert.equal(w.calls(), 2)
  assert.match(w.fetchesGiven[1]!, /Remember: reply with ONLY the suggested prompt, plain text, at most 240 characters/)

  const w2 = world({ settings: new Map([[PROMPT_SETTING_KEY, 'p/m']]), fetches: [oversize, oversize] })
  const r2 = await w2.surface.suggest(SESSION)
  assert.equal(r2.ok, false)
  assert.match(r2.text, /300 characters, over the 240-char cap/)
  assert.equal(w2.calls(), 2, 'the ladder is ONE retry, not a loop')
})

test('a model failure refuses with its message, warns, and caches NOTHING (next ask may succeed)', async () => {
  const warns: string[] = []
  const settings = new Map([[PROMPT_SETTING_KEY, 'p/m']])
  let calls = 0
  const surface = createPromptSurface({
    getSetting: (k) => settings.get(k),
    putSetting: async (k, v) => { settings.set(k, v) },
    deleteSetting: async (k) => { settings.delete(k) },
    chaptersOf: async () => { throw new Error('registry offline') },
    config: { model: '', contextChars: 4000, maxChars: 240 },
    conversationRoute: () => ROUTE,
    fetch: async () => { calls += 1; return 'x' },
    warn: (m) => { warns.push(m) },
  })
  const r = await surface.suggest(SESSION)
  assert.equal(r.ok, false)
  assert.match(r.text, /could not assemble the context: registry offline/)
  assert.equal(calls, 0)

  // fetch itself rejecting:
  const w = world({ settings: new Map([[PROMPT_SETTING_KEY, 'p/m']]), fetches: [new Error('ECONN refused')] })
  const f = await w.surface.suggest(SESSION)
  assert.equal(f.ok, false)
  assert.match(f.text, /prompt model call failed/)
  // and a fresh suggest tries again (nothing cached from a failure)
  await w.surface.suggest(SESSION)
  assert.equal(w.calls(), 2)
})

test('setModel writes the override, null DELETES it (config falls back), and both clear the cache', async () => {
  const w = world({ settings: new Map([[PROMPT_SETTING_KEY, 'x/y']]), fetches: ['a', 'b'] })
  await w.surface.suggest(SESSION)
  assert.equal(w.calls(), 1)
  await w.surface.setModel('p/m')
  assert.equal(w.settings.get(PROMPT_SETTING_KEY), 'p/m')
  assert.equal(w.surface.effective().source, 'override')
  await w.surface.suggest(SESSION)
  assert.equal(w.calls(), 2, 'a model change retires the cached answer')
  await w.surface.setModel(null)
  assert.equal(w.settings.has(PROMPT_SETTING_KEY), false, 'clear RESTORES the absent state — not a stored empty')
  assert.equal(w.surface.effective().source, 'unset')
  assert.equal((await w.surface.suggest(SESSION)).ok, false, 'now off')
  assert.equal(w.calls(), 2)
})

test('statusLine is loud in every state: ON names model+source, OFF names the command', () => {
  const on = world({ settings: new Map([[PROMPT_SETTING_KEY, 'p/m']]), fetches: [] })
  assert.match(on.surface.statusLine(), /^Prompt suggestions: ON — p\/m \(override/)
  const off = world({ settings: new Map([[PROMPT_SETTING_KEY, '']]), fetches: [] })
  assert.match(off.surface.statusLine(), /OFF \(explicitly off — \/chapters-prompt model/)
  const unset = world({ settings: new Map(), fetches: [] })
  assert.match(unset.surface.statusLine(), /OFF.*enable with \/chapters-prompt model/)
})

test('a stored OFF override beats a non-empty config default', async () => {
  const w = world({ settings: new Map([[PROMPT_SETTING_KEY, '']]), fetches: [] })
  // config.model is '' in world(); simulate the profile default by writing a fresh surface:
  const surface = createPromptSurface({
    getSetting: () => '',
    putSetting: async () => undefined,
    deleteSetting: async () => undefined,
    chaptersOf: async () => [],
    config: { model: 'p/m', contextChars: 4000, maxChars: 240 },
    conversationRoute: () => ROUTE,
    fetch: async () => 'never',
  })
  const r = await surface.suggest(SESSION)
  assert.equal(r.ok, false)
  assert.match(surface.statusLine(), /OFF \(explicitly off/)
  void w
})

test('promptChaptersOf maps ONLY active chapters (superseded records never feed a recommendation)', () => {
  const state = {
    chapters: [
      { number: 1, title: 'good', summary: 's1', status: undefined },
      { number: 2, title: 'bad', summary: 's2', status: 'superseded' },
    ],
  } as never
  assert.deepEqual(promptChaptersOf(state), [{ number: 1, title: 'good', summary: 's1' }])
})

test('a budget smaller than the protected frame REFUSES with numbers instead of sending a starved input (#61 → #188)', () => {
  // The #61 row, updated by the #188 contract: the honest delivery of "cannot fit" is a REFUSAL the
  // bar displays, not an announcement bolted onto an input that gets sent anyway — sending a starved
  // assembly to a model and hoping is exactly the silence #61 forbids, wearing a louder costume.
  const chapters: ChapterHistoryEntry[] = [1, 2].map((n) => ({ number: n, title: `t${n}`, summary: `s${n}`, plots: [] }))
  const lastTurn = [{ role: 'user' as const, text: 'hello' }]
  const small = buildSuggestInput(facts(chapters, lastTurn), 40, 240)
  assert.ok('refusal' in small, 'refusal, never an over-budget input')
  const refusal = (small as { refusal: string }).refusal
  assert.match(refusal, /40/, `stated with numbers: ${refusal}`)
  assert.match(refusal, /\/chapters-prompt model/, 'and the remedy is named')
})

test('#243+#273: the suggestion rules demand a DIRECTIVE TO THE MODEL, not advice to the user', () => {
  const built = buildSuggestInput(facts([{ number: 1, title: 'Setup', summary: 'installed the rig', plots: [] }], [{ role: 'assistant' as const, text: 'done for now' }]), 4000, 240)
  const a = inputOf(built)
  assert.ok(a.includes('WORKER MODEL'), 'the addressee constraint is in the instruction')
  assert.ok(a.includes('could the worker act on it directly'), 'and carries the positive self-test the maintainer named')
  assert.ok(a.includes('run the tests'), 'with a positive example of the right shape')
  // #273: the live failure is pinned IN the rule as the forbidden example — the meta/slash-command class.
  assert.ok(a.includes('run /chapters-prompt suggest and report the output'), 'the real failure names itself in the instruction')
  assert.ok(a.includes('advice to the user'), 'and names the failure mode it forbids')
})

test('#279: the rules also demand a FORWARD step — never a restatement of in-flight work', () => {
  const built = buildSuggestInput(facts([{ number: 1, title: 'Setup', summary: 'installed the rig', plots: [] }], [{ role: 'assistant' as const, text: 'done for now' }]), 4000, 240)
  const a = inputOf(built)
  assert.ok(a.includes('FORWARD'), 'the forward constraint is named')
  assert.ok(a.includes('NOT YET BEGUN'), 'the step must not have started')
  assert.ok(a.includes('never a restatement of the work this session is already doing'), 'the echo class is explicitly forbidden')
  // the reproduced live failure, pinned verbatim IN the rule, exactly as #273 pinned its own
  assert.ok(a.includes('Create the #273 echo-adjacency issue and run the pre-change sampler'), 'the real echo names itself in the instruction')
  assert.ok(a.includes('a mirror, not a director'), 'and states what the echo actually is')
})

test('#300: the GOAL: prefix is conditioned on an ACTIVE goal — never legal with none', () => {
  const built = buildSuggestInput(facts([{ number: 1, title: 'Setup', summary: 'installed the rig', plots: [] }], [{ role: 'assistant' as const, text: 'done for now' }]), 6000, 240)
  const a = inputOf(built)
  assert.ok(a.includes('prefix is legal ONLY when the goal block above names an ACTIVE goal'), 'the prefix is conditioned on the goal block, not on objective-flavored prose')
  assert.ok(a.includes('NEVER use the prefix'), 'with no active goal the sentence forbids it outright')
  assert.ok(a.includes('close out this release cycle'), 'the live mis-stamp is pinned as the named counter-example')
})

// ───────────────────────────────────────────── #340: the offer retires when the human speaks

test('#340: a new human turn retires the cached offer, while more steps inside a turn do not', async () => {
  // Both halves are load-bearing. The FIRST is the user-visible bug: the cache key was the last
  // `turn/end` seq alone, so anything the human said after that boundary could not retire the offer,
  // and /chapters-prompt suggest mid-turn answered with the PREVIOUS turn's request. The SECOND is
  // #113's guarantee: a turn appends an event per step, and an event-scoped key regenerated on every
  // step — which is how one turn once produced three different suggestions.
  let calls = 0
  const settings = new Map<string, string>([[PROMPT_SETTING_KEY, 'local/m']])
  const surface = createPromptSurface({
    getSetting: (k) => settings.get(k),
    putSetting: async (k, v) => { settings.set(k, v) },
    deleteSetting: async (k) => { settings.delete(k) },
    chaptersOf: async () => [],
    resolveWindow: async () => 128000,
    config: { model: '', contextChars: 32000, maxChars: 4096, contextRatio: 0.5 },
    conversationRoute: () => ROUTE,
    fetch: async (input: string) => {
      calls++
      const m = /Human: ([^\n]*)/.exec(input)
      return `next step after: ${m?.[1] ?? 'nothing'}`
    },
    warn: () => {},
  } as never)

  const events = [
    ev(1, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'FIRST REQUEST' }] }),
    ev(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'a1' }] } }),
    ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const first = await surface.suggest({ id: 'S', events: [...events] } as never)
  assert.equal(first.ok, true)
  assert.match(String((first as { text?: string }).text), /FIRST REQUEST/)
  assert.equal(calls, 1, 'one generation for the completed turn')

  // (a) more STEPS inside a new turn must not multiply generations (#113).
  events.push(ev(4, 'assistant/message', { message: { content: [{ type: 'text', text: 'a2' }] } }))
  events.push(ev(5, 'turn/end', { turn: 2, reason: { kind: 'completed' } }))
  await surface.suggest({ id: 'S', events: [...events] } as never)
  assert.equal(calls, 2, 'the new turn boundary is a new question — exactly one more call')

  // (b) the human speaks again, BEFORE any new boundary. This is the case the old key could not see.
  events.push(ev(6, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'SECOND REQUEST' }] }))
  const third = await surface.suggest({ id: 'S', events: [...events] } as never)
  assert.equal(calls, 3,
    '#340: a newer human turn must retire the cached offer even with no turn boundary yet — the old key held at seq 5 and returned turn 2\'s answer')
  assert.match(String((third as { text?: string }).text), /SECOND REQUEST/,
    'and the answer is generated from the newest request, not the previous turn\'s')

  // (c) asking twice with nothing new in between must NOT call again — the fix is not a poll loop.
  await surface.suggest({ id: 'S', events: [...events] } as never)
  assert.equal(calls, 3, 'still one generation per (turn boundary, newest human turn) pair')
})

test('#340: lastHumanTurnSeq ignores injected and relayed user messages', () => {
  const events = [
    ev(1, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'typed' }] }),
    ev(2, 'user/message', { role: 'user', source: { kind: 'runtime-context', form: 'snapshot', sections: [] }, content: [{ type: 'text', text: 'injected' }] }),
    ev(3, 'user/message', { role: 'user', source: { kind: 'agent-message', form: 'relay' }, content: [{ type: 'text', text: 'Continue' }] }),
    ev(4, 'user/message', { role: 'user', source: { kind: 'goal', form: 'round', goalId: 'g', revision: 1, round: 1 }, content: [{ type: 'text', text: 'goal round' }] }),
  ]
  assert.equal(lastHumanTurnSeq(events as never), 1,
    'only the typed message advances the key — a relay or a goal round is not the human speaking')
  assert.equal(lastHumanTurnSeq([] as never), -1, 'no human turn at all')
})
