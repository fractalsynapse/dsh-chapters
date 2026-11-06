/**
 * The requirement, end to end: a session in an ordinary workspace — nothing linked,
 * no mirror, no GPU — asks a question and gets an answer that names the kind and
 * opens at a real path. This is the path a `chapters_search` result takes through the
 * actual tool wrapper (not the pure function), because the wrapper is where the
 * "no knowledge mirror yet" answer used to be born.
 *
 * The notice rows belong here too: findability has two halves — the index being able
 * to answer, and the child being TOLD the verbs exist. A tool that is installed and
 * never mentioned is a tool a small model will not reach for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildChaptersTools } from '../../src/tools.ts'
import { makeDomainStore } from '../../src/store.ts'
import { assembleNotice } from '../../src/continue-core.ts'

const world = (): { tmp: string; built: ReturnType<typeof buildChaptersTools>; cwd: string } => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'find-no-pool-'))
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string): unknown => {
    let m = tables.get(name)
    if (m === undefined) { m = new Map(); tables.set(name, m) }
    return { get: (k: string) => m!.get(k), put: async (k: string, v: unknown) => { m!.set(k, v) }, entries: () => m!.entries() }
  }
  const store = makeDomainStore({ table: table as never, close: async () => {} })
  const ctx = {
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 131072 } }) },
    agents: { create: async () => ({ followup: (_m?: unknown) => {}, dispose: async () => {} }) },
    get: () => undefined,
    sessionProjections: { stateOf: () => 'chapters' },
    logger: { info: () => {}, warn: () => {} },
  } as never
  const built = buildChaptersTools(ctx, store, {
    artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
    continuationBudgetRatio: 0.25, fallbackPreset: 'chapters', mergeThreshold: 0.3, chapterLimit: 8000,
  } as never)
  return { tmp, built, cwd: tmp }
}

const seedStore = (tmp: string): void => {
  const chapters = path.join(tmp, '.dsh-chapters', 'sess-9', 'chapters')
  fs.mkdirSync(chapters, { recursive: true })
  fs.writeFileSync(path.join(chapters, '001-renderer.md'), [
    '---', 'title: "Wire the renderer"', 'topics: ["render", "chapter"]', 'summary: "how bodies are written"', '---', '',
    '**Assistant:** Bodies are written from the log.', '',
  ].join('\n'))
  fs.writeFileSync(path.join(chapters, 'plan-001-carriage.md'), [
    '---', 'kind: plan', 'title: "Carry the plan"', 'status: approved', 'topics: ["carriage", "notice"]', '---', '',
    '# Carry the plan', '', 'Put the operative plan into the continuation notice.', '',
  ].join('\n'))
  const rules = path.join(tmp, '.dsh-chapters', 'rules', 'h-1')
  fs.mkdirSync(rules, { recursive: true })
  fs.writeFileSync(path.join(rules, '001-meter.md'), [
    '---', 'kind: rule', 'title: "Never exempt the meter"', 'category: policy', '---', '',
    'Plan blocks count against the budget.', '',
  ].join('\n'))
}

test('with no pool linked, a real search call still answers — and says which door it used', async () => {
  const w = world()
  fs.mkdirSync(path.join(w.tmp, 'var'), { recursive: true })
  // The tool resolves the workspace from the caller's session header, like everything else.
  const caller = { session: { id: 'sess-9', header: { cwd: w.tmp } }, agentId: 'a' } as never
  seedStore(w.tmp)
  assert.equal(fs.existsSync(path.join(w.tmp, '.dsh-knowledge')), false, 'this workspace has NO mirror — that is the case under test')
  const out = await w.built.chaptersSearch.execute({ query: 'carry the operative plan into the notice', maxTokens: 800 } as never, { agent: caller } as never)
  const text = typeof out === 'string' ? out : JSON.stringify(out)
  const parsed = JSON.parse(text) as { results: Array<{ kind: string; path: string }>; note?: string }
  assert.ok(parsed.results.length > 0, `the unlinked workspace answered: ${text.slice(0, 200)}`)
  assert.equal(parsed.results[0]!.kind, 'plan', 'the plan document, labelled as a plan')
  assert.match(parsed.note ?? '', /no pool mirror/, 'and it is honest that this is this machine only')
  assert.ok(fs.existsSync(path.join(w.tmp, parsed.results[0]!.path.replace(/^\.dsh-chapters\//, '.dsh-chapters/'))) ||
    fs.existsSync(path.join(w.tmp, '.dsh-chapters', parsed.results[0]!.path)), 'the cited path opens')
  const rules = await w.built.chaptersSearch.execute({ query: 'exempt the meter budget', maxTokens: 800 } as never, { agent: caller } as never)
  assert.match(JSON.stringify(rules), /"kind":"rule"/, 'curated rules answer locally too')
  fs.rmSync(w.tmp, { recursive: true, force: true })
})

test('an empty workspace says there is nothing here, not that nothing matched', async () => {
  const w = world()
  const caller = { session: { id: 'sess-empty', header: { cwd: w.tmp } }, agentId: 'a' } as never
  const out = await w.built.chaptersSearch.execute({ query: 'anything at all', maxTokens: 400 } as never, { agent: caller } as never)
  assert.match(JSON.stringify(out), /nothing archived in this workspace yet/)
  fs.rmSync(w.tmp, { recursive: true, force: true })
})

const baseNotice = {
  title: 'T', entries: [{ number: 1, title: 'A', summary: 's', path: '.dsh-chapters/r/chapters/001-a.md', status: 'ok' as const }],
  handoffNote: 'note', rootSession: 'r', parentSession: 'r', storeRoot: '.dsh-chapters',
}

test('the notice names the lookup verbs, so a child is told they exist', () => {
  const n = assembleNotice({ ...baseNotice, retrievalHints: true })
  assert.match(n, /^## Finding things$/m, 'a section a session can scan for')
  assert.match(n, /read tool/, 'chapters open with read')
  assert.match(n, /chapters_artifact/, 'deferred blobs with chapters_artifact')
  assert.match(n, /chapters_search/, 'everything else with chapters_search')
  assert.match(n, /kind: plan/, 'and it says PLANS are searchable as plans — the fact a child cannot infer')
  assert.match(n, /curated rules/, 'rules too, which arrive from other machines entirely')
})

test('the hint is additive: switch it off and the notice is what it always was', () => {
  const off = assembleNotice({ ...baseNotice, retrievalHints: false })
  assert.equal(off.includes('Finding things'), false)
  assert.equal(off.includes('chapters_search'), false)
  assert.match(off, /## Chapters/, 'the archive itself is unaffected')
  assert.match(off, /Ancestry: root r/, 'and the tail is untouched')
})
