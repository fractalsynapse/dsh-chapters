import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rulesCommand, type RulesIo } from '../../src/rules-commands.ts'
import { renderRuleFile, collectMirrorRules } from '../../src/rules.ts'
import type { RuleRecord } from '../../src/rules.ts'
import type { ProjectRecord } from '../../src/sync.ts'

function harness(over: Partial<RulesIo> = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rulecmd-'))
  const project: ProjectRecord = { projectKey: 'PKC', slug: 's', remote: 'x', harnessId: 'hA', linkedAt: 'l', cwd }
  const table = new Map<string, RuleRecord>()
  let syncs = 0
  const io: RulesIo = {
    cwd: () => cwd,
    storeRoot: '.dsh-chapters',
    harnessId: 'hA',
    store: {
      rules: () => table.entries(),
      getRule: (id) => table.get(id),
      putRule: async (id, v) => { table.set(id, v) },
    },
    projectFor: () => project,
    mirrorDir: () => path.join(cwd, '.dsh-knowledge'),
    syncNow: async () => { syncs += 1 },
    now: () => new Date('2026-09-20T12:00:00Z'),
    ...over,
  }
  return { io, cwd, table, syncCount: () => syncs, dispose: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

test('add: writes the file once, records in the domain, syncs, and echoes the approve line', async () => {
  const h = harness()
  const r = await rulesCommand(h.io, 'add security Never log raw tokens or bearer headers anywhere')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /rule hA\/001 proposed/)
  const file = path.join(h.cwd, '.dsh-chapters', 'rules', 'hA', '001-security-never-log-raw-tokens-or-bearer-headers-a.md')
  assert.ok(fs.existsSync(file), fs.readdirSync(path.join(h.cwd, '.dsh-chapters', 'rules', 'hA')).join(','))
  assert.equal(h.table.get('hA/001')?.category, 'security')
  assert.equal(h.syncCount(), 1)
  const dup = await rulesCommand(h.io, 'add security Second rule text that is long enough')
  assert.match(dup.text, /002/) // number advanced
  h.dispose()
})

test('add refuses short text; everything refuses with no linked project', async () => {
  const h = harness()
  assert.equal((await rulesCommand(h.io, 'add security too short')).kind, 'error')
  const noProject = harness({ projectFor: () => undefined })
  assert.match((await rulesCommand(noProject.io, 'list')).text, /chapters-link/)
  h.dispose(); noProject.dispose()
})

test('approve writes a fact to the OWN edits dir (even for another machine\u2019s rule); revoke supersedes in list', async () => {
  const h = harness()
  // seed a foreign rule INTO THE MIRROR (as a pull would have delivered it)
  const foreign = path.join(h.cwd, '.dsh-knowledge', 'rules', 'PKC', 'hX', '004-deploy-checklist.md')
  fs.mkdirSync(path.dirname(foreign), { recursive: true })
  fs.writeFileSync(foreign, renderRuleFile({ number: 4, category: 'deploy', title: 'Blue-green only', sourceSession: 's', at: 'a', body: 'Deploy via blue-green only.\n' }))
  const ok = await rulesCommand(h.io, 'approve hX/004')
  assert.equal(ok.kind, 'success', ok.text)
  const facts = path.join(h.cwd, '.dsh-knowledge', 'edits', 'hA', 'curation.jsonl')
  assert.ok(fs.existsSync(facts), 'fact in MY edits dir, not hX\u2019s')
  assert.ok(fs.readFileSync(facts, 'utf8').includes('"rule":"hX/004","status":"core"'))
  const rules = collectMirrorRules(path.join(h.cwd, '.dsh-knowledge'), 'PKC', 'hA')
  assert.equal(rules.find((r) => r.id === 'hX/004')?.status, 'core')
  // effective for a DIFFERENT machine: still proposed
  const rulesB = collectMirrorRules(path.join(h.cwd, '.dsh-knowledge'), 'PKC', 'hB')
  assert.equal(rulesB.find((r) => r.id === 'hX/004')?.status, 'proposed')
  const bad = await rulesCommand(h.io, 'approve 999')
  assert.equal(bad.kind, 'error'); assert.match(bad.text, /unknown id/)
  const rev = await rulesCommand(h.io, 'revoke hX/004')
  assert.equal(rev.kind, 'success')
  const listed = await rulesCommand(h.io, 'list')
  assert.ok(!listed.text.includes('hX/004'), 'revoked hides from default list')
  const all = await rulesCommand(h.io, 'list --all')
  // #50 widened the table to `id scope status pin category title` (record §7.9),
  // so this row names the tier as well as the status.
  assert.match(all.text, /hX\/004\s+project\s+revoked/, all.text)
  h.dispose()
})

// ------------------------------------------------- audit rows (2026-09-23)

test('a disk-only rule file (killed before the domain write) is walked PAST, never a deadlock', async () => {
  // r39 residue class at the command surface: the number slot exists on disk
  // while the registry never got the record — add must find the next free
  // number (the old code refused forever).
  const h = harness()
  const dir = path.join(h.cwd, '.dsh-chapters', 'rules', 'hA')
  fs.mkdirSync(dir, { recursive: true })
  const ghost = path.join(dir, '001-security-ghost-of-a-dead-rule-that-once-existed-a.md')
  fs.writeFileSync(ghost, renderRuleFile({ number: 1, category: 'security', title: 'ghost of a dead rule that once existed', sourceSession: 'x', at: '2026-01-01', body: 'ghost\n' }))
  const r = await rulesCommand(h.io, 'add security A fresh rule with plenty of length to pass')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /rule hA\/002 proposed/, 'the walk advanced past the disk ghost')
  assert.ok(fs.existsSync(ghost), 'the ghost bytes were never touched (write-once)')
  h.dispose()
})

test('list merges mirror and domain rules, and filters render distinct views', async () => {
  const h = harness()
  await rulesCommand(h.io, 'add security Always rotate bearer tokens before they expire daily')
  const all = await rulesCommand(h.io, 'list')
  assert.match(all.text, /hA\/001/, 'list shows the fresh rule')
  const proposed = await rulesCommand(h.io, 'list --proposed')
  assert.match(proposed.text, /hA\/001/, 'the unapproved rule is proposed')
  const approved = await rulesCommand(h.io, 'list --all')
  assert.match(approved.text, /hA\/001/)
  const cat = await rulesCommand(h.io, 'list --category performance')
  assert.ok(!cat.text.includes('hA/001'), 'a different category filter excludes it')
  const junk = await rulesCommand(h.io, 'frobnicate')
  assert.match(junk.text, /usage|add <category>/i, 'unknown verb answers with the help')
  h.dispose()
})

test('approve reports failure honestly when the mirror edits dir cannot be written', async () => {
  const h = harness()
  await rulesCommand(h.io, 'add security Never echo raw tokens inside any stored output')
  const mirror = path.join(h.cwd, '.dsh-knowledge')
  fs.mkdirSync(mirror, { recursive: true })
  fs.chmodSync(mirror, 0o500)
  try {
    const r = await rulesCommand(h.io, 'approve hA/001')
    assert.equal(r.kind, 'error', 'the failure is reported, not swallowed')
    assert.match(r.text, /approve failed/i)
  } finally {
    fs.chmodSync(mirror, 0o700)
  }
  h.dispose()
})

// -------------------------------------- #50 §7.5/§7.9: the session tier joins the surface

function twoTierIo(over: Partial<RulesIo> = {}) {
  const h = harness(over)
  // an authored-and-pushed PROJECT rule: it lives in the mirror, which is where
  // effective status resolves from (§7.2). A rule that never synced is proposed
  // by construction — the other rows above cover that case.
  const mdir = path.join(h.cwd, '.dsh-knowledge', 'rules', 'PKC', 'hA')
  fs.mkdirSync(mdir, { recursive: true })
  fs.writeFileSync(path.join(mdir, '001-deploy.md'), renderRuleFile({
    number: 1, category: 'deploy', title: 'Blue-green only', sourceSession: 's', at: '2026-10-01',
    body: 'Deploy via blue-green only, never stop-start.\n',
  }))
  // a session rule written where the capture path writes it
  const dir = path.join(h.cwd, '.dsh-chapters', 'rules', 'hA')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '009-general-run-the-tape.md'), renderRuleFile({
    number: 9, category: 'general', title: 'Run the tape', sourceSession: 'sess-me', at: '2026-10-20',
    body: 'Run the tape replay before cutting a tag.\n', scope: 'session', session: 'sess-me', derivedFrom: 'marker',
  }))
  fs.writeFileSync(path.join(dir, '010-general-inherited.md'), renderRuleFile({
    number: 10, category: 'general', title: 'Inherited order', sourceSession: 'sess-parent', at: '2026-10-19',
    body: 'Merge staging into the feature branch before opening a PR.\n', scope: 'session', session: 'sess-parent', derivedFrom: 'marker',
  }))
  const base: Partial<RulesIo> = {
    ancestors: async () => new Set(['sess-parent', 'sess-me']),
    budgetTokens: 1200,
  }
  return { ...h, io: { ...h.io, ...base, ...over } as RulesIo }
}

test('§7.9 list --scope separates the tiers and shows derived activation', async () => {
  const h = twoTierIo()
  const sess = await rulesCommand(h.io, 'list --scope session')
  assert.match(sess.text, /009\s+session\s+active/, sess.text)
  assert.match(sess.text, /010\s+session\s+active/, sess.text, 'inherited from the tree (§7.5)')
  const proj = await rulesCommand(h.io, 'list --scope project')
  assert.ok(!proj.text.includes('009'), proj.text)
  const bad = await rulesCommand(h.io, 'list --scope global')
  assert.equal(bad.kind, 'error', 'an invented tier is refused, not silently ignored')
  h.dispose()
})

test('§7.9 active reports exactly what a rebuilt head will render — counts and withheld', async () => {
  const h = twoTierIo({ projectCap: 1, sessionCap: 1 })
  const add = await rulesCommand(h.io, 'approve hA/001')
  assert.equal(add.kind, 'success', add.text)
  const r = await rulesCommand(h.io, 'active')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /project tier: 1 approved-core on THIS machine/, r.text)
  assert.match(r.text, /session tier: 2 active for this session tree/, r.text)
  assert.match(r.text, /RENDERED: 1 project \+ 1 session rule\(s\), withheld 0 \+ 1/, r.text)
  h.dispose()
})

test('§7.1 a SESSION rule cannot be approved — and the answer names the promotion path', async () => {
  const h = twoTierIo()
  const r = await rulesCommand(h.io, 'approve hA/009')
  assert.equal(r.kind, 'error', r.text)
  assert.match(r.text, /already active for this session tree/, r.text)
  assert.match(r.text, /chapters-rule add/, r.text, 'promotion is the human door it points at')
  // and revoke DOES work on the session tier (§7.5: the one fact it writes)
  const rev = await rulesCommand(h.io, 'revoke hA/009')
  assert.equal(rev.kind, 'success', rev.text)
  const after = await rulesCommand(h.io, 'list --scope session')
  // applying status facts to the store collector (§7.5 approve-of-a-suggestion)
  // also means a revoked session rule now behaves like a revoked project rule in
  // the default view: hidden, because `status` is resolved, not read off the file.
  assert.ok(!after.text.includes('hA/009'), after.text)
  const all = await rulesCommand(h.io, 'list --scope session --all')
  assert.match(all.text, /009\s+session\s+revoked/, all.text)
  h.dispose()
})

test('§7.4 pin rides a curation FACT — the write-once file is never rewritten', async () => {
  const h = twoTierIo()
  const file = path.join(h.cwd, '.dsh-chapters', 'rules', 'hA', '009-general-run-the-tape.md')
  const before = fs.readFileSync(file, 'utf8')
  const r = await rulesCommand(h.io, 'pin hA/009')
  assert.equal(r.kind, 'success', r.text)
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'not one byte of the rule file changed (§1.3)')
  const facts = fs.readFileSync(path.join(h.cwd, '.dsh-knowledge', 'edits', 'hA', 'curation.jsonl'), 'utf8')
  assert.ok(facts.includes('"type":"rule-pin"'), facts)
  const listed = await rulesCommand(h.io, 'list --scope session')
  assert.match(listed.text, /pin/, listed.text)
  const un = await rulesCommand(h.io, 'unpin hA/009')
  assert.equal(un.kind, 'success')
  const after = await rulesCommand(h.io, 'list --scope session')
  assert.ok(!/009\s+session\s+active\s+pin/.test(after.text), after.text)
  h.dispose()
})

test('§7.7 conflicts reports and mutates NOTHING; without a route it refuses honestly', async () => {
  let asked = ''
  const h = twoTierIo({
    ask: async (p) => { asked = p; return 'CONFLICT: hA/001 vs hA/009 — one says deploy blue-green only, the other says stop the fleet first.' },
  })
  const ap = await rulesCommand(h.io, 'approve hA/001')
  assert.equal(ap.kind, 'success', ap.text)
  const r = await rulesCommand(h.io, 'conflicts')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /CONFLICT: hA\/001 vs hA\/009/, r.text)
  assert.match(r.text, /nothing was changed/)
  assert.ok(asked.includes('Do not rewrite or merge any rule'), asked.slice(0, 200))
  // one line per active rule, both tiers, in the prompt
  assert.ok(asked.includes('session/general'), asked)
  const dir = path.join(h.cwd, '.dsh-chapters', 'rules', 'hA')
  const names = fs.readdirSync(dir).join(',')
  assert.ok(!names.includes('011'), `conflicts wrote a file: ${names}`)
  const noRoute = twoTierIo()
  const refused = await rulesCommand(noRoute.io, 'conflicts')
  assert.equal(refused.kind, 'error'); assert.match(refused.text, /conversation model route/)
  h.dispose(); noRoute.dispose()
})

test('§7.9 without a session context the session tier is reported UNRESOLVED, never guessed', async () => {
  const h = twoTierIo({ ancestors: undefined })
  const r = await rulesCommand(h.io, 'active')
  assert.match(r.text, /reported unresolved, never guessed/, r.text)
  assert.match(r.text, /session tier: 0/, r.text)
  h.dispose()
})

/**
 * The stored-path dialect, in the READ direction (#56/#61 item 8, measured 2026-10-24 on the `enrich`
 * leg). `toStoredPath` may hand back an ABSOLUTE path — the rig legitimately pins an absolute
 * `artifactStoreRoot` per port — and `path.join(cwd, absolute)` CONCATENATES rather than resolving, so
 * `/home/x/proj` + `/tmp/dsh-e2e/e2e-home-41734/chapters/….md` becomes a path that exists nowhere.
 * The ladder then reported `chapter file absent` about a file sitting right there, and the repair
 * engine's two joins had the same latent defect. Every path READ goes through one resolver.
 */
test('resolveStoredPath keeps an absolute stored path absolute and resolves a relative one', async () => {
  const { resolveStoredPath } = await import('../../src/archive.ts')
  assert.equal(resolveStoredPath('/work/proj', '/tmp/dsh-e2e/home/chapters/x.md'), '/tmp/dsh-e2e/home/chapters/x.md',
    'an absolute stored path must survive untouched — concatenating it produces a path to nothing')
  assert.equal(resolveStoredPath('/work/proj', 'chapters/x.md'), '/work/proj/chapters/x.md')
  assert.equal(resolveStoredPath(undefined, 'chapters/x.md'), 'chapters/x.md', 'no cwd means no basis to join onto, not a guess')
})

test('chapter paths are read through the ONE resolver, never a bare join (#69-class)', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const root = path.resolve(import.meta.dirname, '..', '..')
  for (const [file, count] of [['src/enrich-wire.ts', 1], ['src/repair-run.ts', 2]] as const) {
    const src = fs.readFileSync(path.join(root, file), 'utf8')
    assert.doesNotMatch(src, /path\.join\((cwd|base), (rec|written|f\.target)\.path\)/,
      `${file} still joins a stored path onto a cwd — it must call resolveStoredPath`)
    assert.ok((src.match(/resolveStoredPath\(/g) ?? []).length >= count,
      `${file} must resolve its ${String(count)} stored path(s) through the helper`)
  }
})
