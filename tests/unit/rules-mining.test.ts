/**
 * #50 §7.5 — the background half: the SAME model that does the work mines the
 * standing orders out of each archived chapter and applies them, so the human
 * never has to think about it. What keeps that safe is not a click, it is
 * EVIDENCE: a mined rule governs a session only when it quotes the human's own
 * words verbatim out of the chapter's USER text. Anything else is written,
 * listed, and inert until a human approves it.
 *
 * Rows here cover: the output contract (backward-compatible), the quote gate,
 * the capture (activation / inertness / dedupe / cap / redaction / numbering),
 * the ladder integration (user-chunks-only, gated off, unwired), and the review
 * surface (approve a suggestion, not an already-active rule).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEnrichResult, buildEnrichInput } from '../../src/enrich.ts'
import { quoteIsHuman, captureMinedRules } from '../../src/session-rules.ts'
import {
  parseRuleFile, renderRuleFile, collectStoreRules, sessionRuleActive, buildRulesSection,
  appendRuleStatusFact, loadRuleStatusFacts, type RuleRecord,
} from '../../src/rules.ts'
import { rulesCommand, type RulesIo } from '../../src/rules-commands.ts'
import { createEnrichWiring, type EnrichWiringDeps } from '../../src/enrich-wire.ts'
import type { ProjectRecord } from '../../src/sync.ts'
import { sha256 } from '../../src/render.ts'


// ------------------------------------------------------------- the output contract

test('§7.5 the rules field is OPTIONAL — the old three-field shape still validates', () => {
  // every existing stub, fake and tape answers with three fields; if `rules` were
  // required the ladder would fail validation and chapters would go unannotated.
  const r = parseEnrichResult('{"title":"T","summary":"A summary that is informative.","topics":["auth"]}')
  assert.ok(r !== null)
  assert.deepEqual(r.rules, [])
})

test('§7.5 mined rules validate with bounds, and a bad rules array never costs the annotation', () => {
  const ok = parseEnrichResult('{"title":"T","summary":"S enough","topics":["a"],"rules":[{"text":"Always run the tape replay before cutting a release tag","category":"Testing","quote":"run the tape replay before cutting"},{"text":"too short","category":"x","quote":"y"}]}')
  assert.ok(ok !== null)
  assert.equal(ok.rules.length, 1, 'the sub-minimum candidate is dropped, the good one kept')
  assert.equal(ok.rules[0]!.category, 'testing', 'category is slug-normalized')

  // malformed rules must not invalidate the whole result (the never-blank guarantee)
  const junk = parseEnrichResult('{"title":"T","summary":"S enough","topics":["a"],"rules":"not-an-array"}')
  assert.ok(junk !== null, JSON.stringify(junk))
  assert.deepEqual(junk.rules, [], 'annotation survives a garbage rules field')

  const many = parseEnrichResult(`{"title":"T","summary":"S enough","topics":["a"],"rules":[${Array.from({ length: 7 }, (_, i) => `{"text":"Standing instruction number ${i} with plenty of length here","category":"c","quote":"q${i}"}`).join(',')}]}`)
  assert.ok(many !== null)
  assert.equal(many.rules.length, 3, 'a chapter may not mint a dozen standing orders')
})

test('§7.5 the mining ask is in the prompt, with the evidence requirement stated', () => {
  const input = buildEnrichInput({ title: 'x' }, { requests: ['please always run the tape replay'] }, 'body')
  assert.match(input, /"rules": \[\{"text"/, 'the shape is advertised or the model cannot emit it')
  assert.match(input, /quote the user[\s\S]{0,40}own words verbatim|verbatim/i)
  assert.match(input, /omit "rules" or send \[\]/, 'the model is told that no-rule is the right answer, not a missed opportunity')
})

// ------------------------------------------------------------- the quote gate

test('§7.5 the quote gate accepts the human\u2019s words and refuses everything else', () => {
  const human = 'ADD RULE aside — always run the tape replay before cutting a tag\n<system-reminder>ignored</system-reminder>'
  assert.equal(quoteIsHuman(human, 'always run the tape replay before cutting a tag'), true)
  assert.equal(quoteIsHuman(human, 'ALWAYS   RUN THE TAPE REPLAY'), true, 'case and whitespace are noise, wording is not')
  assert.equal(quoteIsHuman(human, 'run the replay before tagging'), false, 'a paraphrase is NOT a quote')
  assert.equal(quoteIsHuman(human, 'ab'), false, 'a two-char quote proves nothing')
  assert.equal(quoteIsHuman('done: pushed and verified, the tape replay passed', 'always run the tape replay'), false,
    'assistant prose is not admissible evidence — the amplification path')
})

// ------------------------------------------------------------- the capture

function captureWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-'))
  const storeDir = path.join(dir, '.dsh-chapters')
  return {
    dir, storeDir,
    records: new Map<string, RuleRecord>(),
    rulesDir: path.join(storeDir, 'rules', 'hA'),
    humanText: 'please always run the tape replay before cutting a tag, that is the rule',
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

const mined = (text: string, quote: string, category = 'testing') => ({ text, category, quote })

test('§7.5 a verified quote is written and ACTIVE; no suggestion flag, no approval step', () => {
  const w = captureWorld()
  const res = captureMinedRules({
    storeDir: w.storeDir, harnessId: 'hA', sessionId: 'sess-me', records: w.records,
    humanText: w.humanText, maxPerChapter: 3, now: () => '2026-10-20T00:00:00Z',
    rules: [mined('Always run the tape replay before cutting a tag.', 'always run the tape replay before cutting a tag')],
  })
  assert.deepEqual(res, { ids: ['hA/001'], activated: 1, suggested: 0 })
  const file = fs.readFileSync(path.join(w.rulesDir, fs.readdirSync(w.rulesDir)[0]!), 'utf8')
  const p = parseRuleFile(file)!
  assert.equal(p.scope, 'session')
  assert.equal(p.derivedFrom, 'model')
  assert.equal(p.suggested, false, 'verified ⇒ no inertness marker written at all')
  assert.equal(p.body.trim(), 'Always run the tape replay before cutting a tag.')
  const active = collectStoreRules(w.storeDir, 'hA').filter((r) => sessionRuleActive(r, { ancestorSessions: new Set(['sess-me']), revoked: new Set() }))
  assert.equal(active.length, 1, 'it governs the session without a human touching it — the whole point')
  w.dispose()
})

test('§7.5 an unverified quote is recorded, listed, and INERT in every head', () => {
  const w = captureWorld()
  const res = captureMinedRules({
    storeDir: w.storeDir, harnessId: 'hA', sessionId: 'sess-me', records: w.records,
    humanText: w.humanText, maxPerChapter: 3,
    rules: [mined('Never force-push to a shared branch.', 'we should probably never force push')],
  })
  assert.equal(res.suggested, 1, 'the guess is captured, not discarded')
  const p = parseRuleFile(fs.readFileSync(path.join(w.rulesDir, fs.readdirSync(w.rulesDir)[0]!), 'utf8'))!
  assert.equal(p.suggested, true)
  const mirror = path.join(w.dir, '.dsh-knowledge')
  const sec = buildRulesSection(mirror, {
    projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200, storeDir: w.storeDir,
    ancestorSessions: new Set(['sess-me']),
  })
  assert.ok(sec.kind === 'none' || !sec.text.includes('Never force-push'),
    `a model guess must not steer a session unreviewed: ${sec.kind === 'ok' ? sec.text : sec.kind}`)
  w.dispose()
})

test('§7.5 approving a SUGGESTION activates it — and the write-once file never changed', () => {
  const w = captureWorld()
  captureMinedRules({
    storeDir: w.storeDir, harnessId: 'hA', sessionId: 'sess-me', records: w.records,
    humanText: w.humanText, maxPerChapter: 3,
    rules: [mined('Rotate deploy credentials before every release train.', 'rotate credentials before release')],
  })
  const file = path.join(w.rulesDir, fs.readdirSync(w.rulesDir)[0]!)
  const before = fs.readFileSync(file, 'utf8')
  const mirror = path.join(w.dir, '.dsh-knowledge')
  appendRuleStatusFact(mirror, 'hA', { rule: 'hA/001', status: 'core', at: '2026-10-20T12:00:00Z' })
  const facts = loadRuleStatusFacts(mirror, 'hA')
  const rows = collectStoreRules(w.storeDir, 'hA', facts)
  assert.equal(sessionRuleActive(rows[0]!, { ancestorSessions: new Set(['sess-me']), revoked: new Set(), facts }), true,
    'a human approve is what flips a suggestion on')
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'activation rode a curation FACT, not a file edit (§1.3)')
  w.dispose()
})

test('§7.5 capture dedupes by body, honors the per-chapter cap, and shares the number sequence', () => {
  const w = captureWorld()
  const rules = [
    mined('Always run the tape replay before cutting a tag.', 'always run the tape replay before cutting a tag'),
    mined('Always run the tape replay before cutting a tag.', 'always run the tape replay before cutting a tag'),
    mined('Second standing instruction with enough length to qualify.', 'that is the rule'),
    mined('Third standing instruction with enough length to qualify.', 'that is the rule'),
    mined('Fourth standing instruction with enough length to qualify.', 'that is the rule'),
  ]
  const first = captureMinedRules({ storeDir: w.storeDir, harnessId: 'hA', sessionId: 's', records: w.records, humanText: w.humanText, maxPerChapter: 3, rules })
  assert.equal(first.ids.length, 3, 'cap of 3 per chapter, duplicate collapsed: ' + first.ids.join(','))
  // a re-run FILLS the gap the cap cut (candidate D), then writes nothing more:
  // re-annotating a chapter with a newer model must not duplicate what stands.
  const again = captureMinedRules({ storeDir: w.storeDir, harnessId: 'hA', sessionId: 's', records: w.records, humanText: w.humanText, maxPerChapter: 3, rules })
  assert.deepEqual(again.ids, ['hA/004'], 'only the candidate the cap had cut is added: ' + again.ids.join(','))
  const third = captureMinedRules({ storeDir: w.storeDir, harnessId: 'hA', sessionId: 's', records: w.records, humanText: w.humanText, maxPerChapter: 3, rules })
  assert.deepEqual(third.ids, [], 'a fourth pass over the same chapter writes nothing')
  // a pre-existing PROJECT rule owns 001 ⇒ mined ones start at 002
  const w2 = captureWorld()
  fs.mkdirSync(w2.rulesDir, { recursive: true })
  fs.writeFileSync(path.join(w2.rulesDir, '001-general-existing.md'), renderRuleFile({
    number: 1, category: 'general', title: 'Existing', sourceSession: 'x', at: 'a', body: 'an existing project rule body here',
  }))
  const r2 = captureMinedRules({ storeDir: w2.storeDir, harnessId: 'hA', sessionId: 's', records: w2.records, humanText: w2.humanText, maxPerChapter: 3, rules: [mined('A fresh mined standing instruction of decent length.', 'always run the tape replay')] })
  assert.deepEqual(r2.ids, ['hA/002'], 'ids stay unique across the two tiers')
  w.dispose(); w2.dispose()
})

test('§7.5 §9 redaction runs over a mined body too', () => {
  const w = captureWorld()
  captureMinedRules({
    storeDir: w.storeDir, harnessId: 'hA', sessionId: 's', records: w.records, maxPerChapter: 3,
    humanText: 'paste ghp_abcdefghijklmnopqrstuvwxyz0123456789 into the rule',
    rules: [mined('Echo ghp_abcdefghijklmnopqrstuvwxyz0123456789 into the deploy log every time.', 'into the deploy log every time')],
  })
  const text = fs.readFileSync(path.join(w.rulesDir, fs.readdirSync(w.rulesDir)[0]!), 'utf8')
  assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz'), text)
  w.dispose()
})

// ------------------------------------------------------------- the ladder

function ladderHarness(fetchImpl: (prompt: string) => Promise<string>, over: Partial<EnrichWiringDeps> = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-mine-'))
  const rel = '.dsh-chapters/sess-1/chapters/001-topic.md'
  fs.mkdirSync(path.join(ws, '.dsh-chapters', 'sess-1', 'chapters'), { recursive: true })
  const body = '# Topic\n\n**User:** always run the tape replay before cutting a tag\n\n**Assistant:** done: pushed and verified the replay passed\n'
  const chapterText = `---\ntitle: "legacy fragment"\nsummary: deterministic summary text\ntopics: ["src/a.ts"]\n---\n${body}`
  fs.writeFileSync(path.join(ws, rel), chapterText)
  const state: Record<string, unknown> = {
    chapters: [{ number: 1, path: rel, title: 'legacy fragment', summary: 'deterministic summary text', topics: ['src/a.ts'], sha256: sha256(chapterText), startSeq: 0, endSeq: 5, estimatedTokens: 10 }],
  }
  const settings = new Map<string, string>()
  const store = {
    get: async () => state,
    put: async (_id: string, next: Record<string, unknown>) => { state.chapters = next.chapters },
    sessions: () => [['sess-1', state]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k),
    putSetting: async (k: string, v: string) => { settings.set(k, v) },
  } as unknown as EnrichWiringDeps['store']
  const logs: string[] = []
  const warns: string[] = []
  const deps: EnrichWiringDeps = {
    store,
    cwd: () => ws,
    config: { enabled: true, model: 'p/m1', trigger: 'both', idleMs: 10, batchCap: 5, mineCap: 3 },
    fetch: fetchImpl,
    conversationRoute: () => ({ provider: 'p', model: 'm1' }),
    log: (m) => { logs.push(m) }, warn: (m) => { warns.push(m) },
    setTimer: (fn) => { const t = setTimeout(fn, 100000); return { cancel: () => clearTimeout(t) } },
    ...over,
  }
  return { ws, rel, deps, logs, warns, dispose: () => fs.rmSync(ws, { recursive: true, force: true }) }
}

const minedAnswer = (quote: string) => async () =>
  `{"title":"Enriched","summary":"A summary that is informative.","topics":["auth"],"rules":[{"text":"Always run the tape replay before cutting a tag.","category":"testing","quote":${JSON.stringify(quote)}}]}`

test('§7.5 the ladder hands the sink the chapter\u2019s HUMAN bytes only, and reports what it did', async () => {
  const h = ladderHarness(minedAnswer('always run the tape replay before cutting a tag'))
  const seen: { humanText: string; count: number; sessionId: string; cwd: string }[] = []
  h.deps.onMinedRules = async (a) => { seen.push({ humanText: a.humanText, count: a.rules.length, sessionId: a.sessionId, cwd: a.cwd }); return { written: 1, activated: 1, suggested: 0 } }
  try {
    const r = await createEnrichWiring(h.deps).runNow()
    assert.equal(r.processed, 1, JSON.stringify(r))
    assert.equal(seen.length, 1)
    assert.match(seen[0]!.humanText, /always run the tape replay before cutting a tag/)
    assert.ok(!seen[0]!.humanText.includes('pushed and verified'), 'assistant text is NOT offered as evidence: ' + seen[0]!.humanText)
    assert.equal(seen[0]!.sessionId, 'sess-1', 'the rule binds the chapter\u2019s own session tree')
    assert.equal(seen[0]!.cwd, h.ws)
    assert.match(h.logs.join('\n'), /rule mining sess-1#1: 1 recorded \(1 activated on a verbatim quote/)
  } finally { h.dispose() }
})

test('§7.5 mining is not gated on the frontmatter write — a guarded chapter still mines', async () => {
  // The ordering claim, tested honestly: mining happens BEFORE the body-hash
  // guarded write, so a chapter whose annotation is refused (stale hash anchor —
  // the guard doing its job) still contributes its standing orders. If the block
  // ever moves below updateChapterFrontmatter or behind the "already enriched"
  // short-circuit, this row fails.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-mine2-'))
  const rel = '.dsh-chapters/sess-9/chapters/002-done.md'
  fs.mkdirSync(path.join(ws, '.dsh-chapters', 'sess-9', 'chapters'), { recursive: true })
  const body = '# Done\n\n**User:** never edit a committed tape by hand\n'
  const chapterText = `---\ntitle: "Legacy"\nsummary: deterministic summary text\ntopics: ["auth"]\n---\n${body}`
  fs.writeFileSync(path.join(ws, rel), chapterText)
  const state: Record<string, unknown> = {
    // a record whose declared hash no longer matches the file: the guard refuses
    chapters: [{ number: 2, path: rel, title: 'Legacy', summary: 'deterministic summary text', topics: ['auth'], sha256: 'DEADBEEF-not-the-file-hash' }],
  }
  let mined = 0
  const warns: string[] = []
  const deps: EnrichWiringDeps = {
    store: {
      get: async () => state, put: async () => {}, sessions: () => [['sess-9', state]],
      getSetting: () => undefined, putSetting: async () => {},
    } as unknown as EnrichWiringDeps['store'],
    cwd: () => ws,
    config: { enabled: true, model: 'p/m1', trigger: 'both', idleMs: 10, batchCap: 5 },
    fetch: minedAnswer('never edit a committed tape by hand'),
    conversationRoute: () => ({ provider: 'p', model: 'm1' }),
    log: () => undefined, warn: (m) => { warns.push(m) },
    onMinedRules: async () => { mined += 1; return { written: 1, activated: 1, suggested: 0 } },
  }
  try {
    await createEnrichWiring(deps).runNow()
    assert.equal(mined, 1, 'the rule was mined even though the annotation was refused')
    assert.match(warns.join('\n'), /enrichment failed for sess-9#2/, warns.join('\n'))
    // and the refusal did not lose the mining — the sink ran first
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

test('§7.5 gated off logs the drop; unwired warns loudly — mining is never silently lost', async () => {
  const off = ladderHarness(minedAnswer('always run the tape replay'), {})
  off.deps.config = { ...off.deps.config, mineRules: false }
  let sinkCalls = 0
  off.deps.onMinedRules = async () => { sinkCalls += 1; return { written: 0, activated: 0, suggested: 0 } }
  const unwired = ladderHarness(minedAnswer('always run the tape replay'))
  try {
    await createEnrichWiring(off.deps).runNow()
    assert.equal(sinkCalls, 0)
    assert.match(off.logs.join('\n'), /rule mining skipped for sess-1#1: 1 candidate\(s\) dropped \(rulesEnrichment off\)/, off.logs.join('\n'))
    await createEnrichWiring(unwired.deps).runNow()
    assert.match(unwired.warns.join('\n'), /rule mining UNWIRED on this plane/, unwired.warns.join('\n'))
  } finally { off.dispose(); unwired.dispose() }
})

test('§7.5 a sink that throws must not cost the chapter its annotation', async () => {
  const h = ladderHarness(minedAnswer('always run the tape replay'))
  h.deps.onMinedRules = async () => { throw new Error('disk gone') }
  try {
    const r = await createEnrichWiring(h.deps).runNow()
    assert.equal(r.processed, 1, 'the ladder completed anyway')
    const doc = fs.readFileSync(path.join(h.ws, h.rel), 'utf8')
    assert.ok(doc.includes('title: "Enriched"'), doc.slice(0, 200))
    assert.match(h.warns.join('\n'), /rule mining failed for sess-1#1/)
  } finally { h.dispose() }
})

// ------------------------------------------------------------- the review surface

function ioWorld() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-cmd-'))
  const project: ProjectRecord = { projectKey: 'PKM', slug: 'm', remote: 'x', harnessId: 'hA', linkedAt: 'l', cwd }
  const storeDir = path.join(cwd, '.dsh-chapters')
  captureMinedRules({
    storeDir, harnessId: 'hA', sessionId: 'sess-me', records: new Map<string, RuleRecord>(),
    humanText: 'a sentence that mentions deploy windows only', maxPerChapter: 3,
    rules: [{ text: 'Never deploy during the Friday freeze window.', category: 'deploy', quote: 'the friday freeze is not a deploy window really' }],
  })
  let syncs = 0
  const io: RulesIo = {
    cwd: () => cwd, storeRoot: '.dsh-chapters', harnessId: 'hA',
    store: { rules: () => new Map<string, RuleRecord>().entries(), getRule: () => undefined, putRule: async () => {} },
    projectFor: () => project,
    mirrorDir: () => path.join(cwd, '.dsh-knowledge'),
    syncNow: async () => { syncs += 1 },
    now: () => new Date('2026-10-20T12:00:00Z'),
    ancestors: async () => new Set(['sess-me']),
    budgetTokens: 1200,
  }
  return { cwd, io, storeDir, syncCount: () => syncs, dispose: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

test('§7.9 list --scope session shows a suggestion as REVIEWABLE, and approve turns it on', async () => {
  const w = ioWorld()
  const listed = await rulesCommand(w.io, 'list --scope session')
  assert.equal(listed.kind, 'success', listed.text)
  assert.match(listed.text, /hA\/001\s+session\s+suggested/, listed.text)
  // inert right now
  const before = buildRulesSection(path.join(w.cwd, '.dsh-knowledge'), {
    projectKey: 'PKM', harnessId: 'hA', budgetTokens: 1200, storeDir: w.storeDir, ancestorSessions: new Set(['sess-me']),
  })
  assert.ok(before.kind === 'none' || !before.text.includes('Friday freeze'), 'not governing anything yet')
  const ap = await rulesCommand(w.io, 'approve hA/001')
  assert.equal(ap.kind, 'success', ap.text)
  assert.match(ap.text, /suggested rule hA\/001 approved/, ap.text)
  assert.match(ap.text, /stays LOCAL/, ap.text)
  const after = buildRulesSection(path.join(w.cwd, '.dsh-knowledge'), {
    projectKey: 'PKM', harnessId: 'hA', budgetTokens: 1200, storeDir: w.storeDir, ancestorSessions: new Set(['sess-me']),
  })
  assert.ok(after.kind === 'ok' && after.text.includes('Never deploy during the Friday freeze window.'), JSON.stringify(after))
  w.dispose()
})

test('§7.5 approving an already-active marker rule still refuses (approve is for suggestions)', async () => {
  const w = ioWorld()
  const dir = path.join(w.storeDir, 'rules', 'hA')
  fs.writeFileSync(path.join(dir, '002-general-marker.md'), renderRuleFile({
    number: 2, category: 'general', title: 'Marker', sourceSession: 'sess-me', at: '2026-10-20',
    body: 'A rule captured from the marker, with plenty of length.', scope: 'session', session: 'sess-me', derivedFrom: 'marker',
  }))
  const r = await rulesCommand(w.io, 'approve hA/002')
  assert.equal(r.kind, 'error', r.text)
  assert.match(r.text, /already active for this session tree — there is nothing to approve/, r.text)
  w.dispose()
})
