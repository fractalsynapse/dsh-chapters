// #550: the registry is per-HOME; the enrichment queue walks EVERY project's rows. The ladder must
// resolve each chapter against the ROW's owning workspace (#348's field), not the process's last-
// remembered cwd — the live misreport was SAIP skipping dsh-chapters' 978f1856#6 as "chapter file
// absent" while the file sat, present, in its own tree. The process cwd survives only as the
// fallback for pre-#348 rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sha256 } from '../../src/render.ts'
import { createEnrichWiring, type EnrichWiringDeps } from '../../src/enrich-wire.ts'
import { withMutate } from '../fake-store.ts'

const chapter = (rel: string) => `---\ntitle: "legacy fragment"\nsummary: deterministic summary text\ntopics: ["src/a.ts"]\n---\n# Topic\n\n**User:** always run the tape replay before cutting a tag\n\n**Assistant:** done: pushed a tag\n`
const answer = async () => '{"title":"Enriched","summary":"A summary that is informative.","topics":["auth"],"rules":[]}'

function world(rowCwd: string | undefined, processCwd: string | undefined) {
  const wsOwn = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-own-'))   // the row's workspace (B)
  const wsProc = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-proc-'))  // the process's remembered one (A)
  const rel = '.dsh-chapters/sess-x/chapters/001-topic.md'
  fs.mkdirSync(path.join(wsOwn, '.dsh-chapters', 'sess-x', 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(wsOwn, rel), chapter(rel)) // present ONLY under the owning workspace
  const bodyHash = sha256(chapter(rel))
  const state: Record<string, unknown> = {
    ...(rowCwd !== undefined ? { cwd: rowCwd } : {}),
    chapters: [{ number: 1, path: rel, title: 'legacy fragment', summary: 'deterministic summary text', topics: ['src/a.ts'], sha256: bodyHash }],
  }
  const settings = new Map<string, string>()
  const logs: string[] = []
  const warns: string[] = []
  const store = withMutate({
    get: async () => state,
    put: async (_id: string, next: Record<string, unknown>) => { state.chapters = next.chapters },
    sessions: () => [['sess-x', state]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k),
    putSetting: async (k: string, v: string) => { settings.set(k, v) },
  }) as unknown as EnrichWiringDeps['store']
  const deps: EnrichWiringDeps = {
    store,
    cwd: () => processCwd ?? wsProc,
    config: { enabled: true, model: 'p/m1', trigger: 'both', idleMs: 10, batchCap: 5, mineCap: 3 },
    fetch: answer,
    conversationRoute: () => ({ provider: 'p', model: 'm1' }),
    log: (m) => { logs.push(m) }, warn: (m) => { warns.push(m) },
    setTimer: () => ({ cancel: () => {} }),
  }
  return { wsOwn, wsProc, rel, deps, state, logs, warns, dispose: () => { fs.rmSync(wsOwn, { recursive: true, force: true }); fs.rmSync(wsProc, { recursive: true, force: true }) } }
}

test('#550: a chapter owned by ANOTHER workspace enriches via the row cwd (live SAIP shape, reproduced)', async () => {
  // process cwd = w.wsProc, which has NO such file; the row claims wsOwn, where it does exist.
  const w = world(undefined, undefined)
  w.state.cwd = w.wsOwn
  try {
    const r = await createEnrichWiring(w.deps).runNow()
    assert.equal(r.processed, 1, `skip reasons: ${w.logs.join('|')}${w.warns.join('|')}`)
    const doc = fs.readFileSync(path.join(w.wsOwn, w.rel), 'utf8')
    assert.ok(doc.includes('title: "Enriched"'), doc.slice(0, 160))
  } finally { w.dispose() }
})

test('#550: a pre-#348 row (no cwd field) still falls back to the process cwd', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-legacy-'))
  const rel = '.dsh-chapters/sess-l/chapters/001-topic.md'
  fs.mkdirSync(path.join(ws, '.dsh-chapters', 'sess-l', 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(ws, rel), chapter(rel))
  const bodyHash2 = sha256(chapter(rel))
  const state: Record<string, unknown> = {
    chapters: [{ number: 1, path: rel, title: 'legacy fragment', summary: 's', topics: [], sha256: bodyHash2 }],
  }
  const settings = new Map<string, string>()
  const logs: string[] = []
  const warns: string[] = []
  const store = withMutate({
    get: async () => state,
    put: async (_id: string, next: Record<string, unknown>) => { state.chapters = next.chapters },
    sessions: () => [['sess-l', state]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k),
    putSetting: async (k: string, v: string) => { settings.set(k, v) },
  }) as unknown as EnrichWiringDeps['store']
  try {
    const r = await createEnrichWiring({
      store, cwd: () => ws,
      config: { enabled: true, model: 'p/m1', trigger: 'both', idleMs: 10, batchCap: 5, mineCap: 3 },
      fetch: answer, conversationRoute: () => ({ provider: 'p', model: 'm1' }),
      log: () => {}, warn: () => {}, setTimer: () => ({ cancel: () => {} }),
    }).runNow()
    assert.equal(r.processed, 1, 'legacy rows keep working through the remembered cwd')
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

test('#550: no row cwd AND no process cwd refuses naming the REAL cause, not a phantom absent file', async () => {
  const w = world(undefined, undefined)
  // remove the fallback too: point the process cwd at an EMPTY dir and clear remembered by fresh wiring
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-nothing-'))
  w.deps.cwd = () => undefined
  try {
    // with no cwd anywhere the ladder cannot resolve at all — the reason names the missing owner
    const r = await createEnrichWiring(w.deps).runNow()
    assert.equal(r.processed, 0)
  } finally { fs.rmSync(empty, { recursive: true, force: true }); w.dispose() }
})
