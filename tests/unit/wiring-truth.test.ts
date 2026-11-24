/**
 * #353 — wiring that asserts what it did not do.
 *
 * Four small defects, one theme: a log line, a doc line, a dependency declaration or a health check
 * that reads as "verified" without being connected to the thing it claims. Each row here is written so
 * it would FAIL against the pre-fix state, and one of them is a general gate rather than a point fix,
 * because "a runtime import declared nowhere" is a class, not a fact about one package.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerChaptersTools } from '../../src/tools.ts'
import { makeDomainStore } from '../../src/store.ts'
import { CHAPTERS_PRESET_ID } from '../../src/preset.ts'

const cwd = process.cwd()
const read = (p: string): string => readFileSync(join(cwd, p), 'utf8')

// ───────────────────────────────────────────── the class gate: no undeclared runtime import

test('#353: every @deepseek-ai runtime import is declared in the manifest', () => {
  // `@deepseek-ai/dsh-llm` was a VALUE import in src/index.ts (BlockAssembler), src/engine.ts and
  // src/aux-message.ts (createUserMessage) while appearing ONLY in devDependencies. It resolved in
  // the field because profiles are created with `nodeLinker: hoisted` + `autoInstallPeers: false`
  // (app-boot/src/profile.ts:248-253). One linker change and the host-plane row throws at import —
  // a production failure that no test on this machine can currently see.
  const pkg = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
  const used = new Map<string, string>()
  for (const f of readdirSync(join(cwd, 'src'))) {
    if (!/\.ts$/.test(f)) continue
    const src = readFileSync(join(cwd, 'src', f), 'utf8')
    // Only VALUE imports matter: `import type { Session } from '@deepseek-ai/dsh-session'` is erased
    // at compile time and needs no runtime resolution. A first draft of this gate missed that and
    // reported three false positives (dsh-session, dsh-agent, dsh-commands) — a gate that cries wolf
    // gets disabled, which is the #362 lesson applied to my own test.
    const stmt = /(^|\n)\s*import\s+(type\s+)?[^;\n]*?from\s+['"](@deepseek-ai\/[^'"]+)['"]/g
    for (const m of src.matchAll(stmt)) {
      if (m[2] !== undefined) continue // `import type` — erased
      const spec = m[3]!
      const pkgName = spec.startsWith('@deepseek-ai/') ? spec.split('/').slice(0, 2).join('/') : spec
      if (!used.has(pkgName)) used.set(pkgName, f)
    }
  }
  const missing = [...used.entries()].filter(([name]) => !declared.has(name))
    .map(([name, file]) => `${name} (imported by src/${file})`)
  assert.deepEqual(missing, [],
    `runtime imports of packages declared nowhere but devDependencies — they resolve only by linker\n  ${missing.join('\n  ')}`)
  // Keep the gate honest: it must be looking at real traffic.
  assert.ok(used.size >= 3, `expected several @deepseek-ai imports, saw ${String(used.size)} — the scan is broken, not clean`)
  assert.ok(used.has('@deepseek-ai/dsh-llm'), 'the scan must actually see the package #353 adds')
})

// ───────────────────────────────────────────── a mount that did not happen must not be logged as one

test('#353: registerChaptersTools WARNS when the strict commands service is absent', () => {
  // cordis `ctx.get(name)` returns undefined unless the providing fiber is ACTIVE
  // (cordis 4.0.5 lib/index.js:763-769). `commands` is deliberately outside the realm row's `inject`,
  // so any mount-ordering wrinkle yielded tools-without-doors — and the row logged
  // "seven tools + three continuation doors" anyway.
  const tmp = mkdtempSync(join(tmpdir(), 'wiring-'))
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => {
    let m = tables.get(name)
    if (m === undefined) { m = new Map(); tables.set(name, m) }
    return {
      get: (k: string) => m!.get(k),
      put: async (k: string, v: unknown) => { m!.set(k, v) },
      delete: async (k: string) => { m!.delete(k) },
      entries: () => m!.entries(),
      get size() { return m!.size },
    }
  }
  const domainLike = { table, close: async () => {} }
  const warns: string[] = []
  const tools: Array<{ name?: string }> = []
  const ctx = {
    tools: { register: (def: unknown) => { tools.push(def as { name?: string }); return () => undefined } },
    // the whole point: no `commands` service in this context.
    get: (name: string) => name === 'commands' ? undefined : undefined,
    logger: { info: () => undefined, warn: (m: unknown) => { warns.push(String(m)) } },
    agents: {}, llm: undefined, sessionProjections: { stateOf: () => CHAPTERS_PRESET_ID },
  }
  try {
    const dispose = registerChaptersTools(ctx as never, makeDomainStore(domainLike as never) as never, {
      artifactStoreRoot: tmp, chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
    } as never)
    assert.ok(tools.length >= 7, `the seven tools should still mount (they did: ${String(tools.length)})`)
    const flagged = warns.filter((w) => /realm:tools:doors/.test(w))
    assert.equal(flagged.length, 1,
      `a missing commands service must produce exactly one loud warning; got: ${JSON.stringify(warns)}`)
    assert.match(flagged[0]!, /NOT mounted/, 'naming the fact, not hedging')
    assert.match(flagged[0]!, /chapters-continue|door/, 'and naming what the user loses')
    dispose()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ───────────────────────────────────────────── the rest are wiring facts, asserted where they live

test('#353: the row logs the mount it actually performed', () => {
  const row = read('src/tools-row.ts')
  // Not a bare assert on the old string: the line must be CONDITIONAL on the doors being there.
  assert.match(row, /doorsMounted \? ' \+ three continuation doors'/,
    'the mount line must branch on whether the door commands registered')
  assert.match(row, /DOOR COMMANDS NOT MOUNTED/, 'and say so explicitly when they did not')
  assert.doesNotMatch(row, /logger\?\.info\?\.\('dsh-chapters: chapters-tools row mounted — seven tools \+ three continuation doors, this realm only/,
    'the unconditional "seven tools + three doors" claim is the defect')
})

test('#353: the roster check certifies the preset this plugin registers', () => {
  const idx = read('src/index.ts')
  assert.match(idx, /reportPresetRoster\(ctx, CHAPTERS_PRESET_ID\)/,
    'the health line must key on the id we register')
  assert.doesNotMatch(idx, /reportPresetRoster\(ctx, config\.fallbackPreset\)/,
    'fallbackPreset is a CHILD-MOUNT knob; keying the roster on it let `fallbackPreset: standard` certify `standard` and print an UNHEALTHY verdict naming the wrong id')
})

test('#353: the durable chapters preset id has ONE definition site in the doors', () => {
  // registry/stores key on it; a second literal is how a rename silently unmounts door 5.
  const auto = read('src/auto-save.ts')
  assert.match(auto, /input\.header\.agentPreset !== CHAPTERS_PRESET_ID/, 'auto-save compares against the constant')
  assert.doesNotMatch(auto, /agentPreset !== 'chapters'/, 'not a hand-copied literal')
  assert.match(auto, /import \{ CHAPTERS_PRESET_ID \} from '\.\/preset\.ts'/, 'and it is actually imported')
})

test('#353: contract.md names a row module that default-exports', () => {
  // docs/contract.md:189 told the next re-anchor to mount `@fractalsynapse/dsh-chapters/tools`.
  // `lib/tools.js` has NO default export (grep: 0) while `lib/tools-row.js` has one — so a row written
  // from the governing record would abort the whole preset.
  const doc = read('docs/contract.md')
  assert.match(doc, /@fractalsynapse\/dsh-chapters\/tools-row/, 'the doc must name the module that exists')
  const toolsDist = read('lib/tools.js')
  assert.equal(/^\s*export default/m.test(toolsDist), false, 'control: lib/tools.js really has no default export')
  assert.equal(/^\s*export default/m.test(read('lib/tools-row.js')), true, 'control: lib/tools-row.js does')
})

// ───────────────────────────────────────── #398: the prompt bar's plan input is wired to a real field

test('#398: planOf folds the operative plan from the session log, not from a row field that does not exist', () => {
  const idx = read('src/index.ts')
  const block = /planOf: async \(session\) => \{[\s\S]*?\n {6}\},/.exec(idx)
  assert.ok(block !== null, 'planOf keeps this shape \u2014 update the scan and the wiring together')
  assert.match(block[0], /detectPlans\(session\.events\)/,
    'the fold must run over the session\u2019s durable events \u2014 exactly the mechanism engine.ts:815 carries into a checkpoint')
  assert.match(block[0], /carryActivePlan\(/, 'and through the ONE operative-plan renderer')
  assert.doesNotMatch(block[0], /planDocs/,
    'planDocs is a ChapterRecord field; reading it off a SessionState ROW was the dead-code defect (\u2018?.planDocs ?? []\u2019 is always empty, and even record entries carry no .text carryActivePlan needs)')
})

// ─────────────────────────────────── #406: the tape-writing modes must run the identity proof

test('#406: boot.ts gates the model-identity proof to the modes that WRITE tape', () => {
  const boot = read('tests/e2e/boot.ts')
  assert.match(boot, /const writesTape = modelMode === 'record' \|\| \(modelMode === 'replay' && process\.env\.E2E_TAPE_FALLBACK === '1'\)/,
    'the gate is exactly the two tape-writing modes — heal rides replay+fallback')
  assert.match(boot, /if \(writesTape\) \{[\s\S]{0,4200}?servedModelVerdict\(\{ listText, chatText, requested \}\)/,
    'the proof predicate runs behind the gate, on both fetched payloads')
  assert.match(boot, /refusing to \$\{modelMode === 'record' \? 'record' : 'heal'\}/,
    'a non-null verdict is a refusal that names the mode')
  // The probe fetch must be DOWNSTREAM of the gate, and there must be exactly one: plain replay and
  // live must never hit /v1/models — CI runners have no endpoint, and those modes write nothing.
  const gateIdx = boot.indexOf('if (writesTape) {')
  // #414 re-pinned: the builder is upstreamProbeUrl (the proxy-side /v1 convention); the old
  // `new URL('/v1/models', base)` shape dropped path-prefixed bases to the origin.
  const probeIdx = boot.indexOf(`fetch(upstreamProbeUrl(upstreamBase, '/v1/models')`)
  assert.ok(gateIdx >= 0 && probeIdx > gateIdx, 'the identity probe sits inside the writesTape gate')
  assert.equal(boot.split(`fetch(upstreamProbeUrl(upstreamBase, '/v1/models')`).length - 1, 1, 'exactly one models probe in the whole boot path')
})

// ─────────────────────────────── #406: the pinned rig model id has ONE source, and the guard reads it

test('#406: RIG_MODEL_ID is the single literal for the pinned model id', () => {
  const pins = read('tests/e2e/rig-pins.ts')
  assert.match(pins, /export const RIG_MODEL_ID = 'qwen3\.8-flash-next'/, 'the constant is the definition site')
  const boot = read('tests/e2e/boot.ts')
  assert.match(boot, /- id: \$\{RIG_MODEL_ID\}/, 'the provider row interpolates the constant')
  assert.doesNotMatch(boot, /- id: qwen3\.8-flash-next/, 'no raw literal survives in the YAML the boot writes')
  assert.doesNotMatch(boot, /routed\.route\.model/, 'the guard does not depend on a resolved route — harnessRoute legitimately answers null on the tracked profile')
  const gs = read('tests/e2e/globalSetup.ts')
  assert.match(gs, /local\/\$\{RIG_MODEL_ID\}/, 'the bar fixture route uses the same source')
  assert.doesNotMatch(gs, /'local\/qwen3\.8-flash-next'/, 'and carries no second literal')
  assert.match(boot, /const requested = remap !== undefined && remap !== '' \? remap : RIG_MODEL_ID/,
    'the proof requested name is the constant, unless E2E_UPSTREAM_MODEL deliberately remaps')
})

// ─────────────────────── #409: the stub-leg marker is set where the stub is pinned, and boot branches

test('#409: the scripted-stub legs carry their marker from the ONE place that pins the stub', () => {
  const distill = read('scripts/distill-tapes.sh')
  // the marker must ride the same leg_extra assignment as the stub E2E_UPSTREAM pin — a second
  // site elsewhere is exactly the drift the #56 table-deletion learned about.
  assert.match(distill, /leg_extra="\$\{leg_extra\} E2E_UPSTREAM=http:\/\/127\.0\.0\.1:\$\{STUB_PORT\} E2E_STUB_LEG=1"/,
    'stub upstream pin and stub-leg marker are one line, inside the STUB_PROJECTS branch')
  const boot = read('tests/e2e/boot.ts')
  assert.match(boot, /const stubLeg = process\.env\.E2E_STUB_LEG === '1'/, 'boot reads the marker')
  assert.match(boot, /const verdict = stubLeg\n?\s*\? stubEndpointVerdict\(\{ listText, chatText \}\)\n?\s*: servedModelVerdict\(\{ listText, chatText, requested \}\)/,
    'the witness branches on leg kind: stub-class proof for stub legs, the pinned-id proof for live legs — unchanged for #406')
})

// ─────────────────────── #411: distill's per-leg loop must be record+replay, with one bounded heal

test('#411: the distill loop classifies through the tested guard — twice, and heals at most once', () => {
  const sh = read('scripts/distill-tapes.sh')
  assert.equal((sh.match(/classifyLeg\(/g) ?? []).length, 2,
    'exactly two classifyLeg call sites: after the first strict replay, and after the single bounded heal — a third would mean a second heal loop')
  assert.equal((sh.match(/E2E_TAPE_FALLBACK=1/g) ?? []).length, 1,
    'the fallback env — the heal — appears exactly once in the loop (#411: ONE bounded pass)')
  assert.match(sh, /#411 record\+replay gate/, 'the verdict line names the gate the leg just passed')
  assert.match(sh, /write-provenance\.mjs --project "\$proj" --verdict "\$verdict"/,
    'PROVENANCE records the CLASSIFIED verdict, not the raw record exit code')
  // The real syntax gate, executed rather than pattern-matched (#386's lesson: a gate you only
  // read is a gate you have not tested).
  const r = spawnSync('bash', ['-n', join(process.cwd(), 'scripts/distill-tapes.sh')], { encoding: 'utf8' })
  assert.equal(r.status, 0, `bash -n scripts/distill-tapes.sh: ${r.stderr}`)
})

// #429: the first-pull retry is a WIRING fact — the predicate alone does not fix a starved mount.
// The two comments that promised this mechanism with no code behind it shipped a load-dependent
// flake for weeks (chain-context failures, solo passes); this pin is what makes prose and product
// the same claim, measured at every bump.
test('#429: the dock wires the first-pull retry — one predicate, one call site, loud ceiling', () => {
  const bar = readFileSync(new URL('../../src/client/prompt-bar.ts', import.meta.url), 'utf8')
  const dock = readFileSync(new URL('../../src/client/prompt-dock.ts', import.meta.url), 'utf8')
  assert.ok(bar.includes('export function firstPullRetryDue'), 'the ONE predicate lives in prompt-bar')
  const dockCode = dock.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')  // CODE-shaped: comment mentions are not call sites (the #81 guard's own discipline)
  assert.equal(dockCode.split('firstPullRetryDue(').length - 1, 1, 'called at exactly ONE site in the dock code')
  assert.ok(/import \{[^}]*firstPullRetryDue[^}]*\} from '\.\/prompt-bar\.ts'/s.test(dock), 'imported from prompt-bar — the single decision source')
  assert.ok(dock.includes('retryFirstPull'), 'the retry loop exists as code')
  assert.ok(dock.includes('.then(() => { retryFirstPull() })'), 'the retry begins only after the mount tick has had its chance — the loop never races the discovery it is retrying')
  assert.ok(dock.includes('retry ceiling'), 'giving up is LOUD (#54: a detected failure that is not delivered is the same bug)')
  assert.ok(dock.includes('clearTimeout(firstPullTimer)'), 'the retry timer is reclaimed on unmount — a dock that navigates away must not keep pulling')
})

// #497: the maintainer's per-load pile-up was the MOUNT PULL — a pull is a command/run +
// command/done pair of durable nodes (prompt-bar.ts #229 comment, measured on their live log),
// and the #194 push-mode gate could never fire at mount because pushLiveRef latched only when a
// payload ARRIVED — strictly after the mount tick had already pulled. The fix is a wiring fact:
// the latch reads the CELL (synchronous seat on first render), so push hosts pull NOTHING on
// load; and the two escape doors must stay exactly as they were.
test('#497: push-live latches from the projection CELL, before the mount tick can pull', () => {
  const dock = readFileSync(new URL('../../src/client/prompt-dock.ts', import.meta.url), 'utf8')
  const dockCode = dock.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.ok(dockCode.includes('const pushLiveRef = useRef<boolean>(pushed !== undefined)'),
    '#497: the ref initializes from the seat — a registered cell means records ride, a mount pull would restate and pay two durable nodes')
  const seatLine = dockCode.indexOf('const pushed = useProjectionHook(PROMPT_PROJECTION_KEY)')
  const latchLine = dockCode.indexOf('const pushLiveRef = useRef<boolean>(pushed !== undefined)')
  assert.ok(seatLine >= 0 && latchLine > seatLine, 'the seat read happens BEFORE the latch — first render carries the synchronous cell')
  // Door 1 (fallback honesty): no cell (pre-projection host, refused writer) ⇒ pulled !== latched ⇒
  // useRef(false)-equivalent behavior — the old pull-first mount stands. Verified by the predicate:
  assert.ok(dockCode.includes('if (pushLiveRef.current && opts?.force !== true) return'),
    'the tick gate is unchanged — non-forced ticks stop in push mode; FORCED confirms (push did NOT arrive) still pull in BOTH modes')
  // Door 2: arrival still latches (a cell that registers after first render must not need a reload).
  assert.ok(dockCode.includes('pushLiveRef.current = true'), 'the arrival latch stays — late registration also disables the clock')
})

// #497: the retry-owed gate is a WIRING fact, same doctrine as #429's own row — the predicate
// change only stops the maintainer's 11:27:06Z pair if the dock actually feeds it the two truths.
test('#497: the dock feeds the retry its debts and the projection — one sanction site, both inputs live', () => {
  const dock = readFileSync(new URL('../../src/client/prompt-dock.ts', import.meta.url), 'utf8')
  const dockCode = dock.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.equal(dockCode.split('pullOwed.current = true').length - 1, 1,
    'the sanction IS the debt, and it is set at exactly ONE site: the mount branch that calls refresh')
  assert.ok(dockCode.includes('if (pushed !== undefined) pushLiveRef.current = true'),
    'a registering cell latches push mode immediately — the retry stops the moment a channel exists, not only at first payload')
  assert.ok(dockCode.includes('owed: pullOwed.current, pushLive: pushLiveRef.current'),
    'the due-check consumes both truths')
  assert.ok(/import \{[^}]*firstPullRetryDue[^}]*\} from '\.\/prompt-bar\.ts'/s.test(dock), 'still ONE predicate, still in prompt-bar (#429 doctrine holds)')
})

// #505/#506: runtime controls that no hint or status names are config walls with extra steps.
// These rows pin the ADVERTISEMENT of both verbs to the code that implements them.
test('#505+#506: the caps and the rules model are discoverable exactly where an operator looks', () => {
  const cmds = readFileSync(new URL('../../src/commands.ts', import.meta.url), 'utf8')
  assert.match(cmds, /conflicts \| model <provider\/model \| clear>/, 'the chapters-rule hint names its model verb (#506 — it worked all along and told no one)')
  assert.match(cmds, /verb === 'rounds'/, 'the rounds verb exists as code (#505)')
  assert.match(cmds, /rounds \[n \| unlimited \| show\]/, 'the usage line lists it')
  assert.match(cmds, /`  rounds: /, 'the state block prints the LIVE cap with its source')
  const loop = readFileSync(new URL('../../src/prompt-loop.ts', import.meta.url), 'utf8')
  assert.match(loop, /cap > 0 && s\.fired >= cap/, 'unlimited is honored in the fire path, not just in the default')
  const idx = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  assert.match(idx, /maxRounds: \(\) => prompt\.roundsCap\(\)\.cap/, 'the loop reads the ONE resolver, not the config number')
})
