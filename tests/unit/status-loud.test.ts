/**
 * `/chapters-status` prints its whole block in EVERY state (#61).
 *
 * The old shape was an early return: an unlinked project got one sentence about linking and never saw
 * Enrichment, Diagnostics, Auto-save or Findings — the health lines were unreachable exactly for the
 * users who most needed them. Item 3 of the issue, verified here rather than asserted in prose.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerHostCommands } from '../../src/commands.ts'
import { freshSession, type SessionState } from '../../src/registry.ts'

type Handler = (inv: { agent: unknown; rawInput?: string }) => Promise<{ kind: string; text?: string }>

function harness(opts: { sessions?: Array<[string, SessionState]> } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'))
  const tables: Record<string, Map<string, unknown>> = { projects: new Map(), sessions: new Map(opts.sessions ?? []) }
  const domain = {
    table: (name: string) => ({
      entries: () => tables[name].entries(),
      get: (id: string) => tables[name].get(id),
      put: async (id: string, v: unknown) => { tables[name].set(id, v) },
    }),
  } as never
  const registered: Array<{ name: string; handler: Handler }> = []
  const ctx = {
    get: (n: string): unknown => n === 'commands'
      ? { register: (d: { name: string; handler: Handler }) => { registered.push(d); return () => {} } }
      : undefined,
    logger: { warn: () => {}, info: () => {} },
  }
  registerHostCommands(ctx as never, domain, {
    artifactStoreRoot: '.dsh-chapters', harnessId: 'test-machine', subagentAutoSave: true,
  })
  const status = registered.find((d) => d.name === 'chapters-status')
  assert.ok(status !== undefined, 'chapters-status must be registered')
  return { cwd, status: status.handler, dispose: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

test('an UNLINKED project still gets the whole health block (#61)', async () => {
  const h = harness()
  try {
    const r = await h.status({ agent: { session: { id: 'sess-1', header: { cwd: h.cwd }, snapshotEvents: () => [] } } })
    assert.equal(r.kind, 'success')
    const t = r.text ?? ''
    assert.match(t, /No knowledge repository is linked/, 'it says the state')
    assert.match(t, /Diagnostics:/, 'and still prints the diagnostics line')
    assert.match(t, /Auto-save:/i, 'the door-5 state')
    assert.match(t, /Findings \(registry-level/, 'and the #60 row-level findings')
    assert.match(t, /NOT checked here/, 'naming what a status CANNOT see, instead of implying it is clean')
    assert.match(t, /Enrichment|enrich/i, 'the enrichment line (unset config ⇒ stated as unwired, never omitted)')
  } finally { h.dispose() }
})

test('a long session with zero chapters is told it is not retrievable (#61)', async () => {
  const h = harness()
  try {
    const ev = (type: string, seq: number) => ({ type, seq, data: {} })
    const events = [ev('turn/start', 0), ev('user/message', 1), ev('tool/call', 2), ev('tool/result', 3), ev('turn/end', 4),
      ev('turn/start', 5), ev('user/message', 6), ev('assistant/message', 7), ev('turn/end', 8)]
    const r = await h.status({ agent: { session: { id: 'sess-big', header: { cwd: h.cwd }, snapshotEvents: () => events } } })
    assert.match(r.text ?? '', /0 chapters — NOTHING it does is retrievable/,
      `the retrievability line must appear: ${(r.text ?? '').split('\n').filter((l) => /This session/.test(l)).join('|')}`)
    assert.match(r.text ?? '', /\/chapters-save/, 'and name the door that fixes it')
  } finally { h.dispose() }
})

test('a session that HAS chapters reports the count instead of alarming (#61)', async () => {
  const st: SessionState = { ...freshSession('sess-2'), rootSession: 'sess-2', chapters: [{ number: 1, path: 'p', title: 'T', summary: 's', startSeq: 0, endSeq: 4, topics: [], messages: 2, sha256: 'a'.repeat(64), estimatedTokens: 10, artifacts: [] }] }
  const h = harness({ sessions: [['sess-2', st]] })
  try {
    const events = [{ type: 'turn/end', seq: 4, data: {} }]
    const r = await h.status({ agent: { session: { id: 'sess-2', header: { cwd: h.cwd }, snapshotEvents: () => events } } })
    assert.match(r.text ?? '', /1 chapter record\(s\) archived/, `counted, not alarming: ${r.text}`)
    assert.doesNotMatch(r.text ?? '', /NOTHING it does is retrievable/)
  } finally { h.dispose() }
})

test('the row-level health counts what a row can know — and only that (#61)', async () => {
  const { registryHealth } = await import('../../src/repair.ts')
  const husk: SessionState['chapters'][number] = { number: 1, path: 'a', title: 'T', summary: 's', startSeq: 0, endSeq: 4, topics: [], messages: 0, sha256: 'a'.repeat(64), estimatedTokens: 10, artifacts: [{ path: 'e3', sha256: 'e'.repeat(64), bytes: 0 }] }
  const twin: SessionState['chapters'][number] = { ...husk, number: 1, path: 'b', messages: 2, artifacts: [] }
  const st: SessionState = { ...freshSession('S'), rootSession: 'S', chapters: [husk, twin], nextChapterNumber: 1, reservations: { 'att-9': [9] } }
  const h = registryHealth([st])
  assert.equal(h.counts.hollow, 1, 'the husk is counted')
  assert.equal(h.counts.duplicate, 1, 'the reused number is counted')
  assert.equal(h.counts.drift, 1, 'a counter at/below spent numbers is counted')
  assert.equal(h.counts.unreleased, 1, 'a reservation with no record is counted')
  assert.match(h.text, /hollow=1/, 'and it renders as text')
})
