/**
 * #414 — aligning the booted rig profile to exactly ONE harness route.
 *
 * The measured void: boot's live+harness branch replaced the `llm-pi-ai` provider block with the
 * ambient one, but the seeded `agent-default-model: provider: local` row SURVIVED the swap — the
 * session composed `local/qwen3.8-flash-next`, its provider block was gone, and the turn died at
 * `no credential for provider route "local"` before any request left the machine. Boot's own
 * comment demands it: "which model powered this leg must have exactly one answer." This function
 * enforces the sentence and boot refuses on its verdict — named at startup, never 15 minutes into
 * a marker wait.
 *
 * The fixture is the REAL seed profile (tests/e2e/fixtures/dev-profile-cordis.patch.yml) so the
 * indentation facts are the file's, not an invention — the same rule that caught the doubled-`\s`
 * parser bug in harness-provider.ts. The seed carries NO llm-pi-ai block (boot's tracked branch
 * appends one at boot time), so alignment must handle both the replace case and the append case.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { applyHarnessRoute, harnessProviderPatch, type ProviderRoute } from '../e2e/harness-provider.ts'

const SEED = fs.readFileSync(path.join(process.cwd(), 'tests/e2e/fixtures/dev-profile-cordis.patch.yml'), 'utf8')

const route = (overrides: Partial<ProviderRoute> = {}): ProviderRoute => ({
  id: 'qwen-token-plan',
  model: 'qwen3.8-flash',
  apiKeyEnv: 'QWEN_TOKEN_PLAN_API_KEY',
  providerBlock: [
    '      qwen-token-plan:',
    '        displayName: Qwen Token Plan',
    '        apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY',
    '        models:',
    '          - id: qwen3.8-flash',
    '            contextWindow: 1000000',
    '            maxTokens: 131072',
  ].join('\n'),
  defaultModelBlock: [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: qwen-token-plan',
    '    model: qwen3.8-flash',
  ].join('\n'),
  ...overrides,
})

const defaultsOf = (t: string): number => (t.match(/^- id: agent-default-model\s*$/gm) ?? []).length
const llmPiaiOf = (t: string): number => (t.match(/^- id: llm-pi-ai\s*$/gm) ?? []).length

test('#414: the real seed (no provider block) aligns to one harness default row and appends the block', () => {
  assert.equal(llmPiaiOf(SEED), 0, 'control: the seed carries NO llm-pi-ai block — append is a real case')
  assert.match(SEED, /- id: agent-default-model\n  config:\n    provider: local/)
  const out = applyHarnessRoute(SEED, route(), 32000)
  assert.equal(out.error, null, `align failed: ${out.error ?? ''}`)
  assert.equal(defaultsOf(out.text), 1, 'EXACTLY one default row survives')
  assert.match(out.text, /- id: agent-default-model\n\s*(?:[^\n]*\n\s*)*?provider: qwen-token-plan/)
  assert.doesNotMatch(out.text, /provider: local/)
  assert.match(out.text, /^ {6}qwen-token-plan:\s*$/m, 'the provider block the default row names is present')
  assert.match(out.text, /contextWindow: 32000/)
  assert.doesNotMatch(out.text, /contextWindow: 1000000/, 'the endpoint real window never reaches the booted profile')
})

test('#414: a booted (block-present) profile REPLACES — never duplicates — the provider row', () => {
  const booted = harnessProviderPatch(route(), 32000) + '\n' + SEED
  assert.equal(llmPiaiOf(booted), 1)
  const out = applyHarnessRoute(booted, route(), 32000)
  assert.equal(out.error, null, `align failed: ${out.error ?? ''}`)
  assert.equal(llmPiaiOf(out.text), 1, 'one llm-pi-ai row, replaced in place')
  assert.equal(defaultsOf(out.text), 1, 'one default row: the tracked local row was collapsed')
  assert.doesNotMatch(out.text, /provider: local/)
})

test('#414: alignment is idempotent — a re-applied boot changes no byte', () => {
  const once = applyHarnessRoute(SEED, route(), 32000)
  assert.equal(once.error, null)
  const twice = applyHarnessRoute(once.text, route(), 32000)
  assert.equal(twice.error, null)
  assert.equal(twice.text, once.text, 'the collapse must converge, not oscillate')
})

test('#414: a default row naming a provider with NO block is REFUSED by name — never booted', () => {
  const emptyProviders = route({ providerBlock: '      unrelated-provider:\n        apiKeyEnv: X\n' })
  const out = applyHarnessRoute(SEED, emptyProviders, 32000)
  assert.ok(out.error !== null, 'must refuse')
  assert.match(out.error, /qwen-token-plan/, 'the refusal names the provider the default row points at')
})

test('#414: a seed whose default row was deleted is restored by the route-carried row — one answer', () => {
  const noDefault = SEED.replace(/- id: agent-default-model\n(?:[^\n]*\n)*?(?=\n- id: |\Z)/, '')
  assert.equal(defaultsOf(noDefault), 0)
  const out = applyHarnessRoute(noDefault, route(), 32000)
  assert.equal(out.error, null, 'the harness route carries its own default row — a lost seed row is restored')
  assert.equal(defaultsOf(out.text), 1)
})

// ─────────────── the measured clobber: a merge step re-adds the stale row AFTER a clean alignment

test('#414 regression (measured 2026-11-17): alignment as the LAST transform converges even when a merge re-injected the local row', () => {
  const clean = applyHarnessRoute(SEED, route(), 32000)
  assert.equal(clean.error, null)
  // exactly what boot's own profile pipeline did: ensurePresetRegistryPin/applyRigPresetPin merged
  // the dev profile's rich local row back in AFTER an earlier alignment pass:
  const clobbered = clean.text + '\n' + [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: local',
    '    model: qwen3.8-flash-next',
    '    reasoningEffort: medium',
    '',
  ].join('\n')
  assert.equal(defaultsOf(clobbered), 2, 'control: the clobber really does restore the duplicate')
  const final = applyHarnessRoute(clobbered, route(), 32000)
  assert.equal(final.error, null, `the final alignment must converge: ${final.error ?? ''}`)
  assert.equal(defaultsOf(final.text), 1, 'exactly one default row in the text the host will read')
  assert.doesNotMatch(final.text, /provider: local\b/)
})
