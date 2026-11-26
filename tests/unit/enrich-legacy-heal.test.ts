// #557 (completing #550): the LIVE registry had zero rows carrying `cwd` (two writer paths never
// stamped, pre-#348 rows never backfilled), so the row-first fix could not reach the exact case it
// was written for. Present-is-proof: the ladder now tries row → process → the registry's own
// project roots, and where the file EXISTS, stamps the row with the root that resolved it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEnrichWiring, type EnrichWiringDeps } from '../../src/enrich-wire.ts'
import { sha256 } from '../../src/render.ts'
import { withMutate } from '../fake-store.ts'

const chapterText = `---\ntitle: "legacy fragment"\nsummary: deterministic summary text\ntopics: ["src/a.ts"]\n---\n# Topic\n\n**User:** always run the tape replay before cutting a tag\n\n**Assistant:** done: pushed a tag\n`
const answer = async () => '{"title":"Enriched","summary":"A summary that is informative.","topics":["auth"],"rules":[]}'

test('#557: an unstamped legacy row is located by a PROJECT ROOT, enriched, and STAMPED from the resolved read', async () => {
  const wsOwn = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-own-'))
  const wsProc = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-proc-'))
  const rel = '.dsh-chapters/sess-legacy/chapters/001-topic.md'
  fs.mkdirSync(path.join(wsOwn, '.dsh-chapters', 'sess-legacy', 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(wsOwn, rel), chapterText)
  const state: Record<string, unknown> = {
    // NO cwd field — the live pre-#348 shape
    chapters: [{ number: 1, path: rel, title: 'legacy fragment', summary: 'deterministic summary text', topics: ['src/a.ts'], sha256: sha256(chapterText) }],
  }
  const settings = new Map<string, string>()
  const store = withMutate({
    get: async () => state,
    put: async (_id: string, next: Record<string, unknown>) => { Object.assign(state, next) },
    sessions: () => [['sess-legacy', state]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k),
    putSetting: async (k: string, v: string) => { settings.set(k, v) },
  }) as unknown as EnrichWiringDeps['store']
  try {
    const w = createEnrichWiring({
      store,
      cwd: () => wsProc, // process is armed to the WRONG workspace (no such file there)
      projectCwds: () => [wsOwn], // the registry's own project table offers the right root
      config: { enabled: true, model: 'p/m1', trigger: 'both', idleMs: 10, batchCap: 5, mineCap: 3 },
      fetch: answer,
      conversationRoute: () => ({ provider: 'p', model: 'm1' }),
      log: () => {}, warn: () => {}, setTimer: () => ({ cancel: () => {} }),
    })
    const r = await w.runNow()
    assert.equal(r.processed, 1, 'located via the project root — the live phantom skip cannot survive this')
    assert.equal(state.cwd, wsOwn, 'the row is STAMPED with the root that resolved it (fact, not guess)')
    assert.ok(fs.readFileSync(path.join(wsOwn, rel), 'utf8').includes('title: "Enriched"'))
  } finally { fs.rmSync(wsOwn, { recursive: true, force: true }); fs.rmSync(wsProc, { recursive: true, force: true }) }
})

test('#557: nowhere-resolving rows refuse naming EVERY root tried — never the bare phantom "absent"', async () => {
  const wsProc = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-none-'))
  const rel = '.dsh-chapters/sess-x/chapters/001-topic.md'
  const state: Record<string, unknown> = {
    chapters: [{ number: 1, path: rel, title: 't', summary: 's', topics: [], sha256: sha256(chapterText) }],
  }
  const settings = new Map<string, string>()
  const logs: string[] = []
  const store = withMutate({
    get: async () => state,
    put: async () => {}, sessions: () => [['sess-x', state]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k), putSetting: async (k: string, v: string) => { settings.set(k, v) },
  }) as unknown as EnrichWiringDeps['store']
  try {
    await createEnrichWiring({
      store, cwd: () => wsProc, projectCwds: () => [],
      config: { enabled: true, model: 'p/m1', trigger: 'both', idleMs: 10, batchCap: 5, mineCap: 3 },
      fetch: answer, conversationRoute: () => ({ provider: 'p', model: 'm1' }),
      log: (m) => { logs.push(m) }, warn: () => {}, setTimer: () => ({ cancel: () => {} }),
    }).runNow()
    assert.match(logs.join('\n'), /absent under the row, process, and project roots/, 'the skip names the full search it did')
    assert.equal(state.cwd, undefined, 'no stamp from a failed search — present-is-proof only')
  } finally { fs.rmSync(wsProc, { recursive: true, force: true }) }
})

test('#557: the boot witness row is never enrichment material (it names no file)', async () => {
  const settings = new Map<string, string>()
  const witnessState: Record<string, unknown> = {
    chapters: [{ number: 1, path: '.dsh-chapters/dsh-chapters-witness/chapters/001-witness.md', title: 'witness', summary: 'first boot x', topics: [], sha256: '0'.repeat(64) }],
  }
  const store = withMutate({
    get: async () => witnessState,
    put: async () => {}, sessions: () => [['dsh-chapters-witness', witnessState]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k), putSetting: async () => {},
  }) as unknown as EnrichWiringDeps['store']
  const logs: string[] = []
  const w = createEnrichWiring({
    store, cwd: () => '/nonexistent',
    config: { enabled: true, model: 'p/m1', trigger: 'both', idleMs: 10, batchCap: 5, mineCap: 3 },
    fetch: async () => { throw new Error('the ladder must never ask the model for a witness row') },
    conversationRoute: () => ({ provider: 'p', model: 'm1' }),
    log: (m) => { logs.push(m) }, warn: () => {}, setTimer: () => ({ cancel: () => {} }),
  })
  const r = await w.runNow()
  assert.equal(r.processed, 0)
  assert.equal(r.remaining, 0, 'the witness row does not even count as pending — excluded at the source')
})
