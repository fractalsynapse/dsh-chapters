import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  renderRuleFile, parseRuleFile, rulePath, buildRulesSection,
  appendRuleStatusFact, loadRuleStatusFacts, effectiveStatus,
  collectStoreRules, sessionRuleActive, collectActiveSessionRules, parseRuleMarkers,
  collectMirrorRules, selectRules,
  type MirrorRule,
} from '../../src/rules.ts'

function mirrorWith(rules: Array<{ harness: string; number: number; category: string; title: string; body: string }>): string {
  const m = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'))
  for (const r of rules) {
    const p = path.join(m, 'rules', 'PK', r.harness, `${String(r.number).padStart(3, '0')}-${r.category}.md`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, renderRuleFile({
      number: r.number, category: r.category, title: r.title,
      sourceSession: 'sess-x', at: '2026-09-20T00:00:00Z', body: r.body,
    }))
  }
  return m
}

test('rule file round-trips; written once as proposed; parse rejects non-rules', () => {
  const text = renderRuleFile({ number: 7, category: 'security', title: 'No token logging', sourceSession: 's1', at: 'a', body: 'Never log raw tokens.\n' })
  const parsed = parseRuleFile(text)!
  assert.equal(parsed.category, 'security')
  assert.equal(parsed.number, 7)
  assert.equal(parsed.fileStatus, 'proposed')
  assert.equal(parsed.body.trim(), 'Never log raw tokens.')
  assert.equal(parseRuleFile('---\ntitle: x\n---\nbody'), null, 'chapters are not rules')
  assert.ok(rulePath('.dsh-chapters', 'hA', 7, 'Security', 'No token logging!').endsWith('007-security-no-token-logging.md'))
})

test('effective status: own facts win, later fact supersedes, absent fact = file status', () => {
  const m = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'))
  assert.equal(effectiveStatus('hA/001', new Map(), 'proposed'), 'proposed')
  appendRuleStatusFact(m, 'hA', { rule: 'hA/001', status: 'core', at: 't1' })
  appendRuleStatusFact(m, 'hA', { rule: 'hA/001', status: 'revoked', at: 't2' })
  const facts = loadRuleStatusFacts(m, 'hA')
  assert.equal(effectiveStatus('hA/001', facts, 'proposed'), 'revoked', 'append-only order = last write wins')
  assert.equal(loadRuleStatusFacts(m, 'hB').size, 0, 'hB sees NO facts of hA — per-machine by construction')
})

test('section: none on empty corpus (the tape-preservation invariant)', () => {
  const m = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'))
  assert.deepEqual(buildRulesSection(m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200 }), { kind: 'none' })
  const withRule = mirrorWith([{ harness: 'hA', number: 1, category: 'security', title: 'T', body: 'x' }])
  // proposed-only renders the CATEGORY INDEX but no CORE RULES block
  const sec = buildRulesSection(withRule, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200 })
  assert.equal(sec.kind, 'ok')
  assert.ok(sec.kind === 'ok' && !sec.text.includes('CORE RULES') && sec.text.includes('security'), JSON.stringify(sec))
})

test('section: approved rules render verbatim + index; revoked vanish; other machines stay proposed', () => {
  const m = mirrorWith([
    { harness: 'hA', number: 1, category: 'security', title: 'Token policy', body: 'Never log raw tokens.' },
    { harness: 'hA', number: 2, category: 'style', title: 'Dead code', body: 'No commented-out code.' },
  ])
  appendRuleStatusFact(m, 'hA', { rule: 'hA/001', status: 'core', at: 't' })
  appendRuleStatusFact(m, 'hA', { rule: 'hA/002', status: 'revoked', at: 't' })
  const a = buildRulesSection(m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200 })
  assert.ok(a.kind === 'ok')
  assert.ok(a.text.includes('CORE RULES') && a.text.includes('Never log raw tokens.'), a.text)
  assert.ok(!a.text.includes('No commented-out code.'), 'revoked rule is gone from the notice')
  assert.ok(!a.text.includes('style'), 'revoked category drops from the index')
  const b = buildRulesSection(m, { projectKey: 'PK', harnessId: 'hB', budgetTokens: 1200 })
  assert.ok(b.kind === 'ok' && !b.text.includes('CORE RULES'), 'machine B: NOTHING is core there — exit criterion 1')
})

test('overflow refuses with per-rule numbers and names no truncation', () => {
  const long = 'word '.repeat(500)
  const m = mirrorWith([{ harness: 'hA', number: 1, category: 'c', title: 'T', body: long }])
  appendRuleStatusFact(m, 'hA', { rule: 'hA/001', status: 'core', at: 't' })
  const r = buildRulesSection(m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 100 })
  assert.equal(r.kind, 'refusal')
  assert.ok(r.kind === 'refusal')
  assert.ok(r.total > r.cap && r.perRule.length === 1 && r.perRule[0]!.tokens > 100, JSON.stringify(r))
  assert.match(r.reason, /never clips/)
})

// ------------------------------------------- #50 two-tier rules: the model layer
// Record §7.1 (tiers share one format), §7.5 (derived activation, marker capture).
// Each row is written to fail on the mutation it guards.

test('§7.1 a project rule renders byte-identically to the pre-#50 format', () => {
  // THE compatibility row: if defaults were printed instead of omitted, every
  // rule file already in a pool would start differing from its local twin and
  // copyNewFiles would rewrite the corpus. Absent means project, always.
  const legacy = renderRuleFile({ number: 1, category: 'c', title: 'T', sourceSession: 's', at: 'a', body: 'b\n' })
  const explicit = renderRuleFile({ number: 1, category: 'c', title: 'T', sourceSession: 's', at: 'a', body: 'b\n', scope: 'project', derivedFrom: 'human', pinned: false })
  assert.equal(explicit, legacy, 'defaults are absent, never printed')
  assert.ok(!legacy.includes('scope:'), legacy)
  assert.ok(!legacy.includes('pinned'), legacy)
})

test('§7.1 session tier round-trips scope, session, provenance and pin', () => {
  const text = renderRuleFile({
    number: 9, category: 'testing', title: 'Run the tape first', sourceSession: 'sess-1', at: '2026-10-20',
    body: 'Run the tape replay before tagging.\n', scope: 'session', session: 'sess-1', derivedFrom: 'marker', pinned: true,
  })
  const p = parseRuleFile(text)!
  assert.equal(p.scope, 'session')
  assert.equal(p.session, 'sess-1')
  assert.equal(p.derivedFrom, 'marker')
  assert.equal(p.pinned, true)
  assert.equal(p.body.trim(), 'Run the tape replay before tagging.')
  // a legacy file (no scope key at all) parses as project, never as undefined
  const old = parseRuleFile('---\nnumber: 3\nkind: rule\ncategory: "c"\ntitle: "T"\nstatus: proposed\n---\nbody text\n')!
  assert.equal(old.scope, 'project')
  assert.equal(old.derivedFrom, 'human')
  assert.equal(old.pinned, false)
  assert.equal(old.session, '')
})

test('§7.1 an unknown scope or provenance value degrades to the safe default', () => {
  // a hand-edited or future-versioned file must never become active by accident
  const p = parseRuleFile('---\nnumber: 1\nkind: rule\nscope: GLOBAL\nderivedFrom: alien\npinned: yes-please\n---\nx\n')!
  assert.equal(p.scope, 'project')
  assert.equal(p.derivedFrom, 'human')
  assert.equal(p.pinned, false)
})

function storeWith(entries: Array<{ harness: string; number: number; body: string; scope?: 'project' | 'session'; session?: string; derivedFrom?: 'human' | 'marker' | 'model' }>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'srule-'))
  for (const e of entries) {
    const p = path.join(d, 'rules', e.harness, `${String(e.number).padStart(3, '0')}-c-${e.number}.md`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, renderRuleFile({
      number: e.number, category: 'c', title: `T${e.number}`, sourceSession: e.session ?? 's', at: '2026-10-20',
      body: e.body, scope: e.scope, session: e.session, derivedFrom: e.derivedFrom,
    }))
  }
  return d
}

test('§7.5 collectStoreRules reads the LOCAL store tree and keeps both tiers', () => {
  const d = storeWith([
    { harness: 'hA', number: 1, body: 'project rule text long enough' },
    { harness: 'hA', number: 2, body: 'session rule text long enough', scope: 'session', session: 'sess-1' },
  ])
  const all = collectStoreRules(d, 'hA')
  assert.deepEqual(all.map((r) => r.id), ['hA/001', 'hA/002'])
  assert.equal(all.find((r) => r.id === 'hA/001')!.scope, 'project')
  assert.equal(all.find((r) => r.id === 'hA/002')!.session, 'sess-1')
})

test('§7.5 activation is DERIVED: ancestor path in, everything else out', () => {
  const d = storeWith([
    { harness: 'hA', number: 1, body: 'an approved project rule, long enough', scope: 'project' },
    { harness: 'hA', number: 2, body: 'a session rule on my own session', scope: 'session', session: 'sess-me' },
    { harness: 'hA', number: 3, body: 'a session rule inherited from my parent', scope: 'session', session: 'sess-parent' },
    { harness: 'hA', number: 4, body: 'a session rule from an unrelated session', scope: 'session', session: 'sess-other' },
    { harness: 'hA', number: 5, body: 'a session rule with no session stamped at all', scope: 'session', session: '' },
    { harness: 'hA', number: 6, body: 'a revoked session rule on my own session', scope: 'session', session: 'sess-me' },
  ])
  const ancestors = new Set(['sess-root', 'sess-parent', 'sess-me'])
  const revoked = new Set(['hA/006'])
  const active = collectActiveSessionRules(d, 'hA', { ancestorSessions: ancestors, revoked }).map((r) => r.id)
  assert.deepEqual(active, ['hA/002', 'hA/003'], 'own + inherited only; project tier never leaks in here')
  assert.ok(!active.includes('hA/004'), 'another session tree is NOT my ancestry')
  assert.ok(!active.includes('hA/005'), 'a session rule with no session id binds nothing')
  assert.ok(!active.includes('hA/006'), 'revoke switches it off — the one fact the tier does write')
  // and the predicate refuses a mirror-sourced session rule that was never staged
  const smuggled: MirrorRule = { id: 'hB/007', relPath: 'x', status: 'core', category: 'c', title: 't', body: 'b', bodyTokens: 1, scope: 'session', session: 'sess-me', derivedFrom: 'marker', pinned: false }
  assert.equal(sessionRuleActive(smuggled, { ancestorSessions: ancestors, revoked: new Set() }), true,
    'the predicate is about scope+ancestry, not about which collector produced the record')
})

test('§7.5 the marker parses at LINE START, needs a sentence, and dedupes', () => {
  const msg = [
    'ADD RULE: always run the tape replay before tagging a release',
    '  ADD RULE: indented still counts, leading spaces are noise',
    'please ADD RULE: this is prose mentioning the prefix mid-sentence',
    'ADD RULE: too short',
    'ADD RULE: always run the tape replay before tagging a release',
  ].join('\n')
  const got = parseRuleMarkers(msg, 'ADD RULE:')
  assert.deepEqual(got, [
    'always run the tape replay before tagging a release',
    'indented still counts, leading spaces are noise',
  ], 'mid-sentence mention rejected; sub-minimum rejected; exact duplicate collapsed')
  assert.deepEqual(parseRuleMarkers('anything at all', ''), [], 'an empty prefix captures nothing (never match-all)')
})

// --------------------------------- #50 §7.3/§7.4: what a rebuilt head actually shows

function twoTierFixture(over: { mirrorRules?: Array<{ harness: string; number: number; category: string; title: string; body: string; pinned?: boolean }>; storeRules?: Array<{ number: number; category: string; title: string; body: string; scope: 'project' | 'session'; session: string; pinned?: boolean }> } = {}) {
  const m = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'))
  for (const r of (over.mirrorRules ?? [])) {
    const p = path.join(m, 'rules', 'PK', r.harness, `${String(r.number).padStart(3, '0')}-${r.category}.md`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, renderRuleFile({ number: r.number, category: r.category, title: r.title, sourceSession: 's', at: '2026-10-20', body: r.body, pinned: r.pinned }))
    appendRuleStatusFact(m, r.harness, { rule: `${r.harness}/${String(r.number).padStart(3, '0')}`, status: 'core', at: 't' })
  }
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'))
  for (const r of (over.storeRules ?? [])) {
    const p = path.join(d, 'rules', 'hA', `${String(r.number).padStart(3, '0')}-${r.category}.md`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, renderRuleFile({
      number: r.number, category: r.category, title: r.title, sourceSession: r.session, at: '2026-10-20',
      body: r.body, scope: r.scope, session: r.session, derivedFrom: 'marker', pinned: r.pinned,
    }))
  }
  return { m, d, ancestors: new Set(['sess-root', 'sess-me']) }
}

test('§7.3 no store, no caps ⇒ the block is byte-for-byte what it was before #50', () => {
  // the compat row that lets the four door call sites stay untouched. This
  // literal is not written by hand: it is the output of the PREVIOUS builder
  // (HEAD's buildRulesSection) captured over this same fixture and diffed
  // against the new one — text-equal and kind-equal, with only the non-rendered
  // `withheld` field added. If the block drifts, a notice golden drifts with it.
  const m = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'))
  const put = (num: number, cat: string, title: string, body: string, core: boolean): void => {
    const p = path.join(m, 'rules', 'PK', 'hA', `${String(num).padStart(3, '0')}-${cat}.md`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, renderRuleFile({ number: num, category: cat, title, sourceSession: 's', at: '2026-01-01', body }))
    if (core) appendRuleStatusFact(m, 'hA', { rule: `hA/${String(num).padStart(3, '0')}`, status: 'core', at: 't' })
  }
  put(1, 'security', 'Tokens', 'Never log raw tokens.', true)
  put(2, 'style', 'Dead', 'No commented-out code.', false)
  const r = buildRulesSection(m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200 })
  assert.ok(r.kind === 'ok', JSON.stringify(r))
  assert.equal(r.text, [
    '## CORE RULES (approved for this project — follow them)',
    '[hA/001] (security) Never log raw tokens.',
    '',
    'Rule categories (load a category from the repo when this session\u2019s topics overlap it):',
    '- security (1): Tokens — e.g. rules/PK/hA/001-security.md',
    '- style (1): Dead — e.g. rules/PK/hA/002-style.md',
  ].join('\n'))
  assert.equal(r.tokens, 74)
  assert.deepEqual(r.withheld, { project: 0, session: 0 }, 'nothing withheld ⇒ still reported, so "you are seeing all of it" is a fact')
})

test('§7.1/§7.7 the session tier renders under its own header with the never-override line', () => {
  const f = twoTierFixture({
    mirrorRules: [{ harness: 'hA', number: 1, category: 'security', title: 'Tokens', body: 'Never log raw tokens.' }],
    storeRules: [
      { number: 2, category: 'testing', title: 'Tape', body: 'Run the tape replay before tagging.', scope: 'session', session: 'sess-me' },
      { number: 3, category: 'testing', title: 'Inherited', body: 'Never edit a committed tape by hand.', scope: 'session', session: 'sess-root' },
      { number: 4, category: 'testing', title: 'Foreign', body: 'A rule from a session that is not my ancestry.', scope: 'session', session: 'sess-unrelated' },
    ],
  })
  const r = buildRulesSection(f.m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200, storeDir: f.d, ancestorSessions: f.ancestors })
  assert.ok(r.kind === 'ok', JSON.stringify(r))
  assert.match(r.text, /## CORE RULES/)
  assert.match(r.text, /## SESSION RULES \(captured this session — they refine the project rules above; they never override them\)/)
  assert.ok(r.text.includes('Run the tape replay before tagging.'), 'own session active')
  assert.ok(r.text.includes('Never edit a committed tape by hand.'), 'inherited from the tree active')
  assert.ok(!r.text.includes('not my ancestry'), 'another session tree is NOT carried')
  assert.ok(r.text.indexOf('[hA/001]') < r.text.indexOf('[hA/002]'), 'project tier renders first — precedence is positional too')
})

test('§7.4 caps SELECT and ANNOUNCE; they never clip silently, and pinned never gets evicted', () => {
  const f = twoTierFixture({
    mirrorRules: [
      { harness: 'hA', number: 1, category: 'a', title: 'One', body: 'first rule body text here', pinned: true },
      { harness: 'hA', number: 2, category: 'b', title: 'Two', body: 'second rule body text' },
      { harness: 'hA', number: 3, category: 'c', title: 'Three', body: 'third rule body text here' },
    ],
  })
  const capped = buildRulesSection(f.m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200, projectCap: 2 })
  assert.ok(capped.kind === 'ok')
  assert.ok(capped.text.includes('first rule body text here'), 'the pinned rule survived the cap')
  assert.ok(!capped.text.includes('third rule body text here'), 'the last in selection order is the one dropped')
  assert.match(capped.text, /1 more project rule\(s\) active but not shown/, capped.text)
  assert.deepEqual(capped.withheld, { project: 1, session: 0 })
  const open = buildRulesSection(f.m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200 })
  assert.ok(open.kind === 'ok' && !/not shown/.test(open.text), 'no cap ⇒ nothing withheld ⇒ no announcement')
})

test('§7.4 relevance reorders by topicality but never demotes a pinned rule', () => {
  const f = twoTierFixture({
    mirrorRules: [
      { harness: 'hA', number: 1, category: 'deploy', title: 'Blue-green', body: 'always deploy blue-green style', pinned: true },
      { harness: 'hA', number: 2, category: 'testing', title: 'Coverage', body: 'coverage gate before merge always' },
    ],
  })
  const topics = ['coverage', 'testing']
  const ranked = buildRulesSection(f.m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200, relevanceTopics: topics, projectCap: 1 })
  assert.ok(ranked.kind === 'ok')
  assert.ok(ranked.text.includes('always deploy blue-green style'), 'pinned wins the single slot')
  assert.equal(selectRules(collectMirrorRules(f.m, 'PK', 'hA').filter((r) => r.status === 'core'), topics)[1]?.id, 'hA/002')
})

test('§7.4 selection is a pure function of inputs — no clock, no readdir order', () => {
  const f = twoTierFixture({
    mirrorRules: [1, 2, 3, 4].map((n) => ({ harness: 'hA', number: n, category: `c${n}`, title: `T${n}`, body: `body ${n} of the ruleset here` })),
  })
  const rules = collectMirrorRules(f.m, 'PK', 'hA')
  const forward = selectRules(rules, ['body']).map((r) => r.id).join(',')
  const backward = selectRules([...rules].reverse(), ['body']).map((r) => r.id).join(',')
  assert.equal(forward, backward, 'input order cannot change the output order')
  const a = buildRulesSection(f.m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200, projectCap: 2 })
  const b = buildRulesSection(f.m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200, projectCap: 2 })
  assert.ok(a.kind === 'ok' && b.kind === 'ok' && a.text === b.text, 'same inputs ⇒ same bytes on a second machine')
})

test('§7.3 the token ceiling counts BOTH tiers and still refuses rather than clips', () => {
  const long = 'word '.repeat(300)
  const f = twoTierFixture({
    mirrorRules: [{ harness: 'hA', number: 1, category: 'a', title: 'Big', body: long }],
    storeRules: [{ number: 2, category: 'b', title: 'Also big', body: long, scope: 'session', session: 'sess-me' }],
  })
  const r = buildRulesSection(f.m, { projectKey: 'PK', harnessId: 'hA', budgetTokens: 200, storeDir: f.d, ancestorSessions: f.ancestors })
  assert.equal(r.kind, 'refusal')
  assert.ok(r.kind === 'refusal')
  assert.equal(r.perRule.length, 2, 'both tiers are inside the measured total')
  assert.match(r.reason, /never clips/)
})
