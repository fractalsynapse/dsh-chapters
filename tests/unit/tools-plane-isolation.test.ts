/**
 * #330 — the tools' plane. Acceptance A1/A2 at the deterministic layer:
 *
 *  - the realm row (`src/tools-row.ts`), through its REAL construction (AGENTS: changes
 *    to host wiring exercise the default real construction and observe the assembled
 *    entry point), mounts exactly the seven `chapters_*` tools + the three continuation
 *    doors, and yields a disposer that unregisters all of them;
 *  - the host plane registers none of them: `apply()` calls only
 *    `registerChaptersRepairRestore`, whose two operator doors are commands (human
 *    reach), never tool registrations (agent attention);
 *  - a realm without the storage facility mounts NOTHING and says so (a tool whose every
 *    call throws is worse than an absent one).
 *
 * The cross-preset claim this defends (host-plane tool registration rides every
 * preset's request) is the #319 measurement; the live half of A1/A2 (what a REAL
 * standard/chapters session composes) belongs to the e2e plane — see the tripwire note
 * on the issue.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import ChaptersToolsRow from '../../src/tools-row.ts'
import { registerChaptersRepairRestore } from '../../src/tools.ts'
import { makeDomainStore } from '../../src/store.ts'

const TOOL_NAMES = [
  'chapters_segment', 'chapters_continue', 'chapters_fork', 'chapters_search',
  'chapters_artifact', 'chapters_rule_propose', 'chapters_rules',
] as const
const DOOR_NAMES = ['chapters-fork', 'chapters-continue', 'chapters-save'] as const
const OPERATOR_NAMES = ['chapters-repair', 'chapters-restore'] as const

interface World {
  // The WORLD IS the ctx the row receives (a returned `ctx` nobody passed around is how
  // the first draft recorded into arrays the row never saw). Recorded definitions live
  // under `registered*` so the service keys (`tools`, `get`) stay intact on the same object.
  tmp: string
  store: ReturnType<typeof makeDomainStore>
  registeredTools: Array<{ name?: string }>
  registeredCommands: Array<{ name?: string }>
  disposers: number[]
  warns: string[]
  agents: { create: (o: Record<string, unknown>) => Promise<never> }
  tools: { register(def: unknown): () => void }
  llm?: { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<undefined> }
  sessionProjections: { stateOf(): string }
  get(name: string): unknown
  logger: { info(m: string): void; warn(m: string): void }
  dispose: () => void
}

function world(opts: { storageDomain?: boolean } = { storageDomain: true }): World {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsrow-'))
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
  const registeredTools: Array<{ name?: string }> = []
  const registeredCommands: Array<{ name?: string }> = []
  const disposers: number[] = []
  const warns: string[] = []
  return {
    tmp,
    store: makeDomainStore(domainLike as never),
    agents: { create: async () => { throw new Error('not in this test') } },
    tools: { register: (def: unknown) => { registeredTools.push(def as { name?: string }); return () => { disposers.push(1) } } },
    llm: { resolveModelInfo: async () => undefined },
    sessionProjections: { stateOf: () => 'chapters' },
    get: (name: string) => {
      if (name === 'storageDomain' && opts.storageDomain === true) {
        return { open: async () => domainLike, get: () => domainLike }
      }
      if (name === 'commands') {
        return { register: (def: unknown) => { registeredCommands.push(def as { name?: string }); return () => { disposers.push(1) } } }
      }
      return undefined
    },
    logger: { info: () => undefined, warn: (m: unknown) => { warns.push(String(m)) } },
    registeredTools, registeredCommands, disposers, warns,
    dispose: () => fs.rmSync(tmp, { recursive: true, force: true }),
  }
}

/** The loader hands the class its validated row config; `Config` defaults stand in for
 *  the shipped YAML (a row mounting `{}` must still see every documented default). */
function rowConfig(): never {
  const shape = (ChaptersToolsRow as unknown as { Config: { parse?: (v: unknown) => unknown } }).Config
  const parsed = typeof shape?.parse === 'function' ? shape.parse({}) : undefined
  if (parsed !== undefined && typeof parsed === 'object' && 'artifactStoreRoot' in (parsed as object)) {
    return parsed as never
  }
  // Schema surface moved — fall back to the declared defaults VERBATIM, so a silent
  // default change is a failing row below, not an accidental pass.
  return {
    artifactStoreRoot: '.dsh-chapters', knowledgeRemote: '', knowledgeProvider: 'auto', projectKeyOverride: '',
    syncDebounceMs: 30000, vocabApply: false, vocabCoMin: 3, vocabOverlapMin: 0.5, harnessId: 'hTest',
    chapterTokenTarget: 8000, chapterLimit: 8000, chapterOversizeFactor: 2, mergeThreshold: 0.3,
    toolResultDeferFloorTokens: 200, continuationBudgetRatio: 0.25, fallbackPreset: 'chapters',
    warningsDisplayCap: 6, segmentCandidateCapTokens: 4000, repairReportMaxLines: 60, planInlineChars: 900,
    callArgArtifactTokens: 0, plansInNotice: true, retrievalHints: true, planSeedMode: true,
    searchMaxTokens: 400, coreRulesBudgetTokens: 1200, rulesCoreBonus: 0.15,
    projectRulesDisplayCap: 12, sessionRulesDisplayCap: 12, rulesRelevance: true,
  } as never
}

test('#330 the chapters-tools row mounts the seven tools and the three continuation doors', async () => {
  const w = world()
  try {
    const row = new (ChaptersToolsRow as unknown as new (ctx: never, config: never) => { [Service.init]: () => AsyncGenerator<() => void> })(w as never, rowConfig())
    const gen = row[Service.init]()
    const first = await gen.next()
    assert.equal(first.done, false, 'the init generator must yield the disposer, not finish')
    assert.deepEqual(w.registeredTools.map((t) => t.name).sort(), [...TOOL_NAMES].sort(),
      'the row registers EXACTLY the seven chapters tools — one more is a new surface, one fewer is a silent drop')
    assert.deepEqual(w.registeredCommands.map((c) => c.name).sort(), [...DOOR_NAMES].sort(),
      'the row registers EXACTLY the three continuation doors; repair/restore belong to the host plane (#330)')
    // The operator doors must NOT be registered from this row — that split is the point.
    for (const name of OPERATOR_NAMES) {
      assert.ok(!w.registeredCommands.some((c) => c.name === name), `${name} is host-plane operator reach, not realm surface`)
    }
    // Cordis disposes what [Service.init] yielded when the mount ends — drive the same
    // path here: the yielded value IS the all-registrations disposer.
    const end = await gen.next()
    assert.equal(end.done, true)
    const dispose = first.value
    assert.equal(typeof dispose, 'function')
    dispose()
    assert.equal(w.disposers.length, TOOL_NAMES.length + DOOR_NAMES.length,
      `every registration kept its disposer (saw ${String(w.disposers.length)}) — a lost disposer is an unregister that half-loads`)
  } finally { w.dispose() }
})

test('#330 a realm without the storage facility mounts nothing and says so LOUD', async () => {
  const w = world({ storageDomain: false })
  try {
    const row = new (ChaptersToolsRow as unknown as new (ctx: never, config: never) => { [Service.init]: () => AsyncGenerator<() => void> })(w as never, rowConfig())
    const gen = row[Service.init]()
    const first = await gen.next()
    assert.equal(first.done, true, 'no store ⇒ no mount, no disposer, no half-registered tool')
    assert.equal(w.registeredTools.length, 0)
    assert.equal(w.registeredCommands.length, 0)
    assert.ok(w.warns.some((m) => /storageDomain service absent/.test(m)),
      'the refusal is delivered (warn), not silence — AGENTS: a detected failure is a delivered failure')
  } finally { w.dispose() }
})

test('#330 the host plane keeps ONLY the operator doors — no tool registrations in apply()', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'index.ts'), 'utf8')
  assert.ok(!/registerChaptersTools\s*\(/.test(src),
    'src/index.ts must not call registerChaptersTools — a host-plane tool rides every preset\'s request (#319 measurement, #330 fix)')
  assert.match(src, /registerChaptersRepairRestore\(/,
    'the host plane registers the repair/restore doors (operator reach into a broken archive stays available from any session)')
  const row = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'tools-row.ts'), 'utf8')
  assert.match(row, /registerChaptersTools\(/,
    'and the tools are mounted from the realm row — the call moved, it did not vanish')
})

test('#330 registerChaptersRepairRestore registers the two operator commands and zero tools', () => {
  const w = world()
  try {
    const dispose = registerChaptersRepairRestore(w as never, w.store, rowConfig() as never)
    assert.deepEqual(w.registeredTools, [], 'operator registration never touches the tool plane')
    assert.deepEqual(w.registeredCommands.map((c) => c.name).sort(), [...OPERATOR_NAMES].sort())
    dispose()
    assert.equal(w.disposers.length, 2)
  } finally { w.dispose() }
})
