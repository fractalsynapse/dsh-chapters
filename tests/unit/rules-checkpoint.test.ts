/**
 * #50 §7.6 / verify.md R1 — THE row this whole round exists for.
 *
 * `planSummarize` used to compose `leadSections = [planSection, plotSection]`:
 * a plan survived an in-place compaction, a plot survived it, and a RULE did
 * not. These rows drive the REAL realm engine through `summarize()` and read the
 * checkpoint text that would actually be prefilled into the next request — not a
 * mock of it. Same fake-cordis harness posture as engine-lifecycle.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ChaptersCompactionEngine } from '../../src/engine.ts'
import { makeDomainStore } from '../../src/store.ts'
import { DEFAULT_CLONE_DIR } from '../../src/sync.ts'
import { renderRuleFile, appendRuleStatusFact } from '../../src/rules.ts'

type Ev = { seq: number; type: string; data: Record<string, unknown> }
const ev = (seq: number, type: string, data: Record<string, unknown> = {}): Ev => ({ seq, type, data })
const human = (seq: number, text: string): Ev =>
  ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
const asst = (seq: number, text: string): Ev =>
  ev(seq, 'assistant/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })

const EVENTS: Ev[] = [
  human(0, 'fix the sync loop copy-out bug in src/sync.ts'),
  asst(1, 'edited src/sync.ts and ran npm test'),
  human(2, 'verify the two-machine row passes too'),
  asst(3, 'npm test green, 333 pass'),
  ev(4, 'turn/end', {}),
  ev(5, 'compaction/start', { compactionId: 'c-1' }),
]

function harness(config: Record<string, unknown> = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-ckpt-'))
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => {
    let m = tables.get(name)
    if (m === undefined) { m = new Map(); tables.set(name, m) }
    return {
      get: (k: string) => m!.get(k),
      put: async (k: string, v: unknown) => { m!.set(k, v) },
      entries: () => m!.entries(),
      get size() { return m!.size },
    }
  }
  const domainLike = { table, close: async () => {} }
  const ctx = new Context() as unknown as Record<string, unknown> & {
    provide: (n: string, v: unknown) => unknown
  }
  ctx.provide('storageDomain', { open: async () => domainLike, get: () => domainLike })
  ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 12 }), estimateMessage: (m: unknown) => Math.ceil(JSON.stringify(m).length / 4) })
  ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 32_000 } }) })
  ctx.provide('sessions', {})
  ctx.provide('registry', {})
  const engine = new ChaptersCompactionEngine(ctx as never, {
    thresholdRatio: 0.9, retainRatio: 0.15, maxTokens: 900, compactionRetries: 1, maxOverflowRetries: 0,
    auto: false, artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 4000,
    harnessId: 'hA', elicitedPlot: false, plansInCheckpoint: true,
    ...config,
  } as never)
  const store = makeDomainStore(domainLike as never)
  const sessionOf = (id: string, events: Ev[]) => ({
    id,
    get seq() { return events.length },
    eventAt: (seq: number) => events.find((e) => e.seq === seq),
    snapshotEvents: () => events,
    surface: { nodes: events.map((e) => e.seq) },
    append: (type: string, data: unknown) => { const e = { seq: events.length, type: String(type), data: data as Record<string, unknown> }; events.push(e); return e },
    deriveEventMessage: (e: { type: string; data?: Record<string, unknown> }) =>
      (e.data?.content !== undefined ? { role: e.type === 'assistant/message' ? 'assistant' : 'user', content: e.data.content } : null),
    header: { cwd },
  })
  const summarize = async (session: unknown): Promise<string> => {
    const r = await (engine as unknown as {
      summarize: (i: unknown, a: unknown) => Promise<{ summary: { text: string }[] }>
    }).summarize({
      messages: EVENTS.slice(0, 4).map((e) => ({
        role: e.type === 'assistant/message' ? 'assistant' : 'user',
        content: (e.data.content as unknown[]) ?? [],
      })),
    }, { session })
    return r.summary[0]!.text
  }
  return {
    cwd, store, table, sessionOf, summarize,
    dispose: () => { try { (ctx.fiber as { dispose?: () => unknown } | undefined)?.dispose?.() } catch { /* best-effort */ } fs.rmSync(cwd, { recursive: true, force: true }) },
  }
}

/** an approved PROJECT rule in the pool mirror + a SESSION rule in the store */
function seedRules(cwd: string): void {
  const mirror = path.join(cwd, DEFAULT_CLONE_DIR)
  const mdir = path.join(mirror, 'rules', 'PK1', 'hA')
  fs.mkdirSync(mdir, { recursive: true })
  fs.writeFileSync(path.join(mdir, '001-security.md'), renderRuleFile({
    number: 1, category: 'security', title: 'No raw tokens', sourceSession: 'p', at: '2026-10-01',
    body: 'Never log raw tokens or bearer headers.\n',
  }))
  appendRuleStatusFact(mirror, 'hA', { rule: 'hA/001', status: 'core', at: 't' })
  const sdir = path.join(cwd, '.dsh-chapters', 'rules', 'hA')
  fs.mkdirSync(sdir, { recursive: true })
  fs.writeFileSync(path.join(sdir, '002-general.md'), renderRuleFile({
    number: 2, category: 'general', title: 'Run the tape', sourceSession: 's-ckpt', at: '2026-10-20',
    body: 'Run the tape replay before cutting a tag.\n', scope: 'session', session: 's-ckpt', derivedFrom: 'marker',
  }))
}

test('R1 the checkpoint carries the project rule AND the session rule, verbatim, in precedence order', async () => {
  const h = harness()
  try {
    seedRules(h.cwd)
    await h.table('projects').put('PK1', {
      projectKey: 'PK1', slug: 'kb', remote: 'https://github.com/o/r', harnessId: 'hA', linkedAt: 'now', cwd: h.cwd,
    })
    const text = await h.summarize(h.sessionOf('s-ckpt', EVENTS))
    assert.match(text, /## CORE RULES \(approved for this project — follow them\)/, text.slice(0, 500))
    assert.ok(text.includes('Never log raw tokens or bearer headers.'), 'the project rule survived the compaction')
    assert.match(text, /## SESSION RULES \(captured this session — they refine the project rules above; they never override them\)/)
    assert.ok(text.includes('Run the tape replay before cutting a tag.'), 'the session rule survived the compaction')
    assert.ok(text.indexOf('Never log raw tokens') < text.indexOf('Run the tape replay'), 'precedence is positional as well as stated (§7.7)')
  } finally { h.dispose() }
})

test('R1b a rule inherited from the ancestor path rides the child\u2019s checkpoint too', async () => {
  const h = harness()
  try {
    const mirror = path.join(h.cwd, DEFAULT_CLONE_DIR)
    const sdir = path.join(h.cwd, '.dsh-chapters', 'rules', 'hA')
    fs.mkdirSync(sdir, { recursive: true })
    fs.writeFileSync(path.join(sdir, '003-general.md'), renderRuleFile({
      number: 3, category: 'general', title: 'Parent order', sourceSession: 's-parent', at: '2026-10-19',
      body: 'Always merge staging into the feature branch first.', scope: 'session', session: 's-parent', derivedFrom: 'marker',
    }))
    // link s-ckpt2 under s-parent, the way chapters_continue does
    await h.store.put('s-parent', await (async () => {
      const st = await h.store.get('s-parent')
      return st
    })())
    await h.store.put('s-ckpt2', {
      ...(await h.store.get('s-ckpt2')), parentSession: 's-parent', rootSession: 's-parent',
    })
    const text = await h.summarize(h.sessionOf('s-ckpt2', EVENTS))
    assert.ok(text.includes('Always merge staging into the feature branch first.'),
      'the ancestor walk is what makes the tier permanent for the TREE, not one session (§7.5)')
  } finally { h.dispose() }
})

test('R7 with no rules at all the checkpoint carries zero rule bytes', async () => {
  const h = harness()
  try {
    const text = await h.summarize(h.sessionOf('s-empty', EVENTS))
    assert.ok(!text.includes('CORE RULES'), text.slice(0, 300))
    assert.ok(!text.includes('SESSION RULES'), 'an empty tier renders NOTHING — the committed tapes depend on this')
    assert.ok(!text.includes('Rules NOT carried'), 'and no announcement when there was nothing to announce')
  } finally { h.dispose() }
})

test('§7.3 over budget the checkpoint ANNOUNCES the omission instead of clipping', async () => {
  const h = harness({ coreRulesBudgetTokens: 8 })
  try {
    seedRules(h.cwd)
    const text = await h.summarize(h.sessionOf('s-ckpt', EVENTS))
    assert.match(text, /Rules NOT carried into this checkpoint/, text.slice(0, 500))
    assert.ok(!text.includes('Never log raw tokens or bearer headers.'), 'nothing was squeezed in silently')
    assert.match(text, /never clips/)
  } finally { h.dispose() }
})
