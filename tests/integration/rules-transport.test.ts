/**
 * P3 S1: rule files + curation facts travel the SAME transport as chapters,
 * over a real bare pool — and the commit gate change is pinned: a sync whose
 * only change is an appended rule-status fact (copied === 0) MUST commit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSync, DEFAULT_CLONE_DIR, type ProjectRecord } from '../../src/sync.ts'
import { renderRuleFile, appendRuleStatusFact } from '../../src/rules.ts'
import { searchKnowledge } from '../../src/search.ts'

const proj = (cwd: string, remote: string, h: string): ProjectRecord => ({
  projectKey: 'PKR', slug: 'r', remote, harnessId: h, linkedAt: 'x', cwd,
})

test('rules publish; fact-only passes commit; B sees the rule in the mirror and in search', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rulestr-'))
  const pool = path.join(root, 'pool.git')
  const a = path.join(root, 'machine-a')
  const b = path.join(root, 'machine-b')
  const ruleRel = path.join('.dsh-chapters', 'rules', 'hA', '001-security-no-token-logging.md')
  fs.mkdirSync(path.dirname(path.join(a, ruleRel)), { recursive: true })
  fs.writeFileSync(path.join(a, ruleRel), renderRuleFile({
    number: 1, category: 'security', title: 'No token logging', sourceSession: 'sA',
    at: '2026-09-20T00:00:00Z', body: 'Never log raw tokens or bearer headers.\n',
  }))
  const r1 = await runSync({ cwd: a, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: proj(a, pool, 'hA'), force: true })
  assert.ok(r1.ok, r1.detail)
  assert.ok(fs.existsSync(path.join(pool, 'HEAD')))

  // fact written AFTER the first push: the next pass copies NOTHING but must commit
  appendRuleStatusFact(path.join(a, DEFAULT_CLONE_DIR), 'hA', { rule: 'hA/001', status: 'core', at: 't' })
  const r2 = await runSync({ cwd: a, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: proj(a, pool, 'hA'), force: true })
  assert.ok(r2.ok, r2.detail)
  assert.ok((r2.steps ?? []).some((x) => x.startsWith('published 0') && true) , r2.steps?.join(' / '))
  const steps2 = (r2.steps ?? []).join(' / ')
  assert.ok(/committed \d+ path/.test(steps2), `fact-only pass must commit, steps: ${steps2}`)

  // B clones the pool and finds both artifacts
  fs.mkdirSync(b)
  const rb = await runSync({ cwd: b, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: proj(b, pool, 'hB'), force: true })
  assert.ok(rb.ok, rb.detail)
  const cloneB = path.join(b, DEFAULT_CLONE_DIR)
  assert.ok(fs.existsSync(path.join(cloneB, 'rules', 'PKR', 'hA', '001-security-no-token-logging.md')), 'rule file crossed the pool')
  assert.ok(fs.existsSync(path.join(cloneB, 'edits', 'hA', 'curation.jsonl')), 'fact crossed the pool')
  // index picked it up as kind:rule
  const hits = searchKnowledge(cloneB, 'bearer token logging', 600, { projectKey: 'PKR' })
  assert.ok(hits.results.some((h) => h.kind === 'rule'), JSON.stringify(hits.results.map((h) => [h.kind, h.title])))
  // a THIRD machine sees the rule file but NO core status (hA facts are hA's)
  const c = path.join(root, 'machine-c'); fs.mkdirSync(c)
  const rc = await runSync({ cwd: c, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: proj(c, pool, 'hC'), force: true })
  assert.ok(rc.ok, rc.detail)
  const { buildRulesSection } = await import('../../src/rules.ts')
  const secC = buildRulesSection(path.join(c, DEFAULT_CLONE_DIR), { projectKey: 'PKR', harnessId: 'hC', budgetTokens: 1200 })
  assert.ok(secC.kind === 'ok' && !secC.text.includes('CORE RULES'), 'machine C: category index yes, core no')
  const secA = buildRulesSection(path.join(a, DEFAULT_CLONE_DIR), { projectKey: 'PKR', harnessId: 'hA', budgetTokens: 1200 })
  assert.ok(secA.kind === 'ok' && secA.text.includes('Never log raw tokens'), 'machine A: its own approval is effective')
  fs.rmSync(root, { recursive: true, force: true })
})

// -------------------------------------- #50 §7.5: the session tier never crosses transport
//
// The exclusion is a ONE-POINT decision (`planStoreToRepo`), so it gets proven
// where transport is real: a git pool here, and the TreeDX provider below, the
// two backends the record's exit criterion demands. Exclusion must not mean
// invisibility either: machine A still renders its own session rule locally.

const sessionFileBody = (n: number, scope: 'project' | 'session', session: string): string => renderRuleFile({
  number: n, category: scope === 'session' ? 'testing' : 'security', title: `Rule ${n}`,
  sourceSession: session, at: '2026-10-20T00:00:00Z',
  body: `Rule body number ${n} with enough length to pass the minimum.\n`,
  ...(scope === 'session' ? { scope, session, derivedFrom: 'marker' as const } : {}),
})

test('§7.5 git pool: the session rule is authored, rendered locally, and never staged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-session-'))
  const pool = path.join(root, 'pool.git')
  const a = path.join(root, 'machine-a')
  const b = path.join(root, 'machine-b')
  const rel = (n: number, cat: string): string => path.join('.dsh-chapters', 'rules', 'hA', `${String(n).padStart(3, '0')}-${cat}-rule-${n}.md`)
  fs.mkdirSync(path.dirname(path.join(a, rel(1, 'security'))), { recursive: true })
  fs.writeFileSync(path.join(a, rel(1, 'security')), sessionFileBody(1, 'project', 'sess-me'))
  fs.writeFileSync(path.join(a, rel(2, 'testing')), sessionFileBody(2, 'session', 'sess-me'))

  const ra = await runSync({ cwd: a, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: proj(a, pool, 'hA'), force: true })
  assert.ok(ra.ok, ra.detail)
  const cloneA = path.join(a, DEFAULT_CLONE_DIR)
  assert.ok(fs.existsSync(path.join(cloneA, 'rules', 'PKR', 'hA', '001-security-rule-1.md')), 'the project tier staged as always')
  assert.ok(!fs.existsSync(path.join(cloneA, 'rules', 'PKR', 'hA', '002-testing-rule-2.md')), 'the session tier was NOT staged')
  assert.ok(fs.existsSync(path.join(a, rel(2, 'testing'))), '…but its bytes stay in the store (never deleted — write-once)')

  // machine B pulls the pool: the session rule is nowhere in its mirror
  fs.mkdirSync(b)
  const rb = await runSync({ cwd: b, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project: proj(b, pool, 'hB'), force: true })
  assert.ok(rb.ok, rb.detail)
  const cloneB = path.join(b, DEFAULT_CLONE_DIR)
  assert.ok(fs.existsSync(path.join(cloneB, 'rules', 'PKR', 'hA', '001-security-rule-1.md')), 'B does get the project rule')
  const seenAtB = fs.readdirSync(path.join(cloneB, 'rules', 'PKR', 'hA')).join(',')
  assert.ok(!seenAtB.includes('002'), `B must never receive a session rule; saw: ${seenAtB}`)

  // and A still RENDERS it — exclusion is transport, not visibility
  const { buildRulesSection } = await import('../../src/rules.ts')
  const secA = buildRulesSection(cloneA, {
    projectKey: 'PKR', harnessId: 'hA', budgetTokens: 1200,
    storeDir: path.join(a, '.dsh-chapters'), ancestorSessions: new Set(['sess-me']),
  })
  assert.ok(secA.kind === 'ok', JSON.stringify(secA))
  assert.ok(secA.text.includes('Rule body number 2'), 'authored locally, rendered locally')
  assert.match(secA.text, /## SESSION RULES/)
  // B asks the same builder with its OWN ancestry: nothing of A's session shows up
  const secB = buildRulesSection(cloneB, {
    projectKey: 'PKR', harnessId: 'hB', budgetTokens: 1200,
    storeDir: path.join(b, '.dsh-chapters'), ancestorSessions: new Set(['sess-b']),
  })
  assert.ok(secB.kind === 'none' || !secB.text.includes('Rule body number 2'), 'machine B is not governed by machine A session rules')
  fs.rmSync(root, { recursive: true, force: true })
})

test('§7.5 TreeDX provider: the same exclusion at the other backend', async () => {
  const { startStubTreeDx } = await import('./treedx-stub-server.ts')
  const { createTreedxProvider } = await import('../../src/treedx/provider.ts')
  const stub = await startStubTreeDx()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-treedx-'))
  try {
    await fetch(`${stub.base}/api/v1/repos`, {
      method: 'POST', headers: { authorization: `Bearer ${stub.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryName: 'dsh-rules-loop', source: { type: 'empty' }, placement: { mode: 'local' } }),
    })
    const cwd = path.join(root, 'hA')
    const dir = path.join(cwd, '.dsh-chapters', 'rules', 'hA')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '001-security-rule-1.md'), sessionFileBody(1, 'project', 'sess-me'))
    fs.writeFileSync(path.join(dir, '002-testing-rule-2.md'), sessionFileBody(2, 'session', 'sess-me'))
    const project: ProjectRecord = {
      projectKey: 'TRULES', slug: 'dsh-rules-loop', remote: `treedx+${stub.base}/dsh-rules-loop`,
      harnessId: 'hA', linkedAt: 'now', cwd, kind: 'treedx',
    }
    const r = await runSync({
      cwd, storeRoot: '.dsh-chapters', cloneDir: DEFAULT_CLONE_DIR, project, token: stub.token,
      provider: createTreedxProvider({ fetchTimeoutMs: 5000, workspaceTtlSeconds: 60, leaseRetries: 1, leaseRetryDelayMs: 0, sleep: async () => {} }),
      force: true,
    })
    assert.ok(r.ok, `${r.detail} | ${(r.steps ?? []).join('; ')}`)
    const tree = stub.treeOf('dsh-rules-loop')
    assert.ok(tree !== undefined, 'the stub kept a tree')
    assert.ok(tree!.has(path.posix.join('rules', 'TRULES', 'hA', '001-security-rule-1.md')), 'project tier traveled')
    assert.ok(![...tree!.keys()].some((k) => k.includes('002-testing-rule-2')), 'session tier never reached the TreeDX commit')
  } finally {
    await stub.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
