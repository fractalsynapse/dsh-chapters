/**
 * #173 — /chapters-models: the discovery surface for the three model settings.
 *
 * The stub llm is shaped like the HOST's service, not like my convenience (the measure-the-shape rule):
 * `listProviders()` is SYNC and returns `{id, name}[]`; `listModels(provider)` resolves
 * `LlmModelInfo[]` (`provider`, `id`, `name`, `description?`); `resolveModelInfo(provider, model)`
 * resolves the exact route adding `context.contextWindow` and `reasoning.efforts`/`defaultEffort` —
 * the shape `examples/dsh/packages/llm/llm/src/index.ts` publishes and its own `list_subagent_models`
 * tool consumes. A stub that invented an easier shape would pass a dead surface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelsCommand, type ModelsIo, type ModelsLlm } from '../../src/models-command.ts'

function stubLlm(over: Partial<ModelsLlm> = {}): ModelsLlm {
  return {
    listProviders: () => [
      { id: 'alibaba', name: 'Alibaba Token Plan' },
      { id: 'deepseek', name: 'DeepSeek' },
    ],
    listModels: async (provider: string) => provider === 'alibaba'
      ? [
          { provider: 'alibaba', id: 'qwen3-max', name: 'Qwen3 Max', description: 'flagship' },
          { provider: 'alibaba', id: 'qwen3-4b', name: 'Qwen3 4B' },
        ]
      : provider === 'deepseek'
        ? []
        : (() => { throw new Error(`unexpected provider ${provider}`) })(),
    resolveModelInfo: async (provider: string, model: string) => ({
      provider, id: model, name: model === 'qwen3-max' ? 'Qwen3 Max' : model,
      context: { contextWindow: 262144 },
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
    }),
    ...over,
  }
}

function io(over: Partial<ModelsIo> = {}): ModelsIo {
  return {
    llm: stubLlm(),
    current: {
      enrichment: { value: 'alibaba/qwen3-max', source: 'settings' },
      rules: { value: '', source: 'rides-enrichment' },
      prompt: { value: '', source: 'off' },
    },
    ...over,
  }
}

test('no args: every provider and its advertised models as paste-ready provider/model ids, plus the current three (#173)', async () => {
  const r = await modelsCommand(io(), '')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /alibaba\/qwen3-max/, 'the identifier is rendered in the exact form the setters accept')
  assert.match(r.text, /alibaba\/qwen3-4b/)
  assert.match(r.text, /Qwen3 Max/, 'names ride along')
  assert.match(r.text, /flagship/, 'descriptions ride along when advertised')
  assert.match(r.text, /Alibaba Token Plan/, 'provider display names are shown')
  assert.match(r.text, /advisory/i, 'the catalog caveat is explicit — routing accepts unlisted ids')
  assert.match(r.text, /enrichment[^\n]*alibaba\/qwen3-max/, 'the current enrichment route, from settings')
  assert.match(r.text, /rules\.model[^\n]*(unset|rides)/i, 'rules unset says what it rides, not just empty')
  assert.match(r.text, /prompt[^\n]*OFF/i, 'empty promptModel means the feature is off — the output must SAY that')
  assert.match(r.text, /\/chapters-enrich model/, 'and name the setter that changes it')
  assert.match(r.text, /\/chapters-rule model/)
  assert.match(r.text, /\/chapters-prompt model/)
})

test('one arg: only that provider; unknown provider refuses with the available list', async () => {
  const r = await modelsCommand(io(), 'alibaba')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /alibaba\/qwen3-max/)
  assert.doesNotMatch(r.text, /deepseek\//, 'no other provider\'s models leak into a filtered view')
  const bad = await modelsCommand(io(), 'openai')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /not registered/i)
  assert.match(bad.text, /alibaba/, 'the refusal names what IS available — the host tool\'s own shape')
})

test('provider + model: the exact route resolves — context window and reasoning efforts, defaults marked', async () => {
  const r = await modelsCommand(io(), 'alibaba qwen3-max')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /262144/, 'the context window — the number the maintainer asked for by name')
  assert.match(r.text, /low \(default\)/, 'efforts render with the default marked')
  assert.match(r.text, /high/)
})

test('a route that advertises no context or efforts says so instead of guessing', async () => {
  const h = io({ llm: stubLlm({ resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }) }) })
  const r = await modelsCommand(h, 'alibaba qwen3-4b')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /context window:\s*not advertised/i)
  assert.match(r.text, /no advertised reasoning efforts/i)
})

test('an empty catalog renders as a fact with the advisory, never as a hang or a guess', async () => {
  const r = await modelsCommand(io(), 'deepseek')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /no advertised models/i)
  assert.match(r.text, /advisory/i)
})

test('no llm service on this plane: a clean refusal, never a crash', async () => {
  const r = await modelsCommand(io({ llm: undefined }), '')
  assert.equal(r.kind, 'error')
  assert.match(r.text, /llm service is unavailable/i)
})

test('a paste-ready id works as ONE arg — provider/model splits at the first slash', async () => {
  // The whole point of the command is that its output can be pasted back in; a positional command
  // cannot tell a bare model id from a provider id, so the slash form is the sanctioned one-arg route.
  const r = await modelsCommand(io(), 'alibaba/qwen3-max')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /262144/, 'it resolves the exact route, same as the two-arg form')
})
