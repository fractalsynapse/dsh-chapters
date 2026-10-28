/**
 * The host-drift gate for preset DELIVERY.
 *
 * Presets changed mechanism at host 0.1.7-alpha.1: `$DSH_HOME/.agent-presets/<id>/` is no
 * longer read at all, and a preset is an `@deepseek-ai/dsh-agent-preset` *declaration row*.
 * The failure mode of a mechanism change nobody noticed is the interesting part — nothing
 * crashes. The plugin boots, its tools register, Settings says "enabled and running", the
 * preset is absent, and `resume` then throws `agent-preset/not-found` for every session whose
 * log recorded it. A user's chapters sessions look corrupted; their logs are intact.
 *
 * The preset ships as a row in OUR bundle patch (`cordis.patch.yml`, id `preset-chapters`) so
 * it is a visible Loader entry like the host's own `preset-standard` — and the row's plugin is
 * ours (`@treeseed/dsh-chapters/preset`), which mirrors the host's line for line and drops
 * rows this host cannot import before registering. Why the host package is not named directly,
 * and why disposal works the way it does, are recorded with their measurements in
 * `src/preset.ts`.
 *
 * So these rows guard what would otherwise make the next host rename a broken user session:
 *   1. the shipped row is well-formed, and `config.id` is `chapters` — that id is DURABLE
 *      STATE inside other people's session logs, so renaming it orphans those sessions;
 *   2. every module the composition mounts resolves against a real host install, and anything
 *      that does not is in the declared optional set (the row prunes those at boot and says
 *      so) — one unresolvable child makes the WHOLE preset `broken`;
 *   3. our list differs from the host's own standard list ONLY by the declared deltas;
 *   4. no row carries a config key some supported host REJECTS (alpha.4 throws on `toolFilter`;
 *      a refused key breaks every session, so zod-stripping was not the answer);
 *   5. every `{{variable}}` referenced is one the installed host registers — the legacy suffix
 *      interpolated `{{cwd}}`, hosts from 0.2.1-alpha.2 register only `provider`/`model`, and
 *      interpolation THROWS, so a preset that composes perfectly still breaks every turn;
 *   6. the persona suffix is still keyed to the plot-extraction echo guard, because that guard
 *      matches phrases inside the suffix and the coupling is invisible from either side;
 *   7. the registration arms (registered / pruned / already-declared / unsupported / failed)
 *      and the roster arms (present / broken / absent / unknown) classify correctly — their log
 *      lines are the only health signal a plugin can produce about a preset it does not own;
 *   8. `dsh.bundle.patch` stays a STRING, the patch file stays packed, and `./preset` stays
 *      exported: a row the manifest cannot ship, or a package that stopped exporting its row
 *      module, is a preset that vanished with no error naming the cause.
 *
 * Rows 2/3/4 run only when the host's web bundle resolves (same RUN/SKIP discipline as
 * host-seed-contract.test.ts: unmeasured must be named, not quietly green). The pinned e2e
 * host predates declaration rows and ships no `dsh-web-app` preset list, so on that closure
 * they SKIP by name — they still fire on a box or CI job carrying a 0.2.x host.
 *
 * Parsed line-wise rather than with a YAML library: none is a dependency of this tree, and a
 * structural reader is stricter than `yaml.load` — it cannot silently swallow a mis-indented
 * row. Comments are dropped first, so a gate never fires on its own documentation (it did once).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readRosterVerdict, rosterRemediation, reportPresetRoster, describeMountedRows } from '../../src/index.ts'
import {
  CHAPTERS_PRESET_ID, pruneUnresolvableRows, registerPrunedPreset, resolvableFromThisPackage,
  inventoryEntry, unusableRows,
  type PresetDefinition, type PresetRow, type PresetRegistryLike,
} from '../../src/preset.ts'
import { extractPlot } from '../../src/engine-core.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const PATCH = join(PKG_ROOT, 'cordis.patch.yml')
const PRESET_ID = 'chapters'
const ROW_ID = 'preset-chapters'
const ROW_MODULE = '@treeseed/dsh-chapters/preset'

/** Strip comments/blanks; keep indentation, which is the structure we assert on. */
function significantLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '' && !/^\s*#/.test(l))
}

/** The preset row's own lines: from its `id:` to the end of the file (it is the last layer). */
function rowLines(): string[] {
  const lines = significantLines(PATCH)
  const at = lines.findIndex((l) => l.trim() === `- id: ${ROW_ID}`)
  assert.ok(at >= 0, `the bundle patch must carry the ${ROW_ID} row — without it the preset does not exist`)
  return lines.slice(at)
}

/** Every mounted module in a set of patch lines (skips the row wrapper and cordis groups). */
function mountedNames(lines: string[]): string[] {
  const out: string[] = []
  for (const l of lines) {
    const m = /^\s*name:\s*'?([^']+)'?\s*$/.exec(l)
    if (m === null) continue
    const value = m[1]!
    if (value === '@deepseek-ai/dsh-agent-preset' || value === ROW_MODULE || value.startsWith('cordis:')) continue
    // A mounted row's `name` is an npm specifier (always lowercase, scoped or hyphenated); the
    // declaration's own display `name: Chapters` is prose, and an earlier revision of this
    // helper treated it as a package — the row then failed for the wrong reason. Subpaths MUST
    // be allowed: `…/engine`, `…/list-agents`, `…/tools` are the ones a host rename eats first.
    if (!/^(@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)(\/[a-z0-9._~+/=-]+)*$/.test(value)) continue
    if (!(value.startsWith('@') || value.includes('-'))) continue
    out.push(value)
  }
  return out
}

/** The lines of ONE plugin row, by its `id:` — from that line to the next row at the same
 *  indentation. Regex-shaped assertions on a 200-line YAML drift silently; a block either
 *  contains the key or it does not. */
function blockOf(id: string, lines = rowLines()): string[] {
  const at = lines.findIndex((l) => l.trim() === `- id: ${id}`)
  assert.ok(at >= 0, `the shipped composition has no row with id "${id}"`)
  const indent = /^\s*/.exec(lines[at]!)![0].length
  const out = [lines[at]!]
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === '' || l.trim().startsWith('#')) continue
    if ((/^\s*/.exec(l)![0].length <= indent)) break
    out.push(l)
  }
  return out
}

/**
 * Rows whose module is NOT expected to resolve on every host this package serves. Each entry
 * is a measured fact about a named host version, not a guess:
 *  - `dsh-tool-schedule`: first published at 0.2.1-alpha.1; absent from 0.2.0-rc.1/rc.2 (the
 *    installed tree and the registry both checked) and from their standard list. Mounting it
 *    anyway was measured on rc.2: `DECLARED BUT BROKEN — tool-schedule … never started`. The
 *    row prunes it there and the alpha hosts keep the schedule tools.
 * Deliberately NOT here: `dsh-time-context` (published and installed at rc.2, and in every
 * alpha standard list) and `dsh-tool-ralph` (row dropped from the alpha.2 list, package still
 * published through alpha.4).
 */
const KNOWN_OPTIONAL = new Set(['@deepseek-ai/dsh-tool-schedule'])

test('RUN — the bundle ships the preset as a visible declaration row', () => {
  const lines = significantLines(PATCH)
  const at = lines.findIndex((l) => l.trim() === `- id: ${ROW_ID}`)
  assert.ok(at > 0, `${ROW_ID} must be inserted by the bundle patch — a row nobody ships is a preset nobody has`)
  assert.equal(lines[at + 1], `      name: '${ROW_MODULE}'`,
    'the row module is ours, not @deepseek-ai/dsh-agent-preset: an unresolvable row aborts the plugin tree '
    + 'of any host predating declaration rows, while ours resolves wherever this package runs')
  const body = lines.slice(at)
  assert.ok(body.some((l) => /^\s+id: chapters$/.test(l)), 'config.id is the roster key')
  assert.ok(body.some((l) => /^\s+order: \d+$/.test(l)), 'config.order positions the preset in the menu')
  assert.ok(body.some((l) => /^\s+plugins:$/.test(l)), 'config.plugins is the mounted list')
  assert.ok(body.some((l) => l.includes(`name: '@treeseed/dsh-chapters/engine'`)),
    'without the engine realm row there is no chapter-form compaction in this preset')
  assert.ok(mountedNames(body).length > 10, 'a preset that mounts almost nothing is a typo, not a preset')
})

test('RUN — config.id is exactly "chapters", because it is durable state in other logs', () => {
  assert.equal(CHAPTERS_PRESET_ID, 'chapters')
  assert.ok(rowLines().some((l) => /^\s+id: chapters$/.test(l)),
    'this id is recorded as agent-preset/selected in every continuation child this plugin created; '
    + 'an existing session whose recorded preset cannot be resolved will not open')
})

test('RUN — the patch stays a string, packed, and the row module stays exported', () => {
  // Measured on the pinned 0.1.5-rc.1 closure: `dsh.bundle.patch` as a LIST dies at profile
  // load — `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string.
  // Received an instance of Array` (`dsh-app-boot/lib/index.js:853`, `join(packageDir,
  // declared)`); array support arrived with declaration rows in 0.1.7-alpha.1. So the row rides
  // the ONE layer we already ship, and this pins that nobody "helpfully" splits it later.
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as
    { dsh?: { bundle?: { patch?: unknown } }; exports?: Record<string, unknown>; files?: string[] }
  assert.equal(typeof manifest.dsh?.bundle?.patch, 'string',
    'a second patch layer means an array manifest, which will not boot a pre-0.1.7 host at all')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok((manifest.files ?? []).includes('cordis.patch.yml'),
    'the patch file must be packed: a bundle whose patch is absent delivers nothing, silently')
  assert.equal(manifest.exports?.['./preset'], './lib/preset.js',
    'the row names @treeseed/dsh-chapters/preset — if that subpath stops being exported the row cannot '
    + 'be imported and the preset is gone with no error naming the cause')
})

// The host's own shipped preset list, when a 0.1.7+/0.2.x web bundle is installed here.
let hostStandard: string | undefined
try {
  const req = createRequire(import.meta.url)
  hostStandard = join(dirname(req.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets', 'standard.patch.yml')
  if (!existsSync(hostStandard)) hostStandard = undefined
} catch {
  hostStandard = undefined
}

const guard = hostStandard === undefined ? 'SKIP' : 'RUN'
const skip = hostStandard === undefined ? '@deepseek-ai/dsh-web-app not installed (the pinned e2e host predates declaration rows)' : false

test(`${guard} — every module the preset mounts resolves against the installed host`, { skip }, () => {
  assert.ok(hostStandard !== undefined)
  const unresolved: string[] = []
  for (const name of mountedNames(rowLines())) {
    if (resolvableFromThisPackage(name) || KNOWN_OPTIONAL.has(name)) continue
    unresolved.push(name)
  }
  assert.deepEqual(unresolved, [],
    'a preset row whose module no longer resolves activates as failed, and one failed row makes the WHOLE '
    + 'preset broken — every session choosing it stops composing. Drop the row, or add it to KNOWN_OPTIONAL '
    + 'naming the host version that removed it (the row prunes those and says so at boot)')
  // And a declared-optional row must actually be droppable: the probe has to be asked of it.
  const { dropped } = pruneUnresolvableRows([{ id: 'x', name: '@deepseek-ai/dsh-tool-schedule' }], () => false)
  assert.deepEqual(dropped, ['x (@deepseek-ai/dsh-tool-schedule)'], 'the pruner is not reaching the row it exists for')
})

test(`${guard} — our list differs from the host standard list ONLY by the declared deltas`, { skip }, () => {
  assert.ok(hostStandard !== undefined)
  const ours = new Set(mountedNames(rowLines()))
  const theirs = new Set(mountedNames(significantLines(hostStandard)))
  // Rows a GIVEN host's standard list may or may not carry: tool-schedule is in every alpha
  // list and unpublished at rc.2; time-context likewise.
  const CROSS_VERSION = new Set([...KNOWN_OPTIONAL, '@deepseek-ai/dsh-time-context'])
  const added = [...ours].filter((n) => !theirs.has(n) && !CROSS_VERSION.has(n))
  const removed = [...theirs].filter((n) => !ours.has(n) && !CROSS_VERSION.has(n))
  assert.deepEqual(added, ['@treeseed/dsh-chapters/engine'],
    'the only row we ADD is the chapter engine; if the host renamed or dropped something else, this '
    + 'preset is mounting a package that may not exist on another supported host')
  assert.deepEqual(removed, ['@deepseek-ai/dsh-compaction-basic'],
    'the only row we REPLACE is the host LLM summarizer — everything else stays mounted, or a chapters '
    + 'session silently loses a tool the standard preset has')
  // The behavioural deltas, asserted on the EFFECTIVE lines of the shipped row.
  const body = rowLines().join('\n')
  assert.match(body, /thresholdChars: 1000000/, 'the tool-result pruner is deliberately dormant (chapters defer at archive time)')
  assert.match(body, /thresholdRatio: 0\.9/, 'the engine threshold is configured, not left to defaults')
  const ralph = blockOf('tool-ralph')
  assert.ok(ralph.some((l) => /^\s+subagentProvider: spawn$/.test(l)) && ralph.some((l) => /^\s+maxRounds: 64$/.test(l)),
    'the chapters preset runs the bounded goal loop')
  assert.ok(!ralph.some((l) => /^\s+disabled: true$/.test(l)),
    'the host standard list mounts tool-ralph DISABLED; enabling it is a declared delta of ours and must '
    + 'stay visible in this row rather than drift back silently')
  assert.match(body, /prefix: You are a coding agent powered by the \{\{model\}\} model\./,
    'the persona prefix is the host wording; dropping it changes every session silently')
})

test(`${guard} — no row carries a config key a supported host throws on`, { skip }, () => {
  // Measured on a real 0.2.1-alpha.4 boot: `tool-subagent` does NOT strip an unknown key — it
  // REJECTS the removed one, and the whole preset came back broken:
  //   `tool-subagent: toolFilter is no longer supported; configure persona and tool plugins
  //    in an Agent Preset`
  // while the same composition mounted cleanly on 0.2.0-rc.2, which still accepts the key. So a
  // key that one supported host accepts and the next one throws on is worse than dropping it —
  // and the deny list protected nothing on rc.2, where no schedule tools exist to deny.
  const refused = ['toolFilter']
  const offenders: string[] = []
  let current = ''
  for (const l of rowLines()) {
    const name = /^\s*name:\s*'?([^']+)'?\s*$/.exec(l)
    if (name !== null) current = name[1]!
    for (const key of refused) if (new RegExp(`^\\s+${key}:`).test(l)) offenders.push(`${current} carries ${key}`)
  }
  assert.deepEqual(offenders, [],
    'every config key must be accepted by EVERY host this package serves — one refused key breaks the '
    + 'whole preset. Drop the key and record the host version that refused it in src/preset.ts')
  // The plugins that REJECT unknown keys are why this class exists: pin the dormant pruner's set.
  const pruner = blockOf('tool-result-pruner')
  assert.ok(pruner.some((l) => l.includes('@deepseek-ai/dsh-compaction-tool-result-pruner')), 'wrong row picked')
  assert.deepEqual(pruner.filter((l) => /^\s+\w+: \d+$/.test(l)).map((l) => l.trim().split(':')[0]),
    ['thresholdChars', 'headChars', 'tailChars'],
    'that plugin throws on unknown config keys ("config is { ... }"), so exactly these three, no more')
})

test('RUN — the composition references only prompt variables every supported host registers', () => {
  // `provider` and `model` are what every host in range registers. `cwd` is DELIBERATELY
  // EXCLUDED: it exists through 0.2.0-rc.2 and is gone from 0.2.1-alpha.2, and an unregistered
  // reference THROWS at prompt assembly — the second failure of this same upgrade, after the
  // delivery one. `dsh-working-directory` already prints the working directory into the runtime
  // context, so `{{cwd}}` was pure duplication. EFFECTIVE lines only: this file's comments quote
  // it to explain why it is gone, and reading raw text once made the gate fire on its own docs.
  const refs = [...new Set([...rowLines().join('\n').matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map((m) => m[1]!))]
  const risky = refs.filter((r) => r !== 'model')
  assert.deepEqual(risky, [],
    `the preset references ${risky.map((r) => `{{${r}}}`).join(', ')} — at least one supported host does not `
    + 'register it and interpolation THROWS, so every turn of every chapters session on that host dies while '
    + 'the preset still looks installed')
  assert.ok(refs.includes('model'), 'the persona prefix should still carry {{model}}')
})

test(`${guard} — the installed host really does register what the composition references`, { skip: skip ?? false }, () => {
  // The drift half: read the kernel's OWN registrations rather than trusting the list above, so
  // a host that drops `model` fails here instead of in someone's session.
  const req = createRequire(import.meta.url)
  const loop = (() => { try { return req.resolve('@deepseek-ai/dsh-agent-loop') } catch { return undefined } })()
  assert.ok(loop !== undefined, 'the host loop package must resolve when this row runs')
  const registered = new Set([...readFileSync(loop, 'utf8').matchAll(/\.variable\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)].map((m) => m[1]!))
  assert.ok(registered.size >= 2, `expected provider+model at minimum, saw: ${[...registered]}`)
  const refs = [...new Set([...rowLines().join('\n').matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map((m) => m[1]!))]
  assert.deepEqual(refs.filter((r) => !registered.has(r)), [],
    `this host does not register them; prompt assembly throws, so EVERY turn in a chapters session on it `
    + `fails (registered here: ${[...registered].join(', ')})`)
})

/** The persona suffix, unquoted from the shipped row (the only quoted scalar it carries). */
function shippedSuffix(): string {
  const line = rowLines().find((l) => /^\s+suffix: "/.test(l))
  assert.ok(line !== undefined, 'the preset must carry the PLOT: suffix or plot carriage has nothing to carry')
  const first = line.indexOf('"')
  const last = line.lastIndexOf('"')
  assert.ok(last > first, `malformed suffix line: ${line}`)
  return line.slice(first + 1, last)
}

test('RUN — the suffix we ship is still recognised as a template echo by plot extraction', () => {
  // src/engine-core.ts's PLOT_TEMPLATE_ECHO suppresses a "plot" that is really our own
  // instruction quoted back (the 2026-09-25 audit: all eight checkpoints of a real run
  // inherited boilerplate, and because the result was non-null the bounded elicited fallback
  // never ran). That suppression is keyed to phrases inside the suffix, so rewording the
  // suffix can silently un-key it. Pin the coupling by BEHAVIOUR, not by copying the regex.
  const suffix = shippedSuffix()
  const echo = { role: 'assistant', content: [{ type: 'text', text: `PLOT: ${suffix}` }] }
  assert.equal(extractPlot([echo] as unknown as Parameters<typeof extractPlot>[0]), null,
    'the shipped suffix is no longer matched by PLOT_TEMPLATE_ECHO — reword the guard in src/engine-core.ts '
    + 'in the SAME change as the suffix, or every session inherits its own instruction as a plot')
  // Positive control: the row must not pass because extraction broke entirely.
  const real = { role: 'assistant', content: [{ type: 'text', text: 'PLOT: rebuild the preset delivery; next: run the drift gate' }] }
  assert.ok((extractPlot([real] as unknown as Parameters<typeof extractPlot>[0]) ?? '').includes('rebuild the preset delivery'),
    'plot extraction itself has stopped working, so the assertion above proves nothing')
})

test('RUN — the pruner drops an unresolvable row instead of mounting a broken preset', () => {
  const rows: PresetRow[] = [
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'gone', name: '@deepseek-ai/dsh-gone' },
    { id: 'planning', name: 'cordis:group', group: true, config: [
      { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' },
      { id: 'also-gone', name: '@deepseek-ai/dsh-also-gone' },
    ] },
    { id: 'empty-group', name: 'cordis:group', group: true, config: [{ id: 'only', name: '@deepseek-ai/dsh-only' }] },
  ]
  const { kept, dropped } = pruneUnresolvableRows(rows, (spec) => !spec.includes('gone') && !spec.includes('only'))
  assert.deepEqual(kept.map((r) => r.id), ['tool-fs', 'planning'], 'unresolvable rows go; a group keeps its good children')
  assert.deepEqual((kept[1]?.config as PresetRow[]).map((r) => r.id), ['plan-mode'], 'the dropped child is gone from the group')
  assert.deepEqual(dropped, [
    'gone (@deepseek-ai/dsh-gone)',
    'also-gone (@deepseek-ai/dsh-also-gone)',
    'only (@deepseek-ai/dsh-only)',
    'empty-group (group emptied)',
  ], 'every drop is named — a silent drop is how a preset loses a tool nobody notices')
  // cordis: pseudo-names and our own realm row are never probed: pruning the engine row would
  // silently delete the feature the preset exists to provide.
  const none = pruneUnresolvableRows([{ id: 'engine', name: '@treeseed/dsh-chapters/engine' }], () => false)
  assert.deepEqual(none.dropped, [], 'the chapters engine row must never be prunable')
})

test('RUN — registerPrunedPreset classifies every outcome and never throws at the row', async () => {
  const definition: PresetDefinition = { id: PRESET_ID, name: 'Chapters', description: 'x', order: 0, plugins: [
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'gone', name: '@deepseek-ai/dsh-gone' },
  ] }
  // A host with no register() — the pre-0.1.7 closure — is not a failure, it is the floor: the
  // row says so and the chapters tools stay working.
  assert.equal((await registerPrunedPreset({}, definition, () => true)).outcome.state, 'unsupported')
  assert.equal((await registerPrunedPreset(undefined, definition, () => true)).outcome.state, 'unsupported')

  let received: PresetDefinition | undefined
  const disposers: Array<() => Promise<void>> = []
  const registry = {
    register: async (d: PresetDefinition) => {
      received = d
      const dispose = async () => {}
      disposers.push(dispose)
      return dispose
    },
  } as unknown as PresetRegistryLike
  const ok = await registerPrunedPreset(registry, definition, (spec) => !spec.includes('gone'))
  assert.equal(ok.outcome.state, 'pruned', 'the dropped row is reported, never silently omitted')
  assert.ok(ok.outcome.state === 'pruned' && ok.outcome.dropped[0] === 'gone (@deepseek-ai/dsh-gone)')
  assert.equal(received?.id, 'chapters', 'the definition is what the host registers')
  assert.deepEqual((received?.plugins ?? []).map((r) => r.id), ['tool-fs'], 'the pruned row must not reach the host')
  // The disposer's lifetime is the entire point of making this a row: yielding it from
  // [Service.init] hands it to Cordis, while ctx.effect from apply() disposed of the
  // registration at activation end (measured: register() succeeded, roster WITHOUT chapters).
  assert.equal(ok.disposer, disposers[0], 'the disposer must reach the caller that yields it to Cordis')

  // A duplicate is someone else's row winning, not our failure — and it must not propagate: a
  // row whose init throws leaves the preset declared by neither, and takes its own log line with it.
  const dupe = { register: async () => { throw new Error('Duplicate agent preset: chapters') } } as unknown as PresetRegistryLike
  assert.equal((await registerPrunedPreset(dupe, definition, () => true)).outcome.state, 'already-declared')

  const boom = { register: async () => { throw new Error('Preset services require isolate realms: compaction') } } as unknown as PresetRegistryLike
  const failed = await registerPrunedPreset(boom, definition, () => true)
  assert.equal(failed.outcome.state, 'failed')
  assert.match(failed.outcome.state === 'failed' ? failed.outcome.reason : '', /isolate realms/,
    'the host reason must survive — this line is the only diagnosis of a refused mount')

  const thrown = { register: async () => { throw 'registry refused' } } as unknown as PresetRegistryLike
  const odd = await registerPrunedPreset(thrown, definition, () => true)
  assert.equal(odd.outcome.state, 'failed', 'a thrown non-Error is an outcome, not a crash through the row')
  assert.match(odd.outcome.state === 'failed' ? odd.outcome.reason : '', /registry refused/)
})

test('RUN — the roster verdict is the health signal (absent is not silently fine)', async () => {
  const absent = await readRosterVerdict({ list: async () => ({ presets: [{ id: 'standard', isDefault: true }] }) }, PRESET_ID)
  assert.equal(absent.state, 'absent')
  assert.deepEqual(absent.rows, ['standard'])

  // both historical shapes of list() must be understood: the envelope and the bare array
  const bare = await readRosterVerdict({ list: async () => [{ id: PRESET_ID }] }, PRESET_ID)
  assert.equal(bare.state, 'present')
  assert.ok(bare.state === 'present' && bare.broken === undefined, 'a declared, unbroken preset is healthy')

  const broken = await readRosterVerdict({ list: async () => [{ id: PRESET_ID, broken: 'mount failed: X' }] }, PRESET_ID)
  assert.ok(broken.state === 'present' && broken.broken === 'mount failed: X',
    'declared-but-broken must be reported apart from absent — the remedy differs')

  assert.equal((await readRosterVerdict(undefined, PRESET_ID)).state, 'unknown')
  assert.equal((await readRosterVerdict({ list: async () => { throw new Error('loader not settled') } }, PRESET_ID)).state, 'unknown')

  // The inventory answers the question the roster cannot: are the ROWS active?
  const inventory = [{ id: PRESET_ID, rows: [
    { entryId: 'chapters:tool-fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: true, fiberState: 'active' },
    { entryId: 'chapters:bad', moduleName: '@deepseek-ai/dsh-bad', enabled: true, fiberState: 'failed' },
    { entryId: 'chapters:off', moduleName: '@deepseek-ai/dsh-off', enabled: false, fiberState: 'failed' },
  ] }]
  const entry = inventoryEntry(inventory, PRESET_ID)
  assert.ok(entry !== undefined)
  assert.deepEqual(unusableRows(entry), ['chapters:bad (@deepseek-ai/dsh-bad) failed'],
    'a disabled row that failed is not a problem; an enabled one that never activated is')
  assert.deepEqual(unusableRows(inventoryEntry(inventory, 'nope')), [], 'an absent preset has no rows to judge')
  assert.equal(inventoryEntry(undefined, PRESET_ID), undefined, 'a host without the method must not throw here')
})

test('RUN — the roster line says the true thing for every verdict, in the loud channel when it is bad', async () => {
  // The mount line cannot answer "will a chapters session open" — only the roster can, and a
  // warn nobody reads is how the silent case survived. So: info when healthy, warn AND stderr
  // for every other arm, with the roster's own ids in the absent case.
  const mk = (raw: unknown) => {
    const lines: { info: string[]; warn: string[] } = { info: [], warn: [] }
    const ctx = {
      get: (name: string) => (name === 'agentPresets' ? { list: async () => raw } : undefined),
      logger: { info: (m: string) => { lines.info.push(m) }, warn: (m: string) => { lines.warn.push(m) } },
    }
    return { ctx, lines }
  }
  const realError = console.error
  const loud: string[] = []
  console.error = (m?: unknown) => { loud.push(String(m)) }
  try {
    const healthy = mk([{ id: PRESET_ID }])
    assert.equal((await reportPresetRoster(healthy.ctx as never, PRESET_ID)).state, 'present')
    assert.deepEqual(healthy.lines.warn, [], 'a healthy roster must not warn')
    assert.match(healthy.lines.info.join(''), /is in the host roster/)

    const broken = mk([{ id: PRESET_ID, broken: 'tool-x: never started' }])
    assert.equal((await reportPresetRoster(broken.ctx as never, PRESET_ID)).state, 'present')
    assert.match(broken.lines.warn.join(''), /DECLARED BUT BROKEN/)
    assert.match(broken.lines.warn.join(''), /tool-x: never started/, "the host's own reason must be quoted, not paraphrased")

    const absent = mk([{ id: 'standard' }])
    assert.equal((await reportPresetRoster(absent.ctx as never, PRESET_ID)).state, 'absent')
    assert.match(absent.lines.warn.join(''), /UNHEALTHY/)
    assert.match(absent.lines.warn.join(''), /roster: standard/, 'the other ids are the evidence a human needs')
    assert.match(absent.lines.warn.join(''), /agent-preset\/not-found/, 'the consequence must be named, not implied')
    assert.match(absent.lines.warn.join(''), /preset-chapters/, 'and the remedy must point at the row that carries it')
  } finally {
    console.error = realError
  }
  assert.ok(loud.some((m) => /DECLARED BUT BROKEN/.test(m)) && loud.some((m) => /UNHEALTHY/.test(m)),
    'a warn-only health line is what made the original incident hours-long')
})

test('RUN — the verification line says whether the ROWS are active, not just that the preset is declared', async () => {
  // "declared" and "usable" are different facts, and the operator reads one line. A row can
  // resolve and never start, and the roster alone cannot see it.
  const rows = (extra: Record<string, unknown> = {}) => [{
    id: PRESET_ID, rows: [
      { entryId: 'chapters:tool-fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: true, fiberState: 'active' },
      { entryId: 'chapters:gone', moduleName: '@deepseek-ai/dsh-gone', enabled: true, fiberState: 'failed' },
      extra,
    ],
  }]
  assert.match(await describeMountedRows({ compositionInventory: async () => rows() } as never, PRESET_ID),
    /1 of 3 rows NOT active/)
  assert.match(await describeMountedRows({ compositionInventory: async () => [{ id: PRESET_ID, rows: [{ enabled: true, fiberState: 'active', entryId: 'a' }] }] } as never, PRESET_ID),
    /1 mounted rows all active/, 'the healthy case must read as healthy')
  assert.match(await describeMountedRows({} as never, PRESET_ID), /rows not reported by this host/,
    'an older host without the inventory method degrades the line, never the check')
  assert.match(await describeMountedRows({ compositionInventory: async () => { throw new Error('not settled') } } as never, PRESET_ID),
    /rows unreadable/, 'a throwing inventory degrades the line too — this runs at boot')
})

test('RUN — resolvableFromThisPackage answers without throwing, both ways', () => {
  // Asked with packages THIS manifest depends on, so the row passes on a CI runner that has no
  // harness installed — an assertion about a developer's machine was the mistake the first
  // 0.1.17 release run caught.
  assert.equal(resolvableFromThisPackage('isomorphic-git'), true, 'a declared dependency must resolve')
  assert.equal(resolvableFromThisPackage('@deepseek-ai/schemastery'), true, 'a declared peer must resolve')
  assert.equal(resolvableFromThisPackage('@treeseed/dsh-chapters-not-a-package'), false,
    'a missing package must be a false answer, never a thrown error — this runs while mounting')
  assert.equal(resolvableFromThisPackage('@deepseek-ai/schemastery/definitely-not-an-export'), false,
    'a package that exists but no longer exports the subpath a row names must be a NO — that is the '
    + 'rename this probe exists for, and mounted anyway it makes the whole preset broken')
  assert.equal(resolvableFromThisPackage('./nonsense-relative'), true,
    'a RELATIVE name is answered as resolvable: Node resolves the URL without touching the filesystem. '
    + 'The composition uses package specifiers only — if that ever changes, this probe proves nothing '
    + 'for those rows and the roster line becomes the only evidence.')
})

test('RUN — the remediation names the row that carries the preset', () => {
  const text = rosterRemediation(PRESET_ID)
  assert.match(text, /preset-chapters/, 'the remedy points at a Loader row a human can look at')
  assert.match(text, /cordis\.patch\.yml/, 'and at the file that ships it')
  assert.match(text, /0\.2\.0 support floor/, 'and says when the row legitimately cannot exist')
})

test('RUN — the preset persona tells every chapters session how to find rules and history (#52)', () => {
  // A brand-new session and a DELEGATED subagent get no continuation notice, so the
  // only sanctioned per-composition instruction channel is this preset's persona
  // suffix — the same mechanism that already carries the PLOT: discipline. It is
  // per-preset, not the process-global system prompt, so invariant 3 is not engaged.
  const text = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8')
  const block = text.split('- id: preset-chapters')[1] ?? ''
  const persona = block.split('- id: agent-instructions')[0] ?? ''
  assert.match(persona, /dsh-persona/, 'the row that carries the guidance is the persona row')
  assert.match(persona, /chapters_rules/, 'a chapters session must be TOLD the rules door exists — an unmentioned tool does not exist to a small model')
  assert.match(persona, /chapters_search/, 'and the history door, for the same reason')
  assert.match(persona, /subagent|delegat/i, 'the guidance names delegation, because that is the session shape with no notice')
  // variables: hosts from 0.2.1-alpha.2 register only provider/model. An unregistered
  // variable throws at prompt assembly and kills EVERY turn of every chapters session.
  const vars = [...persona.matchAll(/\{\{\s*([a-zA-Z_][\w:]*)\s*\}\}/g)].map((m) => m[1]!)
  assert.deepEqual(vars.filter((v) => v !== 'model'), [],
    `persona variables outside { model } throw at assembly: ${vars.join(', ')}`)
  assert.match(persona, /PLOT:/, 'the plot discipline still ships in the same suffix — do not replace it')
})

/**
 * The realm must BOUND the base engine's pressure headroom, and the schema must let it through (#140).
 *
 * `dsh-compaction-basic@0.2.0-rc.2` computes `contextWindow − reservedCompletionTokens − headroomTokens` per routed
 * target and throws when that is ≤ 0; its default headroom is 65,536, so a 32K model — the hardware this plugin is
 * written for — gets NO relief, only an exception. Our engine overrides `summarize()` and makes no routed call, so
 * that reservation is not ours to pay in full. This row keeps the two halves from drifting apart again: the realm row
 * must carry a bounded `headroomTokens`, and `ChaptersCompactionEngine.Config` must declare it, because a key the
 * schema drops never reaches `super.resolveConfig` and the failure reappears silently at the next host bump.
 */
test('the realm bounds the pressure headroom and the engine schema carries it (#140)', () => {
  const body = readFileSync(PATCH, 'utf8')
  assert.match(body, /headroomTokens: \d+/, 'the engine row must bound headroomTokens, not inherit 65,536')

  const engine = readFileSync(join(PKG_ROOT, 'src', 'engine.ts'), 'utf8')
  const schema = engine.slice(engine.indexOf('static override Config = z.object({'), engine.indexOf('modelPolicies'))
  assert.match(schema, /headroomTokens:\s*z\.number\(\)/,
    'Config must declare headroomTokens or the Loader drops it before the base sees it')

  const policy = engine.slice(engine.indexOf('modelPolicies: z.array(z.object({'))
  assert.match(policy.slice(0, 1200), /headroomTokens:\s*z\.number\(\)/,
    'per-model policies must carry it too — a narrow child schema strips what super would honour')
})
