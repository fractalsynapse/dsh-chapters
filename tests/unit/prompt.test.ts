/**
 * #71 prompt recommendations — the pure planner and the surface (src/prompt.ts).
 * Every row is written to fail on the mutation it guards (docs/verify.md
 * § Prompt recommendations): precedence, routing, screening, the cap ladders,
 * the one-call-per-boundary cache, and the in-flight dedup.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROMPT_SETTING_KEY, buildSuggestInput, createPromptSurface, effectivePromptSpec,
  promptChaptersOf, resolvePromptRoute, tailFromEvents, validateSuggestion,
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
  assert.deepEqual(tail, [
    { role: 'user', text: 'do the thing' },
    { role: 'assistant', text: 'done.' },
    { role: 'user', text: 'next one' },
  ])
})

// ---------------------------------------------------------------- input assembly

const facts = (chapters: { number: number; title: string; summary: string }[], tail: { role: 'user' | 'assistant'; text: string }[]) =>
  ({ title: 'Session X', chapters, tail })

test('the input is deterministic, carries both sections, and ends with the reply rule + cap', () => {
  const f = facts(
    [{ number: 1, title: 'Setup', summary: 'installed the rig' }],
    [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi — what next?' }],
  )
  const a = buildSuggestInput(f, 4000, 240)
  assert.equal(a, buildSuggestInput(f, 4000, 240))
  assert.match(a, /second reader/)
  assert.match(a, /## Session: Session X/)
  assert.match(a, /1\. Setup — installed the rig/)
  assert.match(a, /Human: hello\nAssistant: hi — what next\?/)
  assert.match(a, /at most 240 characters/)
  assert.ok(!a.includes('dropped'), 'a fitting input announces nothing')
})

test('over budget drops the OLDEST chapters first, then the oldest messages, and says so with counts', () => {
  const chapters = [1, 2, 3, 4].map((n) => ({ number: n, title: `t${n}`, summary: `s${n}` }))
  const tail = [1, 2, 3].map((n) => ({ role: 'user' as const, text: `message number ${n} with some bulk ${'x'.repeat(80)}` }))
  const input = buildSuggestInput(facts(chapters, tail), 600, 240)
  assert.match(input, /older context dropped to fit the 600-char budget: \d+ chapter line\(s\), \d+ message\(s\)/)
  assert.ok(input.length <= 600, 'the budget is HARD')
  assert.ok(input.includes('message number 3'), 'the newest message survives longest')
  assert.ok(!input.includes('message number 1'), 'oldest goes first')
  // Chapters are the compressible past: at this cap they may ALL be gone — but whatever remains is the newest.
  const kept = chapters.filter((c) => input.includes(`${c.number}. t${c.number}`))
  for (let i = 1; i < kept.length; i++) assert.ok(kept[i - 1]!.number < kept[i]!.number, 'kept chapters are the newest suffix')

  // The order is PINED, not vacuous: chapters whose lines are far bigger than the
  // drop-announcement mean exactly ONE drop fits the tightened budget — and it is
  // the OLDEST line that goes.
  const bigChapters = [1, 2, 3, 4].map((n) => ({ number: n, title: `t${n}`, summary: `s${n}` + 'q'.repeat(300) }))
  const smallTail = [{ role: 'user' as const, text: 'last' }]
  const whole = buildSuggestInput({ title: 'S', chapters: bigChapters, tail: smallTail }, 100_000, 240)
  assert.ok(whole.includes('1. t1') && whole.includes('4. t4'), 'a generous cap keeps everything')
  const tight = buildSuggestInput({ title: 'S', chapters: bigChapters, tail: smallTail }, whole.length - 1, 240)
  assert.ok(!tight.includes('1. t1'), 'the oldest chapter line drops first')
  assert.ok(tight.includes('4. t4'), 'the newest chapter line survives longest')
  assert.ok(tight.length <= whole.length - 1, 'and the cap still holds')
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
