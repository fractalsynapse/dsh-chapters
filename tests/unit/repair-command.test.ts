/**
 * `/chapters-repair` — the operator door (#60).
 *
 * Three things these rows insist on: the default is READ-ONLY; a run that changes something journals it
 * and says so; and the durable log is read through the ONE seam door 5 uses (`readDurableSession`), not
 * re-implemented here — the duplicated read is exactly what produced 12 empty chapters (#58).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { buildChaptersTools } from '../../src/tools.ts'
import { freshSession, type ChapterRecord, type SessionState } from '../../src/registry.ts'
import { withMutate } from '../fake-store.ts'

const CONFIG = {
  artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, chapterOversizeFactor: 2,
  toolResultDeferFloorTokens: 200, mergeThreshold: 0.3, chapterLimit: 8000,
  continuationBudgetRatio: 0.5, fallbackPreset: 'standard',
} as never

const turn = (t: number, base: number, subject: string): never[] => [
  { type: 'turn/start', seq: base, data: { turn: t } },
  { type: 'user/message', seq: base + 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `please ${subject}` }] } },
  { type: 'assistant/message', seq: base + 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: `doing ${subject} now with a real answer of some length` }] } } },
  { type: 'turn/end', seq: base + 3, data: { turn: t, reason: { kind: 'completed' } } },
] as never

function world(opts: { hollow?: boolean } = {}) {
  const cwd = fs.mkdtempSync(path.join('/tmp', 'repair-cmd-'))
  const events = [...turn(1, 0, 'alpha'), ...turn(2, 4, 'beta')] as never[]
  const rec = (n: number, from: number, to: number, over: Partial<ChapterRecord> = {}): ChapterRecord => ({
    number: n, path: `.dsh-chapters/root-1/chapters/00${n}-ch-${n}.md`, title: `Ch ${n}`, summary: 's',
    startSeq: from, endSeq: to, topics: ['x'], messages: 2, sha256: '0'.repeat(64), estimatedTokens: 500, artifacts: [], ...over,
  })
  const chapters = opts.hollow
    ? [rec(1, 0, 3), rec(2, 4, 7, { messages: 0 })]
    : [rec(1, 0, 3), rec(2, 4, 7)]
  const state: SessionState = { ...freshSession('root-1'), rootSession: 'root-1', nextChapterNumber: 3, chapters }
  const states = new Map<string, SessionState>([['root-1', state]])
  const tree = path.join(cwd, '.dsh-chapters', 'root-1', 'chapters')
  fs.mkdirSync(tree, { recursive: true })
  for (const c of chapters) {
    // A husk is given the REAL #58 bytes (`tool: unknown`, `arguments: {}`) rather than a bare
    // `messages: 0`. #60's audit now demands EVIDENCE of a payload-less read — zero-byte deferred blobs
    // or that signature — because a repair split legitimately yields an empty part. A fixture that only
    // sets the counter to 0 would be testing an assumption the auditor no longer makes.
    const isShell = c.messages === 0
    const body = isShell
      ? `---\ntitle: "${c.title}"\nseqRange: [${c.startSeq}, ${c.endSeq}]\ntopics: ["x"]\ntokens: 40\n---\n\n# ${c.title}\n\n\`\`\`text\n**Assistant:**\n  \u21b3 tool: unknown \`arguments: {}\`\n    result: 0 B, sha256 e3b0c442 \u2192 artifacts/e3/e3b0.txt\n\`\`\`\n`
      : `---\ntitle: "${c.title}"\nseqRange: [${c.startSeq}, ${c.endSeq}]\ntopics: ["x"]\ntokens: 500\n---\n\n**User:** please ch ${c.number}\n\n**Assistant:** answer ${c.number}\n`
    // the record carries the REAL hash of its own file: a fixture that lies about its sha produces a
    // genuine `tampered-file` finding and the run then correctly refuses it — noise that hides the
    // behaviour under test.
    c.sha256 = createHash('sha256').update(body).digest('hex')
    fs.writeFileSync(path.join(cwd, c.path), body)
  }
  const store = withMutate({
    get: async (id: string) => states.get(id) ?? freshSession(id),
    put: async (id: string, s: SessionState) => { states.set(id, s) },
    sessions: () => states.entries(),
  }) as never
  const sessionQuery = {
    readSession: async () => ({ session: { id: 'root-1', cwd, parentSession: undefined, origin: 'user', agentPreset: 'chapters' }, events }),
  }
  const ctx = { get: (n: string) => (n === 'sessionQuery' ? sessionQuery : undefined), logger: { warn: () => {}, info: () => {} } }
  const built = buildChaptersTools(ctx as never, store, CONFIG)
  const agent = { session: { id: 'root-1', header: { cwd, id: 'root-1' } }, options: {} }
  return { cwd, built, agent, states, store }
}

const run = (w: ReturnType<typeof world>, input: string) =>
  w.built.repairCommand.handler({ agent: w.agent as never, rawInput: input }) as Promise<{ kind: string; text?: string }>

test('/chapters-repair audit reports findings and writes nothing', async () => {
  const w = world({ hollow: true })
  const before = JSON.stringify(w.states.get('root-1'))
  const files = fs.readdirSync(path.join(w.cwd, '.dsh-chapters', 'root-1', 'chapters'))
  const r = await run(w, 'audit')
  assert.equal(r.kind, 'success')
  assert.match(r.text ?? '', /hollow-payload/, `the husk must be named: ${r.text}`)
  assert.match(r.text ?? '', /NOTHING WRITTEN/, 'and the read-only promise is in the output, not just the docs')
  assert.equal(JSON.stringify(w.states.get('root-1')), before, 'registry untouched')
  assert.deepEqual(fs.readdirSync(path.join(w.cwd, '.dsh-chapters', 'root-1', 'chapters')), files, 'files untouched')
  assert.ok(!fs.existsSync(path.join(w.cwd, '.dsh-chapters', 'root-1', 'repairs')), 'no journal for a read-only run')
})

test('/chapters-repair apply supersedes the husk and journals the move', async () => {
  const w = world({ hollow: true })
  const r = await run(w, 'apply all')
  const after = w.states.get('root-1')!
  assert.equal(after.chapters.find((c) => c.number === 2)?.status, 'superseded', `husk superseded: ${JSON.stringify(after.chapters.map((c) => [c.number, c.status]))}`)
  assert.match(r.text ?? '', /journalled/, 'the run says what it did')
  const dir = path.join(w.cwd, '.dsh-chapters', 'root-1', 'repairs')
  assert.ok(fs.existsSync(dir), 'a journal exists on disk')
  const st2 = await run(w, 'status')
  assert.match(st2.text ?? '', /move\(s\)/, 'status reads the journal back')
})

test('a project with no readable log refuses instead of reporting a clean store', async () => {
  const w = world({ hollow: true })
  const ctx = { get: () => undefined, logger: { warn: () => {}, info: () => {} } }
  const built = buildChaptersTools(ctx as never, w.store, CONFIG)
  const r = await built.repairCommand.handler({ agent: w.agent as never, rawInput: 'audit' }) as { kind: string; text?: string }
  assert.equal(r.kind, 'error', 'no read ⇒ refuse')
  assert.match(r.text ?? '', /readable durable log/, `and say why: ${r.text}`)
})

test('restore with an unknown journal id changes nothing', async () => {
  const w = world({ hollow: true })
  const before = JSON.stringify(w.states.get('root-1'))
  const r = await run(w, 'restore no-such-journal')
  assert.equal(r.kind, 'error')
  assert.equal(JSON.stringify(w.states.get('root-1')), before, 'and the registry did not move')
})

test('the durable log is read through ONE seam (#60 anti-drift)', async () => {
  const src = await fs.promises.readFile(new URL('../../src/tools.ts', import.meta.url), 'utf8')
  assert.match(src, /readDurableSession\(get, /, 'the repair door must call the shared read')
  assert.doesNotMatch(src, /sessionQuery[^]*readSession/, 'and never call readSession by hand (that is how #58 shipped empty chapters)')
  const auto = await fs.promises.readFile(new URL('../../src/auto-save.ts', import.meta.url), 'utf8')
  const defs = (auto.match(/sq\.readSession\(sessionId\)/g) ?? []).length
  assert.equal(defs, 1, `exactly one place in the plugin reads the durable log by hand, in readDurableSession — found ${defs}`)
})
