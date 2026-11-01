/**
 * #71 — the `/chapters-prompt` command surface over the host-command registry,
 * and the /chapters-status line. Same harness shape as
 * tests/integration/host-command-branches.test.ts: a stubbed commands registry,
 * the prompt surface as a spy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHostCommands } from '../../src/commands.ts'

function harness(prompt?: {
  effective?: () => { spec: string; source: 'override' | 'config' | 'unset' }
  setModel?: (spec: string | null) => Promise<void>
  setCaps?: (opts: { maxChars?: string | null; contextChars?: string | null }) => Promise<void>
  suggest?: (session: { id: string; title?: string | undefined; events: unknown[] }) => Promise<{ ok: boolean; text: string }>
  statusLine?: () => string
}) {
  const defs = new Map<string, { handler: (inv: { agent: unknown; rawInput?: string }) => Promise<{ kind: string; text?: string }> }>()
  const ctx = {
    logger: { warn: () => undefined, info: () => undefined },
    get: () => ({ register: (d: { name: string }) => { defs.set(d.name, d); return () => undefined } }),
  }
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => {
    let m = tables.get(name)
    if (m === undefined) { m = new Map(); tables.set(name, m) }
    return { get: (k: string) => m!.get(k), put: async (k: string, v: unknown) => { m!.set(k, v) }, delete: async (k: string) => m!.delete(k), entries: () => m!.entries(), size: 0 }
  }
  const disposer = registerHostCommands(ctx as never, { table } as never, {
    artifactStoreRoot: '.dsh-chapters',
    harnessId: 'h',
    subagentAutoSave: false,
    prompt: prompt as never,
  })
  const run = async (input: string, agent: unknown = {}) => await defs.get('chapters-prompt')!.handler({ agent, rawInput: input })
  return { defs, run, disposer }
}

const AGENT = {
  session: {
    id: 's-9',
    snapshotEvents: () => [
      { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ready' }] } } },
      { seq: 3, type: 'session/title', data: { title: 'The Wiring' } },
    ],
  },
}

test('/chapters-prompt model with no arg reports the effective spec and its source', async () => {
  const h = harness({ effective: () => ({ spec: 'p/m', source: 'override' }), statusLine: () => 'Prompt suggestions: ON — p/m (override)' })
  const r = await h.run('model')
  assert.equal(r.kind, 'success')
  assert.match(r.text!, /^prompt model: p\/m \(override\) — ON$/)
  const off = harness({ effective: () => ({ spec: '', source: 'unset' }), statusLine: () => 'x' })
  assert.match((await off.run('model')).text!, /OFF.*unset/)
})

test('model <spec> ENABLES with the promised sentence; clear deletes the row (never stores empty); off stores empty', async () => {
  const writes: Array<string | null> = []
  let effective = { spec: '', source: 'unset' as const }
  const h = harness({
    effective: () => effective,
    setModel: async (s) => { writes.push(s); effective = s === null ? { spec: 'p/m', source: 'config' } : { spec: s, source: 'override' } },
    statusLine: () => 'x',
  })
  const set = await h.run('model p/m')
  assert.deepEqual(writes, ['p/m'])
  assert.match(set.text!, /set to p\/m — this ENABLES the composer ghost/)
  assert.match(set.text!, /\/chapters-prompt off disables/)
  const clear = await h.run('model clear')
  assert.deepEqual(writes, ['p/m', null], 'clear passes NULL — deletion, not the empty string')
  assert.match(clear.text!, /now following the config default \(p\/m, ON\)/)
  const off = await h.run('off')
  assert.deepEqual(writes[2], '', 'off is the STORED EMPTY override')
  assert.match(off.text!, /OFF \(stored override; \/chapters-prompt model clear restores the config default\)/)
})

test('suggest without a session scope refuses with the remedy; with one, it hands the surface id/title/events verbatim', async () => {
  const seen: unknown[] = []
  const h = harness({
    effective: () => ({ spec: 'p/m', source: 'config' }),
    suggest: async (session) => { seen.push(session); return { ok: true, text: 'write the test' } },
    statusLine: () => 'x',
  })
  const bare = await h.run('suggest', {})
  assert.equal(bare.kind, 'error')
  assert.match(bare.text!, /needs a session scope/)
  const ok = await h.run('suggest', AGENT)
  assert.equal(ok.kind, 'success')
  // #113: the bare line became a labelled block so the composer gives it an expander — the prompt must still
  // be in it VERBATIM (that is the whole point: it was previously truncated with no way to recover it).
  assert.equal(typeof ok.text, 'string')
  assert.ok((ok.text ?? '').includes('write the test'), 'the generated prompt appears whole inside the block')
  assert.ok((ok.text ?? '').split('\n').length >= 4, 'multi-line, like /chapters-status, or the UI ellipsizes it again')
  const passed = seen[0] as { id: string; title?: string; events: { seq: number }[] }
  assert.equal(passed.id, 's-9')
  assert.equal(passed.title, 'The Wiring', 'the LAST session/title event is the current title')
  assert.equal(passed.events.length, 3)
  const refused = harness({
    effective: () => ({ spec: 'p/m', source: 'config' }),
    suggest: async () => ({ ok: false, text: 'prompt model call failed: offline' }),
    statusLine: () => 'x',
  })
  const r = await refused.run('suggest', AGENT)
  assert.equal(r.kind, 'error')
  assert.match(r.text!, /model call failed/)
})

test('unwired plane: every verb refuses with its reason; usage prints for unknown verbs', async () => {
  const h = harness(undefined)
  for (const verb of ['model', 'model p/m', 'off', 'suggest']) {
    const r = await h.run(verb, AGENT)
    assert.equal(r.kind, 'error')
    assert.match(r.text!, /not wired on this plane/)
  }
  const wired = harness({ effective: () => ({ spec: '', source: 'unset' }), statusLine: () => 'x' })
  assert.match((await wired.run('wat')).text!, /usage: \/chapters-prompt model \[provider\/model \| clear\] \| off \| suggest/)
})

test('/chapters-status prints the prompt state, wired or not — never omits the line', async () => {
  const agent = { session: { header: { cwd: '/tmp/prompt-cmd-test-nonexistent' } } }
  const statusWith = harness({ statusLine: () => 'Prompt suggestions: ON — p/m (override; the composer ghost offers its answer, accepted only by your keystroke)' })
  const withLine = await statusWith.defs.get('chapters-status')!.handler({ agent })
  assert.match(withLine.text!, /Prompt suggestions: ON — p\/m \(override/)
  const without = harness(undefined)
  const noLine = await without.defs.get('chapters-status')!.handler({ agent })
  assert.match(noLine.text!, /Prompt suggestions: not wired on this plane/)
})

test('the prompt command ships a hint the composer can render', async () => {
  const h = harness({ statusLine: () => 'x' })
  // registerHostCommands stores defs via the stub; assert the registration shape directly.
  const registered = (h.defs.get('chapters-prompt') as unknown as { name: string; description: string; input: { hint: string } })
  assert.equal(registered.name, 'chapters-prompt')
  assert.match(registered.description, /Prompt recommendations \(#71, site §28\)/)
  assert.equal(registered.input.hint, 'model [provider/model | clear] | off | suggest')
})

/**
 * The Suggested Next Step bar's pull verbs (#113).
 *
 * The bar is a mouth for the command plane, so these rows are the bar's contract with the server — what the
 * component can rely on finding in the text. Two rules they insist on: a payload the client can parse must
 * carry the durable facts (status, turn) AND the process-local flag (autorun), since the row and the flag
 * have different owners; and every refusal names the remedy, including the case where the bar is simply not
 * wired on this host (#61 — a silent blank is the bug this repo keeps re-meeting).
 */
const barState = { status: 'ready', text: 'Land #114, then cut 0.2.2.\nThen wire the verbs.', turnSeq: 41, error: '', at: '2026-10-25T00:00:00.000Z' }

test('`state` answers with the facts the bar renders, in one parseable block', async () => {
  const calls: Array<{ on: boolean }> = []
  const h = harness({
    effective: () => ({ spec: 'local/qwen', source: 'config' }),
    statusLine: () => 'prompt: ON (local/qwen)',
    bar: {
      read: async () => ({ ...barState, autorun: 'armed', fired: 2 }),
      setAutorun: (_id: string, on: boolean) => { calls.push({ on }); return { autorun: on ? 'armed' as const : 'disarmed' as const, fired: 2, displaced: true } },
      disarmHuman: () => undefined, setOff: async () => undefined, setOn: async () => undefined,
    },
  })
  const res = await h.run('state', AGENT)
  assert.equal(res.kind, 'success')
  const text = res.text ?? ''
  assert.match(text, /^suggested next step: ready/, 'the first line is what parseBarState keys on')
  assert.match(text, /model: local\/qwen \(config\) — one offer per completed turn/)
  assert.match(text, /autorun: armed \(2 round\(s\) started this process\)/, 'the process-local flag rides along')
  assert.match(text, /turn: 41/, 'and the identity of the offer, so a stale one is recognisable')
  assert.match(text, /  prompt:\n    Land #114, then cut 0\.2\.2\.\n    Then wire the verbs\./, 'multi-line prompt, indented, in order')

  // The round-trip that matters: the component parses what this verb printed.
  const { parseBarState, parseBarAutorun } = await import('../../src/client/prompt-bar.ts')
  const ev = parseBarState(text)
  assert.ok(ev && ev.t === 'polled' && ev.status === 'ready' && ev.turnSeq === 41)
  assert.equal(parseBarAutorun(text), 'armed')
})

test('a failure state prints its reason, and an unwired bar says so instead of going blank', async () => {
  const failed = harness({
    effective: () => ({ spec: 'local/qwen', source: 'config' }),
    bar: {
      read: async () => ({ status: 'failed', text: '', turnSeq: 12, error: 'no route for the suggestion model', at: '', autorun: 'disarmed', fired: 0 }),
      setAutorun: () => ({ autorun: 'disarmed' as const, fired: 0, displaced: false }), disarmHuman: () => undefined, setOff: async () => undefined, setOn: async () => undefined,
    },
  })
  const ftext = (await failed.run('state', AGENT)).text ?? ''
  assert.match(ftext, /^suggested next step: failed/)
  assert.match(ftext, /error: no route for the suggestion model/, '#61: the reason survives the wire')
  assert.ok(!ftext.includes('prompt:'), 'and there is no offer to render')

  const unwired = harness({ effective: () => ({ spec: '', source: 'unset' }) })
  const ures = await unwired.run('state', AGENT)
  assert.equal(ures.kind, 'error')
  assert.match(ures.text ?? '', /session scope|not wired/, `an absent seam is named, never silent: ${ures.text}`)
})

test('`autorun` arms only with a model to generate from, and refuses by naming both spellings', async () => {
  const calls: boolean[] = []
  const mk = (spec: string) => harness({
    effective: () => ({ spec, source: spec === '' ? 'unset' : 'config' }),
    bar: {
      read: async () => ({ ...barState, autorun: spec === '' ? 'disarmed' : 'armed', fired: 0 }),
      setAutorun: (_id, on) => { calls.push(on); return { autorun: on ? 'armed' as const : 'disarmed' as const, fired: 0, displaced: true } },
      disarmHuman: () => undefined, setOff: async () => undefined, setOn: async () => undefined,
    },
  })
  const refused = await mk('').run('autorun on', AGENT)
  assert.equal(refused.kind, 'error')
  assert.match(refused.text ?? '', /no prompt model/, `arming without a model is refused with the reason: ${refused.text}`)
  assert.match(refused.text ?? '', /model <provider\/model>/, 'and the remedy that fixes it')
  assert.equal(calls.length, 0, 'the refusal does not touch the loop')

  const armed = await mk('local/qwen').run('autorun on', AGENT)
  assert.equal(armed.kind, 'success')
  assert.match(armed.text ?? '', /ARMED/)
  assert.match(armed.text ?? '', /until you stop it or send a prompt yourself/, 'the ending conditions are stated at the moment of opting in')
  assert.match(armed.text ?? '', /goal continuation is disarmed|auto-continuation is disarmed/, 'and the message names WHO now owns the turn — arming a director loop with a goal armed is a handover, not a second engine')
  assert.match(armed.text ?? '', /Re-arm it with \/goal resume/, 'and how to hand it back, matching the host rule that a model may not resume a paused goal')
  assert.deepEqual(calls, [true])

  const off = await mk('local/qwen').run('autorun off', AGENT)
  assert.match(off.text ?? '', /disarmed .*offers still appear/, 'off stops the running, not the offering')

  calls.length = 0
  const bad = await mk('local/qwen').run('autorun maybe', AGENT)
  assert.equal(bad.kind, 'error')
  assert.match(bad.text ?? '', /needs 'on' or 'off'/)
  assert.equal(calls.length, 0, 'and a typo does not silently disarm anything')
})

test('`on` restores generation but cannot invent a model that was never set', async () => {
  let setOn = 0
  const mk = (spec: string) => harness({
    effective: () => ({ spec, source: spec === '' ? 'unset' : 'config' }),
    bar: {
      read: async () => ({ ...barState, autorun: 'disarmed', fired: 0 }),
      setAutorun: () => ({ autorun: 'disarmed' as const, fired: 0, displaced: false }), disarmHuman: () => undefined, setOff: async () => undefined,
      setOn: async () => { setOn += 1 },
    },
  })
  const nope = await mk('').run('on', AGENT)
  assert.equal(nope.kind, 'error')
  assert.match(nope.text ?? '', /nothing to turn on/, `turning on is not a way to conjure a model: ${nope.text}`)
  assert.equal(setOn, 0)
  const yes = await mk('local/qwen').run('on', AGENT)
  assert.equal(yes.kind, 'success')
  assert.match(yes.text ?? '', /the next completed turn offers/)
  assert.equal(setOn, 1, 'the stale `off` row is cleared so the door can claim the next turn')
})

/**
 * `/chapters-prompt run` — the bar's Run button, exercised rather than grepped (#113).
 *
 * My first "coverage" of this verb was a row that searched the source for the string `verb === 'run'`.
 * That asserts the shape of the file, not the behavior, and it is exactly why CI's branch gate slipped
 * below 85%: the new branches had never been executed by anything. These three run the handler.
 */
test('run submits the offer through the shared follow-up path when the session scope exists', async () => {
  const seen: string[] = []
  const h = harness({
    effective: () => ({ spec: 'local/qwen', source: 'config' }),
    statusLine: () => 'prompt: ON',
    bar: {
      read: async () => ({ ...barState, autorun: 'disarmed', fired: 0 }),
      setAutorun: () => ({ autorun: 'disarmed' as const, fired: 0, displaced: false }),
      disarmHuman: () => undefined, setOff: async () => undefined, setOn: async () => undefined,
      runNow: async (id: string) => { seen.push(id); return { ok: true, text: 'Land #114, then cut 0.2.2.' } },
    },
  })
  const res = await h.run('run', AGENT)
  assert.equal(res.kind, 'success', `the verb must succeed: ${res.text ?? ''}`)
  assert.equal(seen.length, 1, 'and it delegated to the ONE submission path, with the session id')
  assert.equal(seen[0], (AGENT as { session?: { id?: string } }).session?.id ?? (AGENT as { agent?: { session?: { id?: string } } }).agent?.session?.id)
  assert.match(res.text ?? '', /running the suggested next step as your own turn/, 'the human is told what happened')
  assert.match(res.text ?? '', /Land #114, then cut 0\.2\.2\./, 'and which words went out')
})

test('run refuses with the reason when there is nothing on screen to run', async () => {
  const h = harness({
    effective: () => ({ spec: 'local/qwen', source: 'config' }),
    statusLine: () => 'prompt: ON',
    bar: {
      read: async () => ({ ...barState, autorun: 'disarmed', fired: 0 }),
      setAutorun: () => ({ autorun: 'disarmed' as const, fired: 0, displaced: false }),
      disarmHuman: () => undefined, setOff: async () => undefined, setOn: async () => undefined,
      runNow: async () => ({ ok: false, reason: 'there is no offer on screen to run' }),
    },
  })
  const res = await h.run('run', AGENT)
  assert.equal(res.kind, 'error')
  assert.match(res.text ?? '', /cannot run: there is no offer on screen/, 'the refusal keeps its reason, verbatim')
})

test('run needs a session scope and says so rather than guessing a session', async () => {
  const h = harness({
    effective: () => ({ spec: 'local/qwen', source: 'config' }),
    statusLine: () => 'prompt: ON',
    bar: {
      read: async () => ({ ...barState, autorun: 'disarmed', fired: 0 }),
      setAutorun: () => ({ autorun: 'disarmed' as const, fired: 0, displaced: false }),
      disarmHuman: () => undefined, setOff: async () => undefined, setOn: async () => undefined,
      runNow: async () => { throw new Error('must not be reached without a session') },
    },
  })
  const res = await h.run('run', {})
  assert.equal(res.kind, 'error')
  assert.match(res.text ?? '', /run needs a session scope/)
})

test('#188: model <id> [maxChars [contextChars]] stores the caps beside the model; garbage numbers refuse', async () => {
  const caps: Array<{ maxChars?: string | null; contextChars?: string | null }> = []
  let effective = { spec: '', source: 'unset' as const }
  const h = harness({
    effective: () => effective,
    setModel: async (s) => { effective = s === null ? { spec: '', source: 'unset' } : { spec: s, source: 'override' } },
    setCaps: async (opts) => { caps.push(opts) },
    statusLine: () => 'x',
  })
  const both = await h.run('model p/m 2000 50000')
  assert.equal(both.kind, 'success', both.text)
  assert.deepEqual(caps[0], { maxChars: '2000', contextChars: '50000' })
  assert.match(both.text!, /suggestion 2000 chars/, 'the stored caps are echoed')
  assert.match(both.text!, /context budget 50000 chars/)
  const none = await h.run('model p/m')
  assert.equal(none.kind, 'success', none.text)
  assert.equal(caps.length, 1, 'no numbers, no caps write — derivation stays in charge')
  assert.match(none.text!, /derive from this model's context window/, 'and the reply says so')
  const bad = await h.run('model p/m lots')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text!, /positive integers/)
  const extra = await h.run('model p/m 1 2 3')
  assert.equal(extra.kind, 'error', 'a fourth token is not a cap')
})

test('#208: the enabling replies state the revival path — a hidden bar reappears at the next page reload', async () => {
  let effective = { spec: 'p/m', source: 'override' as const }
  const h = harness({
    effective: () => effective,
    setModel: async (s) => { effective = s === null ? { spec: '', source: 'unset' } : { spec: s, source: 'override' } },
    statusLine: () => 'x',
    bar: {
      read: async () => ({ status: 'off' as const, text: '', turnSeq: null, error: '', at: '', intent: 'worker-step' as const, goalRevision: null, autorun: 'disarmed' as const, fired: 0 }),
      setAutorun: () => ({ autorun: 'disarmed' as const, fired: 0, displaced: false }),
      runNow: async () => ({ ok: true }),
      disarmHuman: () => undefined, setOff: async () => undefined, setOn: async () => undefined,
    },
  })
  const on = await h.run('on', { session: { id: 's1' } })
  assert.equal(on.kind, 'success', String(on.text))
  assert.match(on.text!, /page reload/, 'on states the revival path')
  const model = await h.run('model p/m', { session: { id: 's1' } })
  assert.equal(model.kind, 'success', String(model.text))
  assert.match(model.text!, /page reload/, 'model states it too')
  assert.match(model.text!, /this ENABLES the composer ghost/, 'and the pinned sentence is untouched')
})
