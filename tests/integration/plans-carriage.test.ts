/**
 * PLANS CARRIAGE, end to end on the real filesystem (docs/plans-carriage.md § 3,
 * verify.md P3/P6/P8): archive a session that contains an approved plan, then
 * prove — through the SAME code paths the child uses — that
 *
 *   1. the chapter file holds a Plans block and its frontmatter declares the plan;
 *   2. the full plan bytes exist as a content-addressed artifact ON DISK;
 *   3. `chapters_artifact` resolves the cited path and can walk it (toc / search /
 *      read) without the plan ever being loaded whole — the RLM seam working on a
 *      plan exactly as it works on a 373KB book;
 *   4. the child's notice calls the plan out with a path that actually exists;
 *   5. the plan is findable through the chapter that cites it in the corpus index;
 *   6. a retry reuses numbers and does not duplicate the blob;
 *   7. a plan still in an open turn is announced as NOT ARCHIVED, and no artifact
 *      is claimed for it.
 *
 * Real ArchiveFs (node:fs under a temp workspace), real registry domain, real tool
 * wrappers; only the AGENT is faked (agents.create captures the seed event).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildChaptersTools } from '../../src/tools.ts'
import { makeDomainStore } from '../../src/store.ts'
import { resolveArtifactWithMirror, buildToc, searchArtifact } from '../../src/artifact-query.ts'
import { entryFromChapter } from '../../src/indexing.ts'
import { loadCorpus, searchKnowledge } from '../../src/search.ts'
import { updateChapterFrontmatter } from '../../src/enrich-store.ts'
import { DEFAULT_CLONE_DIR, planStoreToRepo } from '../../src/sync.ts'
import { sha256 } from '../../src/render.ts'

type Ev = { seq: number; type: string; data: Record<string, unknown> }
const ev = (seq: number, type: string, data: Record<string, unknown> = {}): Ev => ({ seq, type, data })
const human = (seq: number, text: string): Ev =>
  ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
const asst = (seq: number, text: string): Ev =>
  ev(seq, 'assistant/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })

const PLAN = [
  '# Carry session plans into chapters',
  '',
  '## Goal',
  'An approved plan survives a continuation intact.',
  '',
  '## Changes by subsystem',
  'Touch src/render.ts and src/plans.ts.',
  '',
  '## Tests',
  'P3 proves byte retrieval through chapters_artifact.',
  '',
].join('\n')
const APPROVE = '{"approved":true} Plan approved — plan mode exited; carry out the plan starting with your next step.'
const planCall = (seq: number, plan: string, callId: string): Ev =>
  ev(seq, 'tool/call', { callId, name: 'exit_plan_mode', arguments: { plan } })
const verdict = (seq: number, callId: string, text: string): Ev => ({
  seq, type: 'tool/result',
  data: {
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text }] }],
    },
  },
} as unknown as Ev)

function world(events: Ev[], sessionId = 'sess-archive') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-e2e-'))
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
  const store = makeDomainStore({ table, close: async () => {} } as never)
  const caller = {
    id: sessionId,
    options: { provider: 'local', model: 'qwen-test' },
    session: { id: sessionId, header: { cwd: tmp }, snapshotEvents: () => events },
  }
  const seeds: Array<{ sessionId: string; seed: Array<Record<string, unknown>> }> = []
  const ctx = {
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 131072 } }) },
    agents: {
      create: async (o: Record<string, unknown>) => {
        const entry: { sessionId: string; seed: Array<Record<string, unknown>>; authored?: unknown } = { sessionId: String(o.sessionId), seed: o.seed as Array<Record<string, unknown>> }
        seeds.push(entry)
        // #319 part 2: the handle authors the birth notice; record it on the entry for the assertions
        void entry
return { followup: (msg: Record<string, unknown>) => { entry.authored = msg }, dispose: async () => {} }
      },
    },
    get: () => undefined,
    sessionProjections: { stateOf: () => 'chapters' },
    logger: { info: () => undefined, warn: () => undefined },
  }
  const built = buildChaptersTools(ctx as never, store, {
    artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, toolResultDeferFloorTokens: 200,
    continuationBudgetRatio: 0.25, fallbackPreset: 'chapters', mergeThreshold: 0.3, chapterLimit: 8000,
    planInlineChars: 900, callArgArtifactTokens: 0, plansInNotice: true,
  } as never)
  const noticeText = (): string => {
    // #319 part 2: the TOC rides the AUTHORED first-turn message, not the seed
    const authored = (seeds[0] as unknown as { authored?: { source?: { sections?: { text?: string }[] } } } | undefined)?.authored
    return authored?.source?.sections?.[0]?.text ?? ''
  }
  return { tmp, built, exec: { agent: caller } as never, seeds, noticeText, store }
}

const ARCHIVED = [
  human(0, 'design how an approved plan survives a continuation'),
  ev(1, 'plan/mode', { active: true }),
  planCall(2, PLAN, 'c2'),
  verdict(3, 'c2', APPROVE),
  asst(4, 'approved; implementing now'),
  ev(5, 'turn/end', {}),
  human(6, 'carry on'),
  asst(7, 'done'),
  ev(8, 'turn/end', {}),
]
const RANGES = [{ title: 'Planning the carriage', summary: 'one approved plan', startSeq: 0, endSeq: 8 }]

test('an approved plan is archived verbatim and retrievable as an artifact (verify.md P3)', async () => {
  const w = world(ARCHIVED)
  const r = await w.built.chaptersContinue.execute({
    title: 'Carriage', handoffNote: 'continue', chapters: RANGES, toolResultOverrides: [],
  } as never, w.exec)
  assert.equal((r as { ok: boolean }).ok, true, JSON.stringify(r))

  // 1. the chapter file, on real disk
  const treeDir = path.join(w.tmp, '.dsh-chapters', 'sess-archive')
  const chapterFile = fs.readdirSync(path.join(treeDir, 'chapters')).find((f) => f.endsWith('.md'))
  assert.ok(chapterFile)
  const text = fs.readFileSync(path.join(treeDir, 'chapters', chapterFile!), 'utf8')
  assert.match(text, /## Plans in this chapter/)
  assert.match(text, /### Plan — "Carry session plans into chapters" — APPROVED/)
  assert.match(text, /^plans: \[2:approved:[0-9a-f]{8}\]$/m, 'frontmatter declares the plan')
  assert.match(text, /^planMode: active$/m, 'and the folded mode state')

  // 2. the artifact holds EVERY byte
  const state = await w.store.get('sess-archive')
  const plans = state.chapters[0]?.plans
  assert.ok(plans && plans.length === 1)
  const sha = plans[0]!.sha256
  const abs = path.join(treeDir, plans[0]!.artifactPath)
  assert.ok(fs.existsSync(abs), `${abs} must exist — the citation is not a promise`)
  assert.equal(fs.readFileSync(abs, 'utf8'), PLAN.trim(), 'byte-identical to what the model submitted')
  assert.equal(sha256(PLAN.trim()), sha)

  // 3. the RLM seam works on a plan: toc / search / read without loading it whole
  const toc = await w.built.chaptersArtifact.execute({ path: plans[0]!.artifactPath, action: 'toc' } as never, w.exec) as { toc: string[] }
  assert.deepEqual(toc.toc, ['L1 # Carry session plans into chapters', '  L3 ## Goal', '  L6 ## Changes by subsystem', '  L9 ## Tests'])
  const hit = await w.built.chaptersArtifact.execute({ path: sha, action: 'search', query: 'chapters_artifact' } as never, w.exec) as { blocks: string[] }
  assert.ok(hit.blocks.join('\n').includes('P3 proves byte retrieval'), 'search reaches the phrase by SHA alone')

  // 4. the child's notice calls it out with a path that exists on disk
  const notice = w.noticeText()
  assert.match(notice, /ACTIVE PLAN: "Carry session plans into chapters" — APPROVED/)
  const cited = /full text: (\S+\.txt)/.exec(notice)?.[1]
  assert.ok(cited)
  assert.ok(fs.existsSync(path.join(w.tmp, cited!)), `the notice path resolves from the workspace: ${cited}`)
  assert.match(notice, /ch\. 1 \.dsh-chapters\/sess-archive\/chapters\//)

  // 5. findable through the citing chapter in the two-layer index
  const cloneDir = path.join(w.tmp, DEFAULT_CLONE_DIR)
  const repoChapter = path.join(cloneDir, 'chapters', 'PK', 'sess-archive', chapterFile!)
  fs.mkdirSync(path.dirname(repoChapter), { recursive: true })
  fs.copyFileSync(path.join(treeDir, 'chapters', chapterFile!), repoChapter)
  const entry = entryFromChapter(`chapters/PK/sess-archive/${chapterFile!}`, text)
  assert.deepEqual(entry.topics.slice(0, 2), ['src/render.ts', 'src/plans.ts.'],
    'the plan\u2019s OWN file paths became the chapter topics — signature.ts already reads tool-call arguments')
  const found = searchKnowledge(cloneDir, 'carriage artifact retrieval', 400, { projectKey: 'PK' })
  assert.ok(found.results.some((x) => x.path === `chapters/PK/sess-archive/${chapterFile!}`),
    `chapters_search finds the plan through its citing chapter; got ${JSON.stringify(found.results.map((x) => x.path))}`)
  assert.equal(resolveArtifactWithMirror(path.join(w.tmp, '.dsh-chapters'), plans[0]!.artifactPath, path.join(cloneDir, 'artifacts')) !== null, true,
    'the session-tree artifact path resolves through the SAME reader chapters_artifact uses')
  fs.rmSync(w.tmp, { recursive: true, force: true })
})

test('the plan blob is PLANNED for publication — another machine can resolve the citation', async () => {
  // The guarantee "every byte remains retrievable" is cross-machine or it is
  // nothing: a chapter on machine B cites an artifacts/… path that only exists
  // where it was written unless the publisher walks the session tree. The
  // 0.1.4 audit fixed the store-root leg; the plans-carriage audit (P10) found
  // the tree leg unreadable by the reader. This row pins the writer side.
  const w = world(ARCHIVED)
  const r = await w.built.chaptersContinue.execute({
    title: 'Carriage', handoffNote: 'continue', chapters: RANGES, toolResultOverrides: [],
  } as never, w.exec)
  assert.equal((r as { ok: boolean }).ok, true, JSON.stringify(r))
  const storeDir = path.join(w.tmp, '.dsh-chapters')
  const planned = planStoreToRepo(storeDir, 'PK')
  const state = await w.store.get('sess-archive')
  const fact = state.chapters[0]!.plans![0]!
  const entry = planned.find((p) => p.rel === path.join('artifacts', 'PK', 'ab', `${fact.sha256}.txt`).replace(/\\/g, '/'))
    ?? planned.find((p) => p.rel.endsWith(`${fact.sha256}.txt`))
  assert.ok(entry, `the plan blob must be published; planned: ${planned.map((p) => p.rel).join(', ')}`)
  assert.ok(fs.readFileSync(entry!.abs, 'utf8').includes('# Carry session plans into chapters'), 'and it is the real bytes')
  // the citing chapter travels too, with its Plans block intact
  assert.ok(planned.some((p) => p.rel.startsWith('chapters/PK/') && p.rel.endsWith('.md')))
  fs.rmSync(w.tmp, { recursive: true, force: true })
})

test('a retry of the same archive reuses numbers and never duplicates the blob', async () => {
  const w = world(ARCHIVED)
  const first = await w.built.chaptersContinue.execute({
    title: 'Carriage', handoffNote: 'continue', chapters: RANGES, toolResultOverrides: [],
  } as never, w.exec)
  assert.equal((first as { ok: boolean }).ok, true)
  const treeDir = path.join(w.tmp, '.dsh-chapters', 'sess-archive')
  const chaptersBefore = fs.readdirSync(path.join(treeDir, 'chapters')).length
  const blobCount = (dir: string): number => fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.txt')).length : 0
  const blobsBefore = blobCount(path.join(treeDir, 'artifacts'))
  const second = await w.built.chaptersContinue.execute({
    title: 'Carriage', handoffNote: 'continue', chapters: RANGES, toolResultOverrides: [],
  } as never, w.exec)
  assert.equal((second as { ok: boolean }).ok, true)
  assert.equal(fs.readdirSync(path.join(treeDir, 'chapters')).length, chaptersBefore, 'the attempt key reused its numbers (append-only, no duplicate chapter)')
  assert.equal(blobCount(path.join(treeDir, 'artifacts')), blobsBefore, 'the content-addressed plan blob was not written twice')
  fs.rmSync(w.tmp, { recursive: true, force: true })
})

test('a plan above the ceiling is announced as NOT ARCHIVED and claims no artifact (verify.md P6)', async () => {
  const events: Ev[] = [
    ...ARCHIVED,
    human(9, 'now plan the rollback'),
    ev(10, 'plan/mode', { active: true }),
    planCall(11, '# Rollback plan\n\n## Goal\nUndo safely.\n', 'c11'),
  ]
  const w = world(events)
  const r = await w.built.chaptersContinue.execute({
    title: 'Carriage', handoffNote: 'continue', chapters: RANGES, toolResultOverrides: [],
  } as never, w.exec)
  assert.equal((r as { ok: boolean }).ok, true)
  const notice = w.noticeText()
  assert.match(notice, /ACTIVE PLAN: "Rollback plan" — PENDING/, 'the newest submission is the operative one')
  assert.match(notice, /## Active plan/, 'continuations get the directive section')
  assert.match(notice, /NOT ARCHIVED — parent log seq 11 only/)
  const rollbackRow = notice.split('\n').find((l) => l.includes('"Rollback plan"')) ?? ''
  assert.ok(!rollbackRow.includes('full text:'), 'no artifact promised for bytes the store does not hold')
  assert.match(notice, /do NOT implement it/i)
  // A DIFFERENT title is an independent plan, not a supersession: the approved one
  // stays cited as APPROVED with its chapter and blob (supersede is same-title only).
  assert.match(notice, /"Carry session plans into chapters" — APPROVED/)
  assert.match(notice, /2 plan\(s\) submitted on the path — 1 approved, 1 pending/)
  fs.rmSync(w.tmp, { recursive: true, force: true })
})

test('a plan-less session archives byte-for-byte the same archive shape as before the feature', async () => {
  const events: Ev[] = [human(0, 'just talk'), asst(1, 'ok'), ev(2, 'turn/end', {})]
  const w = world(events)
  const r = await w.built.chaptersContinue.execute({
    title: 'Plain', handoffNote: 'continue', chapters: [{ title: 'Talk', summary: 's', startSeq: 0, endSeq: 2 }], toolResultOverrides: [],
  } as never, w.exec)
  assert.equal((r as { ok: boolean }).ok, true)
  const treeDir = path.join(w.tmp, '.dsh-chapters', 'sess-archive', 'chapters')
  const file = fs.readdirSync(treeDir).find((f) => f.endsWith('.md'))
  const text = fs.readFileSync(path.join(treeDir, file!), 'utf8')
  assert.ok(!text.includes('Plans in this chapter'), 'no block')
  assert.ok(!/^plans: /m.test(text), 'no frontmatter line')
  assert.ok(!/^planMode: /m.test(text), 'no mode line')
  assert.ok(!w.noticeText().includes('## Plans'), 'no notice section')
  fs.rmSync(w.tmp, { recursive: true, force: true })
})

test('the plan is QUERYABLE AS A PLAN: its own document, indexed, and searched (decision 1)', async () => {
  const w = world(ARCHIVED)
  const r = await w.built.chaptersContinue.execute({
    title: 'Carriage', handoffNote: 'continue', chapters: RANGES, toolResultOverrides: [],
  } as never, w.exec)
  assert.equal((r as { ok: boolean }).ok, true, JSON.stringify(r))
  const tree = path.join(w.tmp, '.dsh-chapters', 'sess-archive', 'chapters')
  const files = fs.readdirSync(tree)
  const docName = files.find((f) => f.startsWith('plan-'))
  assert.ok(docName, `a plan document is written beside the chapter: ${files.join(', ')}`)
  assert.ok(files.some((f) => /^\d{3}-/.test(f)), 'and chapters keep their own numbering')
  const docText = fs.readFileSync(path.join(tree, docName!), 'utf8')
  assert.match(docText, /^---\nkind: plan\n/, 'the kind leads the frontmatter')
  assert.ok(docText.includes('# Carry session plans into chapters'), 'the body is the plan')

  // The pool carries it, and the corpus index reads it as a plan — the point of the
  // feature: "what did we plan about X" answers with the directive, not a transcript.
  const planned = planStoreToRepo(path.join(w.tmp, '.dsh-chapters'), 'PK')
  assert.ok(planned.some((p) => p.rel === `chapters/PK/sess-archive/${docName!}`), 'published to the pool')
  const cloneDir = path.join(w.tmp, DEFAULT_CLONE_DIR)
  const repoDoc = path.join(cloneDir, 'chapters', 'PK', 'sess-archive', docName!)
  fs.mkdirSync(path.dirname(repoDoc), { recursive: true })
  fs.copyFileSync(path.join(tree, docName!), repoDoc)
  for (const f of files.filter((x) => /^\d{3}-/.test(x))) {
    fs.copyFileSync(path.join(tree, f), path.join(cloneDir, 'chapters', 'PK', 'sess-archive', f))
  }
  const corpus = loadCorpus(cloneDir)
  const planEntry = corpus.entries.find((e) => e.kind === 'plan')
  assert.ok(planEntry, 'the index keeps kind: plan rather than flattening it to chapter')
  const found = searchKnowledge(cloneDir, 'carry session plans into chapters', 800, { projectKey: 'PK' })
  assert.ok(found.results.some((x) => x.kind === 'plan'), `search finds the plan AS a plan: ${JSON.stringify(found.results.map((x) => x.kind))}`)

  // enrichment must never annotate a directive
  const state = await w.store.get('sess-archive')
  const rec = state.chapters[0]!
  const docAbs = path.join(w.tmp, rec.planDocs![0]!.path)
  const wire = await import('../../src/enrich-wire.ts')
  assert.ok(wire, 'enrichment module loads')
  const beforeBytes = fs.readFileSync(docAbs, 'utf8')
  const written = updateChapterFrontmatter(docAbs, { generated: '[{by:"dsh-chapters"}]' })
  assert.equal(written.body.includes('# Carry session plans into chapters'), true, 'a sanctioned frontmatter write keeps the body')
  assert.equal(fs.readFileSync(docAbs, 'utf8').includes(beforeBytes.slice(beforeBytes.indexOf('\n\n') + 2).trim()), true)
  fs.rmSync(w.tmp, { recursive: true, force: true })
})

test('a superseded plan keeps BOTH documents — evolution is history, not an overwrite', async () => {
  const v1 = '# Carry plans\n\n## Goal\nFirst shape.\n'
  const v2 = '# Carry plans\n\n## Goal\nSecond shape, after the feedback.\n'
  const events: Ev[] = [
    human(0, 'plan the carriage'),
    ev(1, 'plan/mode', { active: true }),
    planCall(2, v1, 'c2'), verdict(3, 'c2', 'The user chose to keep planning; their feedback: cover rollback.', true),
    planCall(4, v2, 'c4'), verdict(5, 'c4', APPROVE),
    asst(6, 'approved'), ev(7, 'turn/end', {}),
  ]
  const w = world(events)
  const r = await w.built.chaptersContinue.execute({
    title: 'Evolution', handoffNote: 'go', chapters: [{ title: 'Planning', summary: 's', startSeq: 0, endSeq: 7 }], toolResultOverrides: [],
  } as never, w.exec)
  assert.equal((r as { ok: boolean }).ok, true, JSON.stringify(r))
  const tree = path.join(w.tmp, '.dsh-chapters', 'sess-archive', 'chapters')
  const docs = fs.readdirSync(tree).filter((f) => f.startsWith('plan-')).sort()
  assert.equal(docs.length, 2, 'both submissions survive as documents')
  const bodies = docs.map((f) => fs.readFileSync(path.join(tree, f), 'utf8'))
  assert.match(bodies[0]!, /^status: superseded$/m, 'the first records what happened to it')
  assert.match(bodies[1]!, /^status: approved$/m, 'the second carries the verdict')
  assert.ok(!bodies[0]!.includes('Second shape'), 'nothing was rewritten in place')
  const state = await w.store.get('sess-archive')
  assert.equal(state.nextPlanNumber, 3, 'two plan numbers spent, chapter numbering untouched')
  assert.equal(state.nextChapterNumber, 2)
  fs.rmSync(w.tmp, { recursive: true, force: true })
})
