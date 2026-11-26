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

/** #565: run is a BACKGROUND drain — await completion on microtasks only (fakes resolve
 * without timers; #456 ratchet honored). */
async function pump(w: { isDraining(): boolean }): Promise<void> {
  for (let i = 0; i < 400 && w.isDraining(); i += 1) for (let j = 0; j < 6; j += 1) await Promise.resolve()
}

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
    w.runNow()
    await pump(w)
    assert.equal(w.isDraining(), false, 'located via the project root — the live phantom skip cannot survive this')
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
    const noneW = createEnrichWiring({
      store, cwd: () => wsProc, projectCwds: () => [],
      config: { enabled: true, model: 'p/m1', trigger: 'both', idleMs: 10, batchCap: 5, mineCap: 3 },
      fetch: answer, conversationRoute: () => ({ provider: 'p', model: 'm1' }),
      log: (m) => { logs.push(m) }, warn: () => {}, setTimer: () => ({ cancel: () => {} }),
    })
    noneW.runNow()
    await pump(noneW)
    assert.match(logs.join('\n'), /absent under the row, process, project roots, and session header/, "#561: the skip names the FULL search, session header included")
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
  const rep = await w.runNow()
  assert.equal(rep.draining, true, 'the run starts a background drain')
  assert.equal(await w.pendingCount(), 0, 'the witness row does not even count as pending — excluded at the source')
})

test('#561: an UNLINKED workspace heals from the row\'s own session header (projects table cannot name it)', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const { createEnrichWiring } = await import('../../src/enrich-wire.ts')
  const { sha256 } = await import('../../src/render.ts')
  const { withMutate } = await import('../fake-store.ts')
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'hdr-own-')), proc = fs.mkdtempSync(path.join(os.tmpdir(), 'hdr-proc-'))
  const rel = '.dsh-chapters/sess-unlinked/chapters/001-topic.md'
  fs.mkdirSync(path.join(own, '.dsh-chapters', 'sess-unlinked', 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(own, rel), chapterText)
  const state: Record<string, unknown> = { chapters: [{ number: 1, path: rel, title: 'legacy fragment', summary: 'deterministic summary text', topics: ['src/a.ts'], sha256: sha256(chapterText) }] }
  const settings = new Map<string, string>()
  const store = withMutate({
    get: async () => state,
    put: async (_id: string, next: Record<string, unknown>) => { Object.assign(state, next) },
    sessions: () => [['sess-unlinked', state]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k), putSetting: async (k: string, v: string) => { settings.set(k, v) },
  }) as any
  try {
    const hdr = createEnrichWiring({
      store, cwd: () => proc, projectCwds: () => [], // the live dsh-chapters shape: NO project record
      sessionCwdOf: async (sid) => sid === 'sess-unlinked' ? own : undefined,
      config: { enabled: true, model: 'p/m1', trigger: 'both', idleMs: 10, batchCap: 5, mineCap: 3 },
      fetch: answer, conversationRoute: () => ({ provider: 'p', model: 'm1' }),
      log: () => {}, warn: () => {}, setTimer: () => ({ cancel: () => {} }),
    } as never)
    hdr.runNow()
    await pump(hdr as unknown as { isDraining(): boolean })
    assert.equal(state.cwd, own, 'the session header located the unlinked workspace and the row stamped')
  } finally { fs.rmSync(own, { recursive: true, force: true }); fs.rmSync(proc, { recursive: true, force: true }) }
})

test('#561: nowhere-found refusal names the session header among the sources tried', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const { createEnrichWiring } = await import('../../src/enrich-wire.ts')
  const { withMutate } = await import('../fake-store.ts')
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'hdr-none-'))
  const state: Record<string, unknown> = { chapters: [{ number: 1, path: '.dsh-chapters/sess-z/chapters/001-x.md', title: 't', summary: 's', topics: [], sha256: '0'.repeat(64) }] }
  const settings = new Map<string, string>()
  const logs: string[] = []
  const store = withMutate({
    get: async () => state, put: async () => {},
    sessions: () => [['sess-z', state]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k), putSetting: async () => {},
  }) as any
  try {
    const ref = createEnrichWiring({
      store, cwd: () => proc, projectCwds: () => [], sessionCwdOf: async () => proc,
      config: { enabled: true, model: 'p/m1', trigger: 'both', idleMs: 10, batchCap: 5, mineCap: 3 },
      fetch: answer, conversationRoute: () => ({ provider: 'p', model: 'm1' }),
      log: (m) => { logs.push(m) }, warn: () => {}, setTimer: () => ({ cancel: () => {} }),
    } as never)
    ref.runNow()
    await pump(ref as unknown as { isDraining(): boolean })
    assert.match(logs.join('\n'), /row, process, project roots, and session header/, 'the refusal states the full search')
    assert.equal(state.cwd, undefined, 'a failed search stamps nothing')
  } finally { fs.rmSync(proc, { recursive: true, force: true }) }
})
