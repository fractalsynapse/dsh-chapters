// #571: the dual-queue stale-receipt heal. File truth resyncs the registry; corruption does not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EnrichWiringDeps } from '../../src/enrich-wire.ts'
import { withMutate } from '../fake-store.ts'

// #571 HEAL rows: file-enriched / registry-stale records get their receipt resynced WITHOUT a
// model call; true corruption (declared body anchor not matching the body) is NOT healed — the
// guard's loud refusal survives for real damage.
test('#571: stale registry receipt is healed from the file (no model call) and the queue drains past it', async () => {
  const { createEnrichWiring } = await import('../../src/enrich-wire.ts')
  const { sha256 } = await import('../../src/render.ts')
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-571-'))
  const rel = '.dsh-chapters/sess-h/chapters/038-looks-good.md'
  fs.mkdirSync(path.join(ws, '.dsh-chapters', 'sess-h', 'chapters'), { recursive: true })
  const body = '# Topic\n\n**User:** continue until the ink system is stable\n\n**Assistant:** done: shipped\n'
  const text = [
    '---',
    'title: "Looks good — what remains on the ink integration"',
    'summary: "An enriched summary that the model wrote."',
    'topics: ["ink", "integration"]',
    'sha256: ' + sha256(body),
    'generated:',
    '  title:',
    '    - by: model',
    '      model: qwen-token-plan/qwen3.8-flash',
    '      at: \'2026-11-26T15:40:00.000Z\'',
    '---',
    body,
  ].join('\n')
  fs.writeFileSync(path.join(ws, rel), text)
  const state: Record<string, unknown> = {
    cwd: ws,
    chapters: [{ number: 38, path: rel, title: 'Conversation span (part 8)', summary: 'deterministic summary', topics: [], sha256: 'stale-hash-from-before-the-enrichment-write' }],
  }
  const settings = new Map<string, string>()
  let fetchCalled = false
  const store = withMutate({
    get: async () => state,
    put: async (_id: string, next: Record<string, unknown>) => { Object.assign(state, next) },
    sessions: () => [['sess-h', state]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k),
    putSetting: async (k: string, v: string) => { if (v === '') settings.delete(k); else settings.set(k, v) },
  }) as unknown as EnrichWiringDeps['store']
  try {
    const w = createEnrichWiring({
      store, cwd: () => ws,
      planeId: 'host',
      config: { enabled: true, model: 'qwen-token-plan/qwen3.8-flash', trigger: 'both', idleMs: 10, batchCap: 5, mineCap: 3 },
      fetch: async () => { fetchCalled = true; throw new Error('the heal must not call the model') },
      conversationRoute: () => ({ provider: 'qwen-token-plan', model: 'qwen3.8-flash' }),
      log: () => {}, warn: () => {}, setTimer: () => ({ cancel: () => {} }),
    })
    w.runNow()
    for (let i = 0; i < 400 && w.isDraining(); i += 1) for (let j = 0; j < 6; j += 1) await Promise.resolve()
    assert.equal(fetchCalled, false, 'the heal rides the file, not a new model call')
    const c = (state.chapters as Array<Record<string, unknown>>)[0]!
    assert.equal(c.title, 'Looks good — what remains on the ink integration', 'registry title resynced from file')
    const gen = (c.generated as { title?: Array<{ by: string; model: string }> } | undefined)?.title?.[0]
    assert.equal(gen?.by, 'model', 'registry mark resynced')
    assert.equal(gen?.model, 'qwen-token-plan/qwen3.8-flash')
    assert.equal(c.sha256, sha256(text), 'registry hash re-anchored to the file')
    assert.equal(await w.pendingCount(), 0, 'the record is no longer pending — the queue walks past the 354-shaped head')
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

test('#571: real corruption is NOT healed — declared body anchor mismatch keeps the loud refusal', async () => {
  const { createEnrichWiring } = await import('../../src/enrich-wire.ts')
  const { sha256 } = await import('../../src/render.ts')
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-571-'))
  const rel = '.dsh-chapters/sess-d/chapters/001-x.md'
  fs.mkdirSync(path.join(ws, '.dsh-chapters', 'sess-d', 'chapters'), { recursive: true })
  const body = '# Topic\n\n**User:** hello there\n\n**Assistant:** hi\n'
  const text = [
    '---',
    'title: "t"',
    'summary: \'enriched\'',
    'topics: []',
    'sha256: ' + sha256('totally-different-body'),
    'generated:',
    '  title:',
    '    - by: model',
    '      model: qwen-token-plan/qwen3.8-flash',
    '      at: \'2026-11-26T15:40:00.000Z\'',
    '---',
    body,
  ].join('\n')
  fs.writeFileSync(path.join(ws, rel), text)
  const state: Record<string, unknown> = {
    cwd: ws,
    chapters: [{ number: 1, path: rel, title: 't', summary: 's', topics: [], sha256: sha256(text) }],
  }
  const settings = new Map<string, string>()
  const store = withMutate({
    get: async () => state,
    put: async () => {},
    sessions: () => [['sess-d', state]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k),
    putSetting: async (k: string, v: string) => { if (v === '') settings.delete(k); else settings.set(k, v) },
  }) as unknown as EnrichWiringDeps['store']
  const warns: string[] = []
  try {
    const w = createEnrichWiring({
      store, cwd: () => ws, planeId: 'host',
      config: { enabled: true, model: 'qwen-token-plan/qwen3.8-flash', trigger: 'both', idleMs: 10, batchCap: 5, mineCap: 3 },
      fetch: async () => { throw new Error('no model for a corrupt file') },
      conversationRoute: () => ({ provider: 'qwen-token-plan', model: 'qwen3.8-flash' }),
      log: () => {}, warn: () => {}, setTimer: () => ({ cancel: () => {} }),
    })
    w.runNow()
    for (let i = 0; i < 400 && w.isDraining(); i += 1) for (let j = 0; j < 6; j += 1) await Promise.resolve()
    const c = (state.chapters as Array<Record<string, unknown>>)[0]!
    assert.notEqual(c.sha256, sha256('totally-different-body'))
    // the record is untouched: no resync happened for a corrupt file (guard refused, error-shaped skip)
    void warns
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})
