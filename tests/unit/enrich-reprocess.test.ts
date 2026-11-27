// #578 rows: the human-only RULE reprocess — mines every existing chapter, touches nothing else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EnrichWiringDeps } from '../../src/enrich-wire.ts'
import { withMutate } from '../fake-store.ts'

const transcript = (title: string) => '---\ntitle: "' + title + '"\nsummary: s\ntopics: []\nsha256: x\n---\n# T\n\n**User:** never force push on staging\n\n**Assistant:** ok\n'
const planDoc = '---\ntitle: plan\nsummary: p\ntopics: []\nkind: plan\n---\n# Plan\n\n**User:** build it\n'

function mineWorld(opts: { plans?: boolean } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rep578-'))
  fs.mkdirSync(path.join(ws, '.dsh-chapters', 'sA', 'chapters'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.dsh-chapters', 'sA', 'chapters', '001-a.md'), transcript('a'))
  fs.writeFileSync(path.join(ws, '.dsh-chapters', 'sA', 'chapters', 'plan-001-directive.md'), planDoc)
  const state: Record<string, unknown> = {
    cwd: ws,
    chapters: [
      { number: 1, path: '.dsh-chapters/sA/chapters/001-a.md', title: 'a', summary: 's', topics: [], sha256: 'x', messages: 2 },
      { number: 2, path: '.dsh-chapters/sA/chapters/plan-001-directive.md', title: 'plan', summary: 'p', topics: [], sha256: 'y', messages: 2 },
    ],
  }
  const settings = new Map<string, string>([['rules.model', 'dedicated/pro-v']])
  const store = withMutate({
    get: async () => state,
    put: async (_i: string, n: Record<string, unknown>) => { Object.assign(state, n) },
    sessions: () => [['sA', state]] as Iterable<[string, unknown]>,
    getSetting: (k: string) => settings.get(k),
    putSetting: async (k: string, v: string) => { if (v === '') settings.delete(k); else settings.set(k, v) },
  }) as unknown as EnrichWiringDeps['store']
  const routesSeen: Array<{ provider: string; model: string }> = []
  const mined: unknown[] = []
  const timers: Array<() => void> = []
  const deps = {
    store, cwd: () => ws, planeId: 'test',
    config: { enabled: true, model: 'p/m', trigger: 'both' as const, idleMs: 10, batchCap: 5, mineCap: 3, rulesAutoActivate: true },
    fetch: async (_input: string, route: { provider: string; model: string }) => {
      routesSeen.push(route)
      return '{"rules":[{"text":"Never force push on staging.","category":"git","quote":"never force push on staging"}]}'
    },
    conversationRoute: () => ({ provider: 'p', model: 'm' }),
    log: () => {}, warn: () => {},
    setTimer: (fn: () => void) => { timers.push(fn); return { cancel: () => {} } },
    onMinedRules: async (a: { rules: unknown[] }) => { mined.push(...a.rules); return { written: a.rules.length, stated: a.rules.length, inferred: 0, pending: 0 } },
  } as unknown as EnrichWiringDeps
  return { ws, state, settings, store, deps, routesSeen, mined, timers }
}

const { createEnrichWiring } = await import('../../src/enrich-wire.ts')

test('#578: reprocessAll mines transcript chapters through the DEDICATED route, excludes plan docs, never writes files', async () => {
  const h = mineWorld()
  const before = fs.readFileSync(path.join(h.ws, '.dsh-chapters', 'sA', 'chapters', '001-a.md'), 'utf8')
  const w = createEnrichWiring(h.deps)
  const r = await w.reprocessAll()
  assert.equal(r.started, true)
  assert.equal(r.total, 1, 'the plan document is not mining material')
  for (let k = 0; k < 300 && w.isReprocessing(); k += 1) for (let j = 0; j < 6; j += 1) await Promise.resolve()
  assert.equal(w.isReprocessing(), false)
  assert.deepEqual(h.routesSeen.map((x) => x.provider + '/' + x.model), ['dedicated/pro-v'], 'mining rode the rules.model route')
  assert.equal(h.mined.length, 1)
  const after = fs.readFileSync(path.join(h.ws, '.dsh-chapters', 'sA', 'chapters', '001-a.md'), 'utf8')
  assert.equal(after, before, 'reprocess never touches chapter files')
  const st = JSON.parse(h.settings.get('rules.reprocess.state') ?? '{}') as { line?: string }
  assert.match(st.line ?? '', /rules\.reprocess ended: 1 chapter\(s\) mined, 1 rule\(s\) written/, st.line ?? '')
})

test('#578: lease mutual exclusion — an active enrichment drain defers reprocess BY NAME', async () => {
  const h = mineWorld()
  const w = createEnrichWiring(h.deps)
  // occupy the shared lease deterministically: a fresh foreign holder written straight to the spine
  h.settings.set('enrichment.drainLease', JSON.stringify({ plane: 'host', at: Date.now(), token: 'other' }))
  const r = await w.reprocessAll()
  assert.equal(r.started, false)
  assert.equal(r.leaseHeldBy, 'host', 'deferral names the holder')
})

test('#578: command surface — limit parsing, junk refusal, already-running and deferred messages', async () => {
  const { rulesCommand } = await import('../../src/rules-commands.ts')
  const mkIo = (resp: { started: boolean; alreadyRunning: boolean; leaseHeldBy?: string; total: number }) => ({
    cwd: () => '/tmp', storeRoot: '.dsh-chapters', harnessId: 'h',
    store: { rules: () => new Map<string, never>().entries(), getRule: () => undefined, putRule: async () => {} },
    projectFor: () => undefined, mirrorDir: () => '/tmp/m', syncNow: async () => {},
    now: () => new Date(), ancestors: async () => new Set<string>(),
    settings: { get: () => undefined, put: async () => {} },
    reprocess: async () => resp, reprocessState: () => 'processed 3/10',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  const base = mkIo({ started: true, alreadyRunning: false, total: 10 })
  const ok = await rulesCommand(base, 'reprocess')
  assert.equal(ok.kind, 'success')
  assert.match(ok.text ?? '', /across 10 chapter\(s\)/)
  const lim = await rulesCommand(mkIo({ started: true, alreadyRunning: false, total: 4 }), 'reprocess 4')
  assert.match(lim.text ?? '', /limit 4/)
  const junk = await rulesCommand(base, 'reprocess all')
  assert.equal(junk.kind, 'error')
  assert.match(junk.text ?? '', /positive whole-number/)
  const running = await rulesCommand(mkIo({ started: false, alreadyRunning: true, total: 10 }), 'reprocess')
  assert.match(running.text ?? '', /ALREADY RUNNING — processed 3\/10/)
  const deferred = await rulesCommand(mkIo({ started: false, alreadyRunning: false, leaseHeldBy: 'realm', total: 0 }), 'reprocess')
  assert.equal(deferred.kind, 'error')
  assert.match(deferred.text ?? '', /realm holds the drain lease/)
})

test('#578: the enrichment report PRINTS the resolved mining route — dedicated or riding, never silent', async () => {
  const h = mineWorld()
  const w = createEnrichWiring(h.deps)
  assert.match(w.statusLine(), /mining dedicated\/pro-v \(dedicated\)/, h.deps.store.getSetting('rules.model'))
  h.settings.delete('rules.model')
  assert.match(w.statusLine(), /mining rides annotation route/)
})
