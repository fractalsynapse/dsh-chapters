/**
 * #50 §7.6 + §7.9 — the door asymmetry, the one-builder guard, and the assembly
 * door the notice tells a child to reach for.
 *
 * R2 is the claim under test: `chapters_continue` carries the project tier AND
 * this session tree's rules; `chapters_fork` carries the project tier and ZERO
 * session bytes. That difference is exactly the `intent` axis plans already use,
 * so it must come from ONE renderer — and a row here fails if either door ever
 * starts building rules on its own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderRulesBlock } from '../../src/session-rules.ts'
import { renderRuleFile, appendRuleStatusFact } from '../../src/rules.ts'
import { assembleNotice } from '../../src/continue-core.ts'
import { buildChaptersTools } from '../../src/tools.ts'
import type { RuleRecord } from '../../src/rules.ts'

const PROJECT_BODY = 'Never log raw tokens or bearer headers.'
const SESSION_BODY = 'Run the tape replay before cutting a tag.'
const PARENT_SESSION_BODY = 'Merge staging into the feature branch before opening a PR.'

function fixture(opts: { parentOfMe: boolean } = { parentOfMe: true }): { mirrorDir: string; storeDir: string; cwd: string; dispose: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rulesdoors-'))
  const mirrorDir = path.join(cwd, '.dsh-knowledge')
  const storeDir = path.join(cwd, '.dsh-chapters')
  const mdir = path.join(mirrorDir, 'rules', 'PKD', 'hD')
  fs.mkdirSync(mdir, { recursive: true })
  fs.writeFileSync(path.join(mdir, '001-security.md'), renderRuleFile({
    number: 1, category: 'security', title: 'No raw tokens', sourceSession: 'p', at: '2026-10-01', body: `${PROJECT_BODY}\n`,
  }))
  appendRuleStatusFact(mirrorDir, 'hD', { rule: 'hD/001', status: 'core', at: 't' })
  const sdir = path.join(storeDir, 'rules', 'hD')
  fs.mkdirSync(sdir, { recursive: true })
  fs.writeFileSync(path.join(sdir, '002-general.md'), renderRuleFile({
    number: 2, category: 'general', title: 'Run the tape', sourceSession: 'sess-d', at: '2026-10-20',
    body: `${SESSION_BODY}\n`, scope: 'session', session: 'sess-d', derivedFrom: 'marker',
  }))
  if (opts.parentOfMe) {
    fs.writeFileSync(path.join(sdir, '003-general.md'), renderRuleFile({
      number: 3, category: 'workflow', title: 'Sync first', sourceSession: 'sess-parent', at: '2026-10-19',
      body: `${PARENT_SESSION_BODY}\n`, scope: 'session', session: 'sess-parent', derivedFrom: 'marker',
    }))
  }
  return { cwd, mirrorDir, storeDir, dispose: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

/** the ancestry the doors see: sess-d's parent is sess-parent (§7.5 walk) */
const storeLike = {
  get: async (id: string) => ({ parentSession: id === 'sess-d' ? 'sess-parent' : null, collections: [] }),
}

const base = {
  projectKey: 'PKD', harnessId: 'hD', budgetTokens: 1200, relevance: false,
}

test('R2 the shared renderer: continue ⇒ both tiers, branch ⇒ project tier and zero session bytes', async () => {
  const f = fixture()
  try {
    const cont = await renderRulesBlock({
      ...base, mirrorDir: f.mirrorDir, storeDir: f.storeDir, includeSession: true, store: storeLike, sessionId: 'sess-d',
    })
    assert.ok(cont.kind === 'ok', JSON.stringify(cont))
    assert.ok(cont.text.includes(PROJECT_BODY) && cont.text.includes(SESSION_BODY), cont.text)
    assert.ok(cont.text.includes(PARENT_SESSION_BODY), 'inherited from the tree — permanent for the session TREE (§7.5)')

    const branch = await renderRulesBlock({
      ...base, mirrorDir: f.mirrorDir, storeDir: f.storeDir, includeSession: false, store: storeLike, sessionId: 'sess-d',
    })
    assert.ok(branch.kind === 'ok', JSON.stringify(branch))
    assert.ok(branch.text.includes(PROJECT_BODY), 'a branch still inherits the team\u2019s orders')
    assert.ok(!branch.text.includes('SESSION RULES'), `a branch must get ZERO session bytes, got:\n${branch.text}`)
    assert.equal(branch.shown.session, 0)
  } finally { f.dispose() }
})

test('R2 a session rule the tree never owned is invisible to both doors', async () => {
  const f = fixture({ parentOfMe: false })
  try {
    const r = await renderRulesBlock({
      ...base, mirrorDir: f.mirrorDir, storeDir: f.storeDir, includeSession: true, store: storeLike, sessionId: 'sess-d',
    })
    assert.ok(r.kind === 'ok')
    assert.ok(r.text.includes(SESSION_BODY) && !r.text.includes(PARENT_SESSION_BODY))
  } finally { f.dispose() }
})

test('§7.9 the assembly door answers with the text, per-tier counts and an honest withheld note', async () => {
  const f = fixture()
  try {
    const project = { projectKey: 'PKD', slug: 's', remote: 'x', harnessId: 'hD', linkedAt: 'l', cwd: f.cwd }
    const rules = new Map<string, RuleRecord>()
    const store = {
      get: async (id: string) => ({ parentSession: id === 'sess-d' ? 'sess-parent' : null, rootSession: 'r', collections: [], chapters: [], reservations: {}, plans: {}, finalized: {}, nextChapterNumber: 1, nextPlanNumber: 1 }),
      put: async () => {},
      projects: () => [[project.projectKey, project]] as Iterable<[string, typeof project]>,
      sessions: () => [].entries(),
      getSetting: () => undefined, putSetting: async () => {},
      rules: () => rules.entries(), getRule: (id: string) => rules.get(id),
      putRule: async (id: string, v: RuleRecord) => { rules.set(id, v) },
    }
    const ctx = { get: () => undefined, sessionProjections: { stateOf: () => undefined }, logger: { warn: () => {} } }
    const config = {
      artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
      continuationBudgetRatio: 0.25, fallbackPreset: 'chapters', harnessId: 'hD', coreRulesBudgetTokens: 1200,
      projectRulesDisplayCap: 1, sessionRulesDisplayCap: 1,
      scheduler: { schedule: () => {}, run: async () => ({}), pullFor: async () => ({ ok: true, detail: '' }), hasPending: () => false, drain: async () => {} },
    }
    const built = buildChaptersTools(ctx as never, store as never, config as never)
    const caller = { id: 'sess-d', session: { id: 'sess-d', header: { cwd: f.cwd }, snapshotEvents: () => [] } }
    const r = await built.chaptersRules.execute({ query: 'cutting a release tag after the tape replay' }, { agent: caller } as never) as {
      ok: boolean; text?: string; note?: string; error?: string; shown?: { project: number; session: number }; withheld?: { project: number; session: number }
    }
    assert.equal(r.ok, true, r.error)
    assert.ok(r.text !== undefined && r.text.includes(PROJECT_BODY), JSON.stringify(r))
    // caps of 1/1 with three active rules ⇒ something withheld, and it is ANNOUNCED
    assert.ok((r.withheld?.project ?? 0) + (r.withheld?.session ?? 0) > 0, 'the count is in the answer')
    assert.match(r.note ?? '', /withheld/, r.note)
    // scope=project is the branch view
    const p = await built.chaptersRules.execute({ query: 'anything', scope: 'project' }, { agent: caller } as never) as { text?: string }
    assert.ok(!(p.text ?? '').includes('SESSION RULES'), 'scope=project shows what a branch inherits')
  } finally { f.dispose() }
})

test('§7.8 the assembly door distinguishes "nothing applies" from "nothing is reachable"', async () => {
  const f = fixture()
  try {
    const store = {
      get: async () => ({ parentSession: null, collections: [] }),
      put: async () => {},
      projects: () => [] as Iterable<[string, never]>,
      sessions: () => [].entries(),
      getSetting: () => undefined, putSetting: async () => {},
      rules: () => new Map<string, RuleRecord>().entries(), getRule: () => undefined, putRule: async () => {},
    }
    const ctx = { get: () => undefined, sessionProjections: { stateOf: () => undefined }, logger: { warn: () => () => {} } }
    const config = {
      artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
      continuationBudgetRatio: 0.25, fallbackPreset: 'chapters', harnessId: 'hD', coreRulesBudgetTokens: 1200,
      scheduler: { schedule: () => {}, run: async () => ({}), pullFor: async () => ({ ok: true, detail: '' }), hasPending: () => false, drain: async () => {} },
    }
    const built = buildChaptersTools(ctx as never, store as never, config as never)
    const caller = { id: 'sess-x', session: { id: 'sess-x', header: { cwd: '/nonexistent-checkout' }, snapshotEvents: () => [] } }
    const r = await built.chaptersRules.execute({ query: 'does nothing matter here' }, { agent: caller } as never) as { ok: boolean; note?: string; text?: string }
    assert.equal(r.ok, true)
    assert.equal(r.text, '', 'zero bytes, not zero-and-silent')
    assert.match(r.note ?? '', /no knowledge project resolves/, 'unlinked says so (§7.8)')
  } finally { f.dispose() }
})

test('§7.9 the child is TOLD to query rules before a task (notice, not persona)', () => {
  const text = assembleNotice({
    title: 'T', handoffNote: 'note', entries: [{ number: 1, title: 'one', path: 'p.md', summary: 's' }],
    rootSession: 'r', parentSession: 'r', storeRoot: '.dsh-chapters', retrievalHints: true,
  })
  assert.match(text, /Before starting a task: chapters_rules/, text.slice(-800))
  const off = assembleNotice({
    title: 'T', handoffNote: 'note', entries: [{ number: 1, title: 'one', path: 'p.md', summary: 's' }],
    rootSession: 'r', parentSession: 'r', storeRoot: '.dsh-chapters', retrievalHints: false,
  })
  assert.ok(!off.includes('chapters_rules'), 'retrievalHints off ⇒ byte-identical to the previous shape')
})

test('one builder: neither the doors nor the checkpoint calls buildRulesSection directly', () => {
  // the same argument that keeps `search.rankEntries` single-scorer and `doors.ts`
  // single-runner — two implementations of rule selection drift apart silently,
  // and the drift is invisible: the head just shows different text.
  for (const file of ['src/tools.ts', 'src/engine.ts']) {
    const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    assert.ok(src.includes('renderRulesBlock'), `${file} must render rules through the shared block builder`)
    assert.ok(!/buildRulesSection\s*\(/.test(src), `${file} calls buildRulesSection directly — two selection paths`)
  }
})
