/**
 * "It gets truncated in a single line entry with no way to recover the prompt. It needs to operate more like
 * chapters-status, which allows us to expand to see the whole output." (#113, maintainer)
 *
 * `/chapters-status` returns a multi-line block and the UI gives it an expander; `/chapters-prompt suggest`
 * returned `text: r.text` — one bare line, no framing, so the reader got an ellipsized nothing and no way to
 * recover what was generated. The fix is the shape, and the rules that make the block trustworthy: the prompt
 * appears VERBATIM in a fence (never elided mid-text), and the facts that bound it (model, source, cap) are
 * stated rather than implied — because "over-cap is invalid, never truncated" (`src/prompt.ts`) is only
 * honest if the output says what the cap was.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHostCommands } from '../../src/commands.ts'

const PROMPT_TEXT = 'Add a regression row that fails before the fix and passes after, then re-run the plane.'

function harness (over: Partial<{
  suggest: (s: unknown) => Promise<{ ok: boolean; text: string; quiet?: boolean }>
  effective: () => { spec: string; source: 'override' | 'config' | 'unset' }
  limits: (route: unknown) => Promise<{ maxChars: number; contextChars: number; sources: { maxChars: string; contextChars: string } }>
}> = {}) {
  const defs = new Map<string, { handler: (i: { agent: unknown; rawInput?: string }) => Promise<{ kind: string; text?: string }> }>()
  const ctx = { logger: { warn: () => undefined, info: () => undefined }, get: () => ({ register: (d: { name: string }) => { defs.set(d.name, d); return () => undefined } }) }
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => { let m = tables.get(name); if (m === undefined) { m = new Map(); tables.set(name, m) }
    return { get: (k: string) => m!.get(k), put: async (k: string, v: unknown) => { m!.set(k, v) }, delete: async (k: string) => { m!.delete(k) } } }
  registerHostCommands(ctx as never, { table } as never, {
    artifactStoreRoot: '.dsh-chapters', harnessId: 'h', subagentAutoSave: false,
    prompt: {
      effective: over.effective ?? (() => ({ spec: 'local/qwen3.8-flash-next', source: 'override' as const })),
      setModel: async () => undefined,
      suggest: over.suggest ?? (async () => ({ ok: true, text: PROMPT_TEXT })),
      statusLine: () => 'Prompt suggestions: ON',
      limits: over.limits ?? (async () => ({ maxChars: 240, contextChars: 4000, sources: { maxChars: 'config', contextChars: 'config' } })),
    } as never,
  })
  const AGENT = { session: { id: 's-9', snapshotEvents: () => [
    { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ready' }] } } },
    { seq: 3, type: 'session/title', data: { title: 'The Wiring' } },
  ] } }
  return async (input: string) => await defs.get('chapters-prompt')!.handler({ agent: AGENT, rawInput: input })
}

test('suggest returns a multi-line block with the prompt verbatim in a fence (#113)', async () => {
  const out = await harness()('suggest')
  assert.equal(out.kind, 'success')
  const text = out.text ?? ''
  assert.ok(text.split('\n').length >= 4, `a bare line is what got ellipsized; got:\n${text}`)
  assert.ok(text.includes(PROMPT_TEXT), 'the generated prompt must appear whole, not truncated')
  assert.match(text, /```[\s\S]*```/, 'fenced so the reader can tell the offer from its framing')
})

test('the block names what produced it and what bounded it (#113)', async () => {
  const text = (await harness()('suggest')).text ?? ''
  assert.match(text, /local\/qwen3\.8-flash-next/, 'the model that wrote it')
  assert.match(text, /override/, 'and whether that came from a stored override or the config default')
  assert.match(text, /240/, 'the cap it was validated against — over-cap is refused, never truncated, so the number must be visible')
  assert.match(text, /The Wiring/, 'which session it was generated for')
})

test('a quiet refusal is readable output, not an error line (#113)', async () => {
  const run = harness({ suggest: async () => ({ ok: false, quiet: true, text: 'nothing to recommend yet — no completed assistant turn' }) })
  const out = await run('suggest')
  assert.equal(out.kind, 'success', 'the human asked; an honest "there is nothing yet" is an answer')
  assert.match(out.text ?? '', /nothing to recommend yet/)
})

test('a real failure still reports as an error (#113)', async () => {
  const run = harness({ suggest: async () => ({ ok: false, text: 'prompt model call failed: upstream reset' }) })
  const out = await run('suggest')
  assert.equal(out.kind, 'error', 'only genuine failures may shout — silence is for having nothing to offer')
  assert.match(out.text ?? '', /upstream reset/)
})
