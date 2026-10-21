/**
 * #50 §7.5 — the background half: the SAME model that does the work mines the
 * standing orders out of each archived chapter and applies them, so the human
 * never has to think about it.
 *
 * POLICY, not evidence, decides whether a mined rule governs (§7.5 as amended
 * 2026-10-21). The first cut required a mined rule to quote the human's own words
 * verbatim before it could apply, and that was rejected: it makes this tier
 * redundant with the deterministic `ADD RULE:` marker, when the whole reason to
 * have the model look is that it can see a standing order coming that nobody has
 * said yet. So the quote check survives, DEMOTED to a label — `stated` vs
 * `inferred`, rendered to the human next to the rule text and its chapter — while
 * `rulesAutoActivate` (default ON) decides whether mined rules govern on arrival.
 * With it OFF, mined rules are written `reviewOnly: true` and stay inert until
 * `approve`. The controls that actually hold the risk are structural: machine-local
 * scope, never staged, 3-per-chapter and per-tier display caps, provenance
 * rendered inline, revoke one command away, and the agent naming which rules it
 * applied.
 *
 * Rows: output contract (backward-compatible), classification, BOTH activation
 * postures, dedupe/cap/numbering/redaction, the ladder (human bytes as warrant
 * evidence, gated off, unwired, dedicated model, ordering before the guarded
 * write), and the review surface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEnrichResult, buildEnrichInput, buildMineInput, parseMinedRules } from '../../src/enrich.ts'
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

test('§7.5 THE REVERSAL, PINNED: an inferred rule governs on arrival — no human said it', () => {
  // Two candidates: one backed by a human sentence, one the model judged. Under the
  // default posture BOTH govern; the only difference is the label rendered beside the
  // rule. An earlier cut of this file asserted the opposite — that assertion is what
  // the 2026-10-21 decision removed, so it is pinned here as removed.
  const w = captureWorld()
  const res = captureMinedRules({
    storeDir: w.storeDir, harnessId: 'hA', sessionId: 'sess-me', records: w.records,
    humanText: w.humanText, maxPerChapter: 3, chapterNumber: 7, autoActivate: true,
    now: () => '2026-10-20T00:00:00Z',
    rules: [
      mined('Always run the tape replay before cutting a tag.', 'always run the tape replay before cutting a tag'),
      mined('Rebase the feature branch onto staging before opening the PR.', 'phrasing found nowhere in what the human typed'),
    ],
  })
  assert.deepEqual(res, { ids: ['hA/001', 'hA/002'], stated: 1, inferred: 1, pending: 0 })
  const files = fs.readdirSync(w.rulesDir).sort()
  const stated = parseRuleFile(fs.readFileSync(path.join(w.rulesDir, files[0]!), 'utf8'))!
  const inferred = parseRuleFile(fs.readFileSync(path.join(w.rulesDir, files[1]!), 'utf8'))!
  assert.equal(stated.basis, 'stated')
  assert.equal(inferred.basis, 'inferred')
  assert.equal(inferred.reviewOnly, false, 'the warrant is a LABEL, not a lock')
  assert.equal(inferred.chapter, 7, 'and it names the chapter it came from')
  const active = collectStoreRules(w.storeDir, 'hA').filter((r) => sessionRuleActive(r, { ancestorSessions: new Set(['sess-me']), revoked: new Set() }))
  assert.equal(active.length, 2, 'both govern without a human touching either')
  w.dispose()
})

test('§7.5 the REVIEW posture is a knob, not a verdict on the quote', () => {
  // The same candidate and the same unmatched quote under two policies: inert in
  // one, governing in the other. Nothing in the quote path gates activation now —
  // `rulesAutoActivate` does.
  const off = captureWorld()
  const res = captureMinedRules({
    storeDir: off.storeDir, harnessId: 'hA', sessionId: 'sess-me', records: off.records,
    humanText: off.humanText, maxPerChapter: 3, chapterNumber: 2, autoActivate: false,
    rules: [mined('Never force-push to a shared branch.', 'we should probably never force push')],
  })
  assert.equal(res.pending, 1)
  const held = parseRuleFile(fs.readFileSync(path.join(off.rulesDir, fs.readdirSync(off.rulesDir)[0]!), 'utf8'))!
  assert.equal(held.reviewOnly, true)
  assert.equal(held.basis, 'inferred', 'still classified honestly')
  const secOff = buildRulesSection(path.join(off.dir, '.dsh-knowledge'), {
    projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200, storeDir: off.storeDir, ancestorSessions: new Set(['sess-me']),
  })
  assert.ok(secOff.kind === 'none' || !secOff.text.includes('Never force-push'), 'inert until someone approves it')

  const on = captureWorld()
  captureMinedRules({
    storeDir: on.storeDir, harnessId: 'hA', sessionId: 'sess-me', records: on.records,
    humanText: on.humanText, maxPerChapter: 3, chapterNumber: 2, autoActivate: true,
    rules: [mined('Never force-push to a shared branch.', 'we should probably never force push')],
  })
  const secOn = buildRulesSection(path.join(on.dir, '.dsh-knowledge'), {
    projectKey: 'PK', harnessId: 'hA', budgetTokens: 1200, storeDir: on.storeDir, ancestorSessions: new Set(['sess-me']),
  })
  assert.ok(secOn.kind === 'ok' && secOn.text.includes('Never force-push'), JSON.stringify(secOn))
  assert.match(secOn.text, /inferred from ch\.2 — nobody said it/, 'the head says it out loud')
  assert.match(secOn.text, /Name by id the session rule\(s\) above that actually shaped what you did/,
    'and the agent must tell the human which rules it applied (§7.5)')
  off.dispose(); on.dispose()
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

test('§7.5 the ladder hands the sink the chapter’s HUMAN bytes and the posture, and reports', async () => {
  const h = ladderHarness(minedAnswer('always run the tape replay before cutting a tag'))
  const seen: { humanText: string; autoActivate: boolean; chapter: number }[] = []
  h.deps.onMinedRules = async (a) => {
    seen.push({ humanText: a.humanText, autoActivate: a.autoActivate, chapter: a.chapterNumber })
    return { written: 1, stated: 1, inferred: 0, pending: 0 }
  }
  try {
    const r = await createEnrichWiring(h.deps).runNow()
    assert.equal(r.processed, 1, JSON.stringify(r))
    assert.equal(seen.length, 1)
    assert.match(seen[0]!.humanText, /always run the tape replay before cutting a tag/)
    assert.ok(!seen[0]!.humanText.includes('pushed and verified'), 'assistant prose is not warrant evidence: ' + seen[0]!.humanText)
    assert.equal(seen[0]!.autoActivate, true, 'the default posture reaches the sink')
    assert.equal(seen[0]!.chapter, 1)
    assert.match(h.logs.join('\n'), /rule mining sess-1#1: 1 recorded \(1 stated by you, 0 inferred, all governing now/)
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
    chapterNumber: 3, autoActivate: false,
    rules: [{ text: 'Never deploy during the Friday freeze window.', category: 'deploy', quote: 'the friday freeze is not a deploy window really' }],
  })
  let syncs = 0
  const settings = new Map<string, string>()
  const io: RulesIo = {
    cwd: () => cwd, storeRoot: '.dsh-chapters', harnessId: 'hA',
    store: { rules: () => new Map<string, RuleRecord>().entries(), getRule: () => undefined, putRule: async () => {} },
    projectFor: () => project,
    mirrorDir: () => path.join(cwd, '.dsh-knowledge'),
    syncNow: async () => { syncs += 1 },
    now: () => new Date('2026-10-20T12:00:00Z'),
    ancestors: async () => new Set(['sess-me']),
    budgetTokens: 1200,
    autoActivate: false,
    settings: { get: (k) => settings.get(k), put: async (k, v) => { settings.set(k, v) } },
  }
  return { cwd, io, storeDir, settings, syncCount: () => syncs, dispose: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

test('§7.9 list --scope session shows a held rule, and approve turns it on', async () => {
  const w = ioWorld()
  const listed = await rulesCommand(w.io, 'list --scope session')
  assert.equal(listed.kind, 'success', listed.text)
  assert.match(listed.text, /hA\/001\s+session\s+review/, listed.text)
  const before = buildRulesSection(path.join(w.cwd, '.dsh-knowledge'), {
    projectKey: 'PKM', harnessId: 'hA', budgetTokens: 1200, storeDir: w.storeDir, ancestorSessions: new Set(['sess-me']),
  })
  assert.ok(before.kind === 'none' || !before.text.includes('Friday freeze'), 'held, so it governs nothing')
  const ap = await rulesCommand(w.io, 'approve hA/001')
  assert.equal(ap.kind, 'success', ap.text)
  assert.match(ap.text, /mined rule hA\/001 approved/, ap.text)
  assert.match(ap.text, /stays LOCAL/, ap.text)
  const after = buildRulesSection(path.join(w.cwd, '.dsh-knowledge'), {
    projectKey: 'PKM', harnessId: 'hA', budgetTokens: 1200, storeDir: w.storeDir, ancestorSessions: new Set(['sess-me']),
  })
  assert.ok(after.kind === 'ok' && after.text.includes('Never deploy during the Friday freeze window.'), JSON.stringify(after))
  const act = await rulesCommand(w.io, 'active')
  assert.match(act.text, /mining posture: REVIEW — mined rules stay inert until you approve them/, act.text)
  assert.match(act.text, /of them inferred by the model, never said by you/, act.text)
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

// ---------------------------------------- the dedicated governance model (§7.5, `rulesModel`)

test('§7.5 parseMinedRules validates the mining-only answer and defaults an unknown basis to inferred', () => {
  assert.deepEqual(parseMinedRules('not json'), [])
  assert.deepEqual(parseMinedRules('{"rules":"nope"}'), [])
  const ok = parseMinedRules('{"rules":[{"text":"Always rebase onto staging before opening the PR","category":"Workflow","quote":"rebase before the PR","basis":"stated"},{"text":"Short","quote":"","basis":"magic"}]}')
  assert.equal(ok.length, 1, 'the sub-minimum candidate is dropped, not the whole answer')
  assert.equal(ok[0]!.category, 'workflow')
  assert.equal(ok[0]!.basis, 'stated', 'the model\u2019s own claim is carried (the plugin re-checks it at capture)')
})

test('§7.5 buildMineInput asks for inference, not for a quote', () => {
  const input = buildMineInput({ requests: ['the deploy window is wednesday, again'] }, 'chapter body text')
  assert.match(input, /Infer what the material implies even when nobody spelled it out/)
  assert.match(input, /must GENERALIZE beyond this chapter/)
  assert.match(input, /basis.*stated.*inferred/s, 'both warrants are offered, so inference is a legitimate answer')
  assert.match(input, /At most 3/)
})

test('§7.5 rulesModel set: a second bounded call on that route, and its answer is what gets mined', async () => {
  const calls: { prompt: string; route: unknown }[] = []
  const h = ladderHarness(async () => '{"title":"Enriched","summary":"A summary that is informative.","topics":["auth"],"rules":[{"text":"Mined by the annotation model, should be ignored","category":"c","quote":"always run the tape replay"}]}')
  h.deps.config = { ...h.deps.config, rulesModel: 'p/bigger' }
  h.deps.fetch = async (prompt, route) => {
    calls.push({ prompt, route })
    return /STANDING ORDERS/.test(prompt)
      ? '{"rules":[{"text":"Freeze deploys on wednesdays during the migration","category":"deploy","quote":"","basis":"inferred"}]}'
      : '{"title":"Enriched","summary":"A summary that is informative.","topics":["auth"]}'
  }
  let got: { rules: readonly { text: string }[] } | null = null
  h.deps.onMinedRules = async (a) => { got = { rules: a.rules }; return { written: 1, stated: 0, inferred: 1, pending: 0 } }
  try {
    await createEnrichWiring(h.deps).runNow()
    assert.equal(calls.length, 2, 'annotation pass + mining pass')
    assert.equal((calls[1]!.route as { provider: string; model: string }).model, 'bigger', 'mining runs on the configured model')
    assert.ok(got !== null, 'the sink was called')
    assert.equal((got as { rules: readonly { text: string }[] }).rules.length, 1)
    assert.match((got as { rules: readonly { text: string }[] }).rules[0]!.text, /Freeze deploys on wednesdays/, 'the dedicated model\u2019s answer wins')
    assert.ok(!JSON.stringify(got).includes('ignored'), 'the annotation pass\u2019s rules are not double-mined')
  } finally { h.dispose() }
})

test('§7.5 the settings key wins over the row, and a failing mining pass cannot break enrichment', async () => {
  const h = ladderHarness(async () => '{"title":"Enriched","summary":"A summary that is informative.","topics":["auth"],"rules":[]}')
  h.deps.store = {
    ...h.deps.store,
    getSetting: (k: string) => (k === 'rules.model' ? 'p/from-settings' : undefined),
  } as unknown as EnrichWiringDeps['store']
  let routeSeen = ''
  let boom = true
  h.deps.fetch = async (prompt, route) => {
    if (/STANDING ORDERS/.test(prompt)) {
      routeSeen = `${route?.provider}/${route?.model}`
      if (boom) throw new Error('upstream 503')
      return '{"rules":[{"text":"Run the tape replay before any tag, said the recovering pass","category":"testing","quote":"run the tape replay","basis":"stated"}]}'
    }
    return '{"title":"Enriched","summary":"A summary that is informative.","topics":["auth"]}'
  }
  const seen: number[] = []
  h.deps.onMinedRules = async (a) => { seen.push(a.rules.length); return { written: 1, stated: 1, inferred: 0, pending: 0 } }
  try {
    const r = await createEnrichWiring(h.deps).runNow()
    assert.equal(routeSeen, 'p/from-settings', 'a runtime override beats the profile row')
    assert.equal(seen.length, 0, 'a failed mining pass mines nothing')
    assert.equal(r.processed, 1, 'and the chapter was still annotated')
    boom = false
    const r2 = await createEnrichWiring(h.deps).runNow()
    assert.ok(r2.processed >= 0)
  } finally { h.dispose() }
})

test('§7.5 `/chapters-rule model` reads and sets the mining route, and `clear` puts it back', async () => {
  const w = ioWorld()
  const unset = await rulesCommand(w.io, 'model')
  assert.match(unset.text, /rules\.model: \(unset\) — mining rides the enrichment call/, unset.text)
  const set = await rulesCommand(w.io, 'model p/bigger')
  assert.equal(set.kind, 'success', set.text)
  assert.match(set.text, /rules\.model set to p\/bigger/)
  assert.equal(w.settings.get('rules.model'), 'p/bigger')
  const shown = await rulesCommand(w.io, 'model')
  assert.match(shown.text, /rules\.model: p\/bigger — one extra bounded call per chapter/, shown.text)
  const cleared = await rulesCommand(w.io, 'model clear')
  assert.match(cleared.text, /mining rides the enrichment call again/)
  assert.equal(w.settings.get('rules.model'), '')
  const noboard = ioWorld()
  noboard.io = { ...noboard.io, settings: undefined }
  const refused = await rulesCommand(noboard.io, 'model x/y')
  assert.equal(refused.kind, 'error'); assert.match(refused.text, /settings table is unavailable/)
  w.dispose(); noboard.dispose()
})
