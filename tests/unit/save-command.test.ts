/**
 * Unit tests for /chapters-save — archive-without-child command.
 * Same world-building pattern as fork-command.test.ts; verifies that
 * chapters are written to disk and committed to session state WITHOUT
 * creating a child session.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { buildChaptersTools } from '../../src/tools.ts'
import { freshSession, type SessionState } from '../../src/registry.ts'
import type { SessionEventLike } from '../../src/types.ts'

const CONFIG = {
  artifactStoreRoot: '.dsh-chapters',
  chapterTokenTarget: 8000,
  toolResultDeferFloorTokens: 200,
  continuationBudgetRatio: 0.25,
  fallbackPreset: 'chapters',
}

const ev = (seq: number, type: string, text?: string): SessionEventLike =>
  type === 'user/message' || type === 'assistant/message'
    ? { type, seq, time: 0, surfaceOp: 'append', data: { id: `m${seq}`, role: type.split('/')[0], source: { kind: 'user' }, content: [{ type: 'text', text: text ?? `message ${seq} ${'filler words '.repeat(20)}` }] } } as SessionEventLike
    : type === 'session/title'
      ? { type, seq, time: 0, surfaceOp: 'append', data: { title: text ?? 'Parent Title' } } as SessionEventLike
      : { type, seq, time: 0, data: { turn: 1 } } as SessionEventLike

const conversation = (): SessionEventLike[] => [
  ev(0, 'session/title', 'Research notes'), ev(1, 'user/message'), ev(2, 'assistant/message'),
  ev(3, 'user/message'), ev(4, 'assistant/message'), { type: 'turn/end', seq: 5, data: {} } as SessionEventLike,
  ev(6, 'user/message'), ev(7, 'assistant/message'), { type: 'turn/end', seq: 8, data: {} } as SessionEventLike,
]

function makeWorld(opts: { events?: SessionEventLike[]; parentChapters?: Array<{ number: number; path: string; title: string; summary: string; startSeq: number; endSeq: number }> } = {}) {
  const tmp = path.join(os.tmpdir(), `chapters-save-${Math.random().toString(36).slice(2)}`)
  const states = new Map<string, SessionState>()
  const createRequests: Array<Record<string, unknown>> = []
  const caller = {
    id: 'caller-1',
    options: { provider: 'local', model: 'qwen3.8-flash-next' },
    session: {
      id: 'caller-1',
      header: { cwd: tmp },
      snapshotEvents: () => opts.events ?? conversation(),
    },
  }
  const ctx = {
    get: (_name: string) => undefined,
    sessionProjections: { stateOf: (_s: unknown, key: string) => (key === 'agentPreset' ? 'chapters' : undefined) },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 65536 } }) },
    agents: { create: async (req: Record<string, unknown>) => { createRequests.push(req); return { dispose: async () => {} } } },
    logger: { warn: (_m: string) => {} },
  }
  const store = {
    get: async (id: string) => states.get(id) ?? (opts.parentChapters && id === 'caller-1'
      ? { ...freshSession(id), chapters: opts.parentChapters, nextChapterNumber: opts.parentChapters.length + 1 }
      : freshSession(id)),
    put: async (id: string, s: SessionState) => { states.set(id, s) },
  }
  const built = buildChaptersTools(ctx as never, store as never, CONFIG as never)
  return { built, caller, states, createRequests, tmp }
}

test('save: archives chapters to disk without creating a child session', async () => {
  const w = makeWorld()
  const result = await w.built.saveCommand.handler({ agent: w.caller as never, rawInput: '' })
  assert.equal(result.kind, 'success')
  // No child created — the whole point of /chapters-save
  assert.equal(w.createRequests.length, 0, 'must NOT create a child session')
  // Chapters committed to session state
  const state = w.states.get('caller-1')
  assert.ok(state !== undefined, 'session state was updated')
  assert.ok(state!.chapters.length >= 1, 'at least one chapter recorded')
  // Chapter files exist on disk
  const chapterPath = path.join(w.tmp, state!.chapters[0]!.path)
  assert.ok(fs.existsSync(chapterPath), `chapter file exists at ${chapterPath}`)
  const body = fs.readFileSync(chapterPath, 'utf8')
  assert.match(body, /message 1 /, 'verbatim content archived')
})

test('save: success text reports chapter count and searchability', async () => {
  const w = makeWorld()
  const result = await w.built.saveCommand.handler({ agent: w.caller as never, rawInput: '' })
  assert.equal(result.kind, 'success')
  const text = result.text ?? ''
  assert.match(text, /Saved:/, 'reports saved')
  assert.match(text, /chapter\(s\)/, 'reports count')
  assert.match(text, /chapters_search/, 'mentions searchability')
})

test('save: idempotent — nothing new since last save reports existing chapters', async () => {
  const priorChapter = {
    number: 1,
    path: '.dsh-chapters/caller-1/chapters/001-prior.md',
    title: 'Prior',
    summary: 'all of it',
    startSeq: 0,
    endSeq: 8,
  }
  const w = makeWorld({ parentChapters: [priorChapter] })
  const result = await w.built.saveCommand.handler({ agent: w.caller as never, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text ?? '', /Nothing to save/i)
  assert.equal(w.createRequests.length, 0)
})

test('save: respects watermark — only archives events after last saved chapter', async () => {
  const priorChapter = {
    number: 1,
    path: '.dsh-chapters/caller-1/chapters/001-compacted.md',
    title: 'Compacted span',
    summary: 'events through 5',
    startSeq: 0,
    endSeq: 5,
  }
  const w = makeWorld({ parentChapters: [priorChapter] })
  const result = await w.built.saveCommand.handler({ agent: w.caller as never, rawInput: '' })
  assert.equal(result.kind, 'success')
  const state = w.states.get('caller-1')!
  assert.equal(state.chapters.length, 2, 'one new chapter appended')
  const fresh = state.chapters[1]!
  assert.equal(fresh.number, 2)
  assert.equal(fresh.startSeq, 6, 'new chapter starts after watermark')
})

test('save: no completed turn returns clean error', async () => {
  const w = makeWorld({ events: [ev(0, 'user/message')] })
  const result = await w.built.saveCommand.handler({ agent: w.caller as never, rawInput: '' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /no completed turn/)
  assert.equal(w.createRequests.length, 0)
})

test('save: triggers enrichment when available', async () => {
  let enrichCalled = false
  const w = makeWorld()
  // Inject enrich surface into config
  const configWithEnrich = { ...CONFIG, enrich: { runNow: async () => { enrichCalled = true; return { processed: 1, remaining: 0 } } } }
  const built = buildChaptersTools(
    { get: () => undefined, sessionProjections: { stateOf: () => undefined }, llm: { resolveModelInfo: async () => ({ context: { contextWindow: 65536 } }) }, agents: { create: async () => ({ dispose: async () => {} }) }, logger: { warn: () => {} } } as never,
    { get: async () => freshSession('caller-1'), put: async () => {} } as never,
    configWithEnrich as never,
  )
  const caller = {
    id: 'caller-1',
    options: { provider: 'local', model: 'm' },
    session: { id: 'caller-1', header: { cwd: w.tmp }, snapshotEvents: () => conversation() },
  }
  const result = await built.saveCommand.handler({ agent: caller as never, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.ok(enrichCalled, 'enrichment was triggered')
  assert.match(result.text ?? '', /enriched/, 'success text mentions enrichment')
})
