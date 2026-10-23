/**
 * The rig's realm pin (#56/#77) — the config that decides whether the acceptance chain tests the
 * product at all.
 *
 * Tonight's nine red legs were not nine bugs: the profile pinned the preset under a row id the
 * pinned host no longer mounts, so every boot ran `standard` — no chapters persona, no
 * ChaptersCompactionEngine, no arrival-time artifacting, zero `compaction/*` events across 15
 * session logs, and `dsh_chapters.json` never created because the realm's turn/end signature
 * listener was the first writer. The rows here keep that from being re-discovered by archaeology:
 * the pin must reach the REALM row, every collected `Pins` field must map to something, and a
 * retired row id must fail as a row, not as an evening.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderPinnedPreset, applyRigPresetPin, ensurePresetRegistryPin, realmPinsOf, type RealmPin } from '../../tests/e2e/rig-preset-pin.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SHIPPED = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')

const realmKeys = (out: string): string[] => {
  const i = out.indexOf('- id: chapters-engine')
  const seg = out.slice(i, i + 1400)
  return [...seg.matchAll(/^\s{14}([a-zA-Z]+):/gm)].map((m) => m[1]!)
}

test('the REAL shipped bundle patch still declares the preset as a row we can pin', () => {
  // If this ever throws, the pin mechanism is dead and the chain is silently un-pinned again.
  const out = renderPinnedPreset(SHIPPED, { thresholdRatio: '0.75', artifactStoreRoot: '/tmp/store-41731' })
  assert.match(out, /^- id: preset-chapters/, 'rendered at PROFILE level (no leading indent)')
  assert.ok(!out.includes('\n    - id: preset-chapters'), 'the shipped 4-space indent must be dedented')
  assert.match(out, /name: '@treeseed\/dsh-chapters\/preset'/, 'the row keeps its module — a config-only row would not register')
  assert.match(out, /- id: chapters-engine/, 'the realm engine row survives the copy')
  assert.match(out, /- id: persona/, 'and so does the rest of the preset — a partial row would delete the plugins')
  assert.match(out, /thresholdRatio: 0\.75/, 'the pin lands')
  assert.match(out, /artifactStoreRoot: '\/tmp\/store-41731'/, 'including the per-port store root')
})

test('every realm pin the rig collects lands on the engine row', () => {
  const pins: RealmPin = {
    thresholdRatio: '0.5',
    artifactStoreRoot: '/tmp/store-41733',
    toolResultArtifactTokens: '1000000',
    enrichmentEnabled: true,
    noAuxModel: true,
  }
  const out = renderPinnedPreset(SHIPPED, pins)
  const keys = realmKeys(out)
  for (const k of ['thresholdRatio', 'artifactStoreRoot', 'toolResultArtifactTokens', 'enrichmentEnabled', 'auto', 'elicitedPlot']) {
    assert.ok(keys.includes(k), `the engine row must carry ${k}; got ${keys.join(', ')}`)
  }
  assert.match(out, /auto: false/, 'a no-aux boot is genuinely no-aux (these are REAL realm keys, src/engine.ts)')
  assert.match(out, /elicitedPlot: false/)
  assert.equal((out.match(/^ {14}auto: false$/gm) ?? []).length, 1, 'exactly once — no duplicate key for the host to arbitrate')
})

test('noAuxModel absent leaves auto and elicitedPlot alone — the rig must not invent a default', () => {
  const out = renderPinnedPreset(SHIPPED, { thresholdRatio: '0.9' })
  const keys = realmKeys(out)
  assert.ok(!keys.includes('auto'), `auto must stay unset when the pin is off, got: ${keys.join(', ')}`)
  assert.ok(!keys.includes('elicitedPlot'))
})

test('a bundle patch without the preset row fails LOUDLY instead of booting un-pinned', () => {
  // the exact silence that cost the chain: a pin that matched nothing was not an error
  assert.throws(
    () => renderPinnedPreset('- id: something-else\n  config:\n    x: 1\n', { thresholdRatio: '0.5' }),
    /no "- id: preset-chapters" row found/,
  )
})

test('applying the pin twice replaces rather than stacks — two rows for one id is merge roulette', () => {
  const profile = fs.readFileSync(path.join(ROOT, 'dev', 'profile-cordis.patch.yml'), 'utf8')
  const once = applyRigPresetPin(profile, SHIPPED, { thresholdRatio: '0.75', artifactStoreRoot: '/tmp/s1' })
  const twice = applyRigPresetPin(once, SHIPPED, { thresholdRatio: '0.5', artifactStoreRoot: '/tmp/s2' })
  assert.equal((twice.match(/^- id: preset-chapters/gm) ?? []).length, 1, 'one row per id, always')
  assert.match(twice, /thresholdRatio: 0\.5/, 'and the later pin wins visibly')
  assert.ok(!twice.includes('/tmp/s1'), 'the stale store root must be gone, not shadowed')
})

test('realmPinsOf maps EVERY field the rig collects — no field may go inert again', () => {
  const all = { thresholdRatio: '0.5', noAuxModel: true, enrichment: true, toolResultArtifactTokens: '1000000', promptModel: 'local/x' }
  const r = realmPinsOf(all, '/tmp/store')
  assert.deepEqual(r, {
    thresholdRatio: '0.5',
    artifactStoreRoot: '/tmp/store',
    toolResultArtifactTokens: '1000000',
    enrichmentEnabled: true,
    noAuxModel: true,
  })
  // the anti-inert guard: every declared Pins field must be accounted for, by name, here
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'boot.ts'), 'utf8')
  const iface = /export interface Pins \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? ''
  const fields = [...iface.matchAll(/^\s{2}\??([a-zA-Z]+)\??:/gm)].map((m) => m[1]!)
  assert.ok(fields.length >= 4, `expected the Pins fields to be readable, got: ${fields.join(', ')}`)
  // compare field NAMES against the mapper's source, not against output keys: the mapper
  // legitimately renames (`enrichment` → `enrichmentEnabled`), and an equality check on the
  // result would demand the wrong thing. What must hold is that every field is READ.
  const mapper = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'rig-preset-pin.ts'), 'utf8')
  const body = /export function realmPinsOf[\s\S]*?\n}/.exec(mapper)?.[0] ?? ''
  assert.ok(body.length > 0, 'realmPinsOf must exist for this guard to mean anything')
  // a field may be pinned on either PLANE — realm rows via this mapper, host rows by
  // `applyRigPluginPatch` — but it must be read by one of them. "Collected and applied nowhere"
  // is the bug, not "mapped by this particular function".
  const bootPatch = /export function applyRigPluginPatch[\s\S]*?\n}/.exec(src)?.[0] ?? ''
  const bootCall = src.includes('applyRigPresetPin') || src.includes('realmPinsOf')
  assert.ok(bootCall, 'bootE2eServer must actually CALL the realm pin (collecting pins without applying them is the bug that bit us tonight)')
  for (const f of fields) {
    const read = new RegExp(`pins\\.${f}\\b`).test(body) || new RegExp(`pins\\.${f}\\b`).test(bootPatch) || new RegExp(`pins\\.${f}\\b`).test(src)
    assert.ok(read, `Pins.${f} is collected by globalSetup but read by neither the realm mapper nor the host patcher — the inert-pin bug (#56) returns`)
  }
})

test('the dev profile pins the preset registry under the id the 0.2.x host actually mounts', () => {
  const patch = fs.readFileSync(path.join(ROOT, 'dev', 'profile-cordis.patch.yml'), 'utf8')
  // measured drift (both diagnosis agents, same conclusion): `agent-presets` survives only as a
  // CLIENT UI section id; the registry row is `agent-preset-registry`, and its Config is
  // `{default, selectedDefault}` with defaultId = selectedDefault ?? default
  // (dsh-agent-preset-registry/lib/index.js:470-474, 493-494).
  assert.match(patch, /^- id: agent-preset-registry$/m, 'the row id the pinned host mounts')
  assert.match(patch, /selectedDefault: chapters/, 'and the key that actually selects it for a new session')
  assert.doesNotMatch(patch, /^- id: agent-presets$/m,
    'the retired id must not come back: an unmatched row merges into nothing and boots silently un-pinned')
})

/**
 * The per-boot registry guarantee. The corrected row id in `dev/profile-cordis.patch.yml` looked
 * like a fix and was not one: boots copy `.dshdev-local`, last bootstrapped Oct 16, which still
 * carried `- id: agent-presets`. Same trap as the copied plugin tree (#54), same answer: pin it
 * in the boot's own patch and delete the inert row, every time.
 */
test('the retired agent-presets row is removed and the real registry row takes its place', () => {
  const dev = fs.readFileSync(path.join(ROOT, 'dev', 'profile-cordis.patch.yml'), 'utf8')
  const home = `- id: llm-pi-ai\n  config:\n    providers: {}\n- id: agent-presets\n  config:\n    default: chapters\n- id: llm-gate\n  config:\n    x: 1\n`
  const out = ensurePresetRegistryPin(home, dev)
  assert.doesNotMatch(out, /^- id: agent-presets$/m, 'an unmatched row is not a pin, it is a rumor of one')
  assert.match(out, /^- id: agent-preset-registry$/m, 'the row the pinned host actually mounts')
  assert.match(out, /selectedDefault: chapters/, 'with the key that selects the preset for a new session')
  assert.match(out, /- id: llm-pi-ai/, 'and nothing else in the home is touched')
  assert.match(out, /- id: llm-gate/)
})

test('the guarantee is idempotent — applied twice, one registry row and no duplicate keys', () => {
  const dev = fs.readFileSync(path.join(ROOT, 'dev', 'profile-cordis.patch.yml'), 'utf8')
  const home = `- id: agent-presets\n  config:\n    default: chapters\n`
  const twice = ensurePresetRegistryPin(ensurePresetRegistryPin(home, dev), dev)
  assert.equal((twice.match(/^- id: agent-preset-registry$/gm) ?? []).length, 1, 'exactly one registry row')
  assert.equal((twice.match(/selectedDefault: chapters/g) ?? []).length, 1)
})

test('a dev profile without the registry row fails loudly instead of booting un-pinned', () => {
  assert.throws(
    () => ensurePresetRegistryPin('- id: agent-presets\n  config:\n    default: chapters\n', '- id: llm-pi-ai\n  config:\n    x: 1\n'),
    /carries no `agent-preset-registry` row/,
  )
})

/**
 * #85 functional half: the pin must actually reach the row the engine reads. A per-port store root
 * was pinned since #61, but the POOL MIRROR stayed a workspace constant, so `heavy`'s recorded
 * compaction notice carried a `## CORE RULES` block from this repo's own development rules and the
 * replayed notice carried none — the two texts agreed to character 346 and diverged there. A tape is
 * a claim about one world; reading the developer's repo is a second world nobody recorded.
 */
test('a booted realm row carries knowledgeMirrorDir, and reruns replace rather than duplicate it', () => {
  const profile = SHIPPED
  const once = applyRigPresetPin(profile, SHIPPED, realmPinsOf({ thresholdRatio: '0.5' }, '/tmp/home/chapters', '/tmp/home/knowledge'))
  const twice = applyRigPresetPin(once, SHIPPED, realmPinsOf({ thresholdRatio: '0.5' }, '/tmp/home2/chapters', '/tmp/home2/knowledge'))
  assert.match(once, /knowledgeMirrorDir: '\/tmp\/home\/knowledge'/, 'the first write lands on the realm row')
  assert.match(twice, /knowledgeMirrorDir: '\/tmp\/home2\/knowledge'/, 'a rerun replaces the value')
  const count = (twice.match(/knowledgeMirrorDir:/g) ?? []).length
  assert.equal(count, 1, `exactly one mirror key per row, saw ${String(count)}`)
  assert.equal(realmPinsOf({ thresholdRatio: '0.5' }, '/tmp/x/chapters').knowledgeMirrorDir, undefined,
    'no mirror root passed means no key written — a real install keeps its default')
})
