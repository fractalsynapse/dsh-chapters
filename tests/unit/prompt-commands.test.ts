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
