/**
 * When may the ghost fire? (#113) The maintainer's test produced THREE different suggestions from one turn and
 * an error message on a thread that had nothing to offer. Both are the same missing thing: a rule for when the
 * surface may call the model, and a way to say "nothing" without shouting it.
 *
 *   - generation is keyed on the COMPLETED TURN, not the last surface event. A turn is many events: each step
 *     moves `events[last].seq`, so an event-scoped cache re-fires per step — three steps, three prompts.
 *   - a refusal to offer something is not an error. `quiet: true` marks the "nothing to recommend yet" and
 *     "suggestions are off" answers, so the composer can render silence; only a route/assembly/model failure
 *     is allowed to speak.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPromptSurface, type PromptConfig } from '../../src/prompt.ts'

const CONFIG: PromptConfig = { model: 'local/qwen3.8-flash-next', contextChars: 4000, contextRatio: 0.5, maxChars: 240 }
const msg = (seq: number, type: string, text?: string) =>
  type === 'turn/end'
    ? { type, seq, data: { turn: 1 } }
    : { type, seq, data: { id: `m${seq}`, role: type.split('/')[0], source: { kind: 'user' }, content: [{ type: 'text', text: text ?? `event ${seq}` }] } }

function world(opts: { events: never[], fail?: boolean, echo?: string } & Record<string, unknown>) {
  const calls: string[] = []
  const settings = new Map<string, string>()
  const surface = createPromptSurface({
    getSetting: (k: string) => settings.get(k),
    putSetting: async (k: string, v: string) => { settings.set(k, v) },
    deleteSetting: async (k: string) => { settings.delete(k) },
    chaptersOf: async () => [{ number: 1, title: 'Work', summary: 'did the thing', plots: [] }],
    config: { ...CONFIG, model: 'local/qwen3.8-flash-next' },
    conversationRoute: () => ({ provider: 'local', model: 'qwen3.8-flash-next' }),
    fetch: async (input: string) => {
      calls.push(input)
      if (opts.fail === true) throw new Error('stream refused')
      return (opts.echo as string) ?? 'Run the tests.'
    },
    warn: () => {},
  })
  return { surface, calls }
}

const session = (events: unknown[]) => ({ id: 'S', title: 'T', events: events as never }) as never

test('one completed turn yields ONE generation, however many steps follow (#113)', async () => {
  // turn 1 closed at seq 4; two more steps land inside the SAME turn (no new turn/end).
  const first = [msg(0, 'user/message'), msg(1, 'assistant/message'), msg(2, 'user/message'), msg(3, 'assistant/message'), msg(4, 'turn/end')]
  const { surface, calls } = world({ events: first as never[] })
  const a = await surface.suggest(session(first))
  assert.equal(a.ok, true, `first offer: ${a.text}`)
  assert.equal(calls.length, 1)
  const grown = [...first, msg(5, 'tool/call'), msg(6, 'tool/result'), msg(7, 'assistant/message')]
  const b = await surface.suggest(session(grown))
  assert.equal(calls.length, 1, `steps inside the same turn must NOT re-ask the model (got ${String(calls.length)} calls)`)
  assert.equal(b.text, a.text, 'and the human sees the same offer, not a new one per step')
})

test('a NEW completed turn may generate again (#113)', async () => {
  const turn1 = [msg(0, 'user/message'), msg(1, 'assistant/message'), msg(2, 'turn/end')]
  const { surface, calls } = world({ events: turn1 as never[] })
  await surface.suggest(session(turn1))
  assert.equal(calls.length, 1)
  const turn2 = [...turn1, msg(3, 'user/message'), msg(4, 'assistant/message'), msg(5, 'turn/end')]
  await surface.suggest(session(turn2))
  assert.equal(calls.length, 2, 'a fresh turn is a fresh question — the key is the turn boundary, not a freeze')
})

test('"nothing to offer yet" is silence, not an error (#113)', async () => {
  const noAssistant = [msg(0, 'user/message')]
  const { surface, calls } = world({ events: noAssistant as never[] })
  const r = await surface.suggest(session(noAssistant))
  assert.equal(r.ok, false)
  assert.equal(r.quiet, true, 'a thread with no completed assistant turn must be able to say "nothing" quietly')
  assert.equal(calls.length, 0, 'and it must not spend a model call to find that out')
})

test('a real failure is NOT quiet (#113)', async () => {
  const done = [msg(0, 'user/message'), msg(1, 'assistant/message'), msg(2, 'turn/end')]
  const { surface } = world({ events: done as never[], fail: true })
  const r = await surface.suggest(session(done))
  assert.equal(r.ok, false)
  assert.notEqual(r.quiet, true, 'the only things allowed to speak are genuine failures — route, assembly, the call')
  assert.match(r.text, /prompt model call failed|cannot run/, 'and they say what failed')
})
