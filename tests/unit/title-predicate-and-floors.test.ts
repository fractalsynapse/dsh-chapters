/**
 * One title predicate, a zero-byte defer floor, honest artifact counts, a hard oversize refusal (#59).
 *
 * Each row here traces to a measured field defect in the first project built entirely on the `chapters`
 * preset (`/home/adrian/Projects/saip`), and each was verified to fail before the change:
 *  - an injected `time-context` snapshot became a chapter TITLE, slug, filename and a live TOC
 *    citation, because title derivation carried its own regex and that regex predated the `source.kind`
 *    list (`020-time-sampled-while-preparing-turn-11-step-24-202.md`, cited in a checkpoint, never written);
 *  - hollow archives pointed at `sha256("")` — 335 references, five 0-byte files — because the renderer
 *    had no floor while `arrival.ts:63` always had one;
 *  - `artifacts: 102` reported references while the tree held one blob;
 *  - a 237,870-token chapter and eleven over 32K shipped with nothing more than a warning that was then
 *    reduced to an integer and thrown away.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { isInjectedProse } from '../../src/injections.ts'
import { deriveIdentity } from '../../src/engine-core.ts'
import { renderChapter } from '../../src/render.ts'
import { saveSession } from '../../src/save-core.ts'
import { freshSession, type SessionState } from '../../src/registry.ts'
import type { SessionEventLike } from '../../src/types.ts'

const msg = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })

// ---------------------------------------------------------------- the one predicate

test('isInjectedProse recognises every injected shape the host actually sends', () => {
  const injected: Array<[string, string]> = [
    ['time-context', 'Time sampled while preparing turn 11, step 24: 2026-10-19T16:07:01-04:00[America/New_York]'],
    ['runtime-context', 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'],
    ['reminder', '<system-reminder>\nThe following workspace instructions may be relevant\n</system-reminder>'],
    ['codegraph', '<codegraph_context note="Structural context from CodeGraph for this prompt">'],
    ['agent-message', 'Agent acdab1f5-dfe7-446e-8e5a-93451de3a0d2 sent a message: INK 8.0.0 SOURCE SPIKE'],
    ['subagent-settled', 'Background subagent d57b4710-b24e-492f-8f62-a19c359bf47d finished and will do no further work unless you send it more.'],
    ['workspace-instructions', '[workspace instructions loaded]'],
  ]
  for (const [label, text] of injected) {
    assert.equal(isInjectedProse(text), true, `${label} must be recognised as injected — it was a chapter title in the field`)
  }
  const human = ['You need to clean up old branches after you merge PRs.', 'Go ahead and make the release now.',
    'The user switched this session to plan mode.']
  for (const text of human) assert.equal(isInjectedProse(text), false, `must stay archivable prose: ${text.slice(0, 40)}`)
})

test('deriveIdentity takes the human line when an injected snapshot leads the span', () => {
  const out = deriveIdentity([
    msg('Time sampled while preparing turn 11, step 24: 2026-10-19T16:07:01-04:00[America/New_York]\nBrowser time zone for this request'),
    msg('Fix the VRAM profile so inference starts on an 8 GB card'),
  ] as never, false)
  assert.equal(out.title, 'Fix the VRAM profile so inference starts on an 8 GB card',
    'a snapshot line must never become a title/slug/filename again (#59)')
})

test('a span of only injected prose keeps the neutral fallback, not the injection', () => {
  const out = deriveIdentity([msg('Time sampled while preparing turn 1, step 1: 2026-10-21T16:21:10-04:00')] as never, false)
  assert.ok(/Conversation span|Earlier history/.test(out.title), `got ${JSON.stringify(out.title)}`)
})

test('there is exactly one injected-prose predicate in src (#59 source shape)', async () => {
  const files = fs.readdirSync(new URL('../../src/', import.meta.url)).filter((f) => f.endsWith('.ts'))
  const holders: string[] = []
  for (const f of files) {
    const text = await fs.readFileSync(new URL(`../../src/${f}`, import.meta.url), 'utf8')
    // a second pattern list, hand-rolled, is how the title screen drifted behind the body screen
    if (/system reminder\\b|Time sampled while preparing|current runtime context\\./i.test(text) && f !== 'injections.ts') {
      holders.push(f)
    }
  }
  assert.deepEqual(holders, [], `injected-shape patterns live only in injections.ts; found: ${holders.join(', ')}`)
  const derive = await fs.readFileSync(new URL('../../src/engine-core.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(derive, /HARNESS_PROSE/, 'the duplicated regex must be gone, not merely unused')
  assert.match(derive, /isInjectedProse/, 'and deriveIdentity must call the one predicate')
})

// ---------------------------------------------------------------- zero-byte floor

function toolSpan(result: string): SessionEventLike[] {
  return [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'running' }] } } },
    { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'bash', arguments: '{"command":"true"}' } },
    { type: 'tool/result', seq: 4, data: { message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: result }] }] } } },
    { type: 'turn/end', seq: 5, data: { turn: 1 } },
  ]
}
const range = { title: 'T', summary: 's', startSeq: 0, endSeq: 5 }
const cfg = { toolResultDeferFloorTokens: 200, chapterTokenTarget: 8000 }

test('an empty tool result defers NOTHING and says so plainly', () => {
  const out = renderChapter(toolSpan(''), range, cfg, [], [])
  assert.equal(out.artifacts.length, 0, 'a 0-byte result must not create an artifact reference (#59)')
  assert.match(out.markdown, /result \(seq 4, empty\)/, 'the body names the empty result instead of citing sha256("")')
  assert.doesNotMatch(out.markdown, /e3b0c442/, 'the empty-string hash must never be cited as knowledge')
})

test('artifacts: counts distinct blobs and artifactRefs: counts references', () => {
  // the same big result twice — content-addressed, so one blob and two references
  const big = 'x'.repeat(4000)
  const events = toolSpan(big).concat([
    { type: 'tool/call', seq: 6, data: { callId: 'c2', name: 'bash', arguments: '{"command":"again"}' } },
    { type: 'tool/result', seq: 7, data: { message: { role: 'tool', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: big }] }] } } },
  ])
  const out = renderChapter(events as never, { title: 'T', summary: 's', startSeq: 0, endSeq: 7 } as never, cfg, [], [])
  const shas = out.artifacts.map((a) => a.sha256)
  assert.equal(out.markdown.includes(`artifacts: ${new Set(shas).size}`), true, `artifacts: must be distinct blobs, got:\n${out.markdown.split('\n').slice(0, 12).join('\n')}`)
  assert.match(out.markdown, /artifactRefs: 2/, 'and the total reference count must be stated separately')
})

// ---------------------------------------------------------------- oversize refusal

test('a range far over chapterTokenTarget is REFUSED with its number, before any reservation', async () => {
  const states = new Map<string, SessionState>()
  const store = {
    get: async (id: string) => states.get(id) ?? freshSession(id),
    put: async (id: string, s: SessionState) => { states.set(id, s) },
    mutate: async (id: string, fn: (s: SessionState) => SessionState) => { const n = fn(await store.get(id)); states.set(id, n); return n },
  } as never
  const filler = 'word '.repeat(30000) // a single enormous assistant turn
  const events: SessionEventLike[] = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'archive me whole' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: filler }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ]
  const tmp = fs.mkdtempSync('/tmp/oversize-')
  const out = await saveSession({
    events, sessionId: 'S', cwd: tmp, store,
    config: { artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, chapterOversizeFactor: 2, toolResultDeferFloorTokens: 200, mergeThreshold: 0.3, chapterLimit: 8000 } as never,
  })
  assert.equal(out.skipped, 'oversize', `expected an oversize refusal, got ${JSON.stringify(out.skipped)}`)
  assert.ok(out.warnings.some((w) => /est tokens|chapterTokenTarget/.test(w)), 'the refusal must carry its numbers')
  assert.equal((await store.get('S')).nextChapterNumber, 1, 'no number was spent on a refused archive')
  assert.equal(fs.existsSync(`${tmp}/.dsh-chapters/S/chapters`), false, 'and no file was written')
})

test('a modest overshoot still archives — the factor separates warn from refuse', async () => {
  const states = new Map<string, SessionState>()
  const store = {
    get: async (id: string) => states.get(id) ?? freshSession(id),
    put: async (id: string, s: SessionState) => { states.set(id, s) },
    mutate: async (id: string, fn: (s: SessionState) => SessionState) => { const n = fn(await store.get(id)); states.set(id, n); return n },
  } as never
  const events: SessionEventLike[] = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'short ask' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'short answer' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ]
  const tmp = fs.mkdtempSync('/tmp/modest-')
  const out = await saveSession({
    events, sessionId: 'S', cwd: tmp, store,
    config: { artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, chapterOversizeFactor: 2, toolResultDeferFloorTokens: 200, mergeThreshold: 0.3, chapterLimit: 8000 } as never,
  })
  assert.equal(out.skipped, null, 'a normal chapter still archives')
})

test('#58 gate vs #60 split: a TOOL-ONLY part archives; a wholly payloadless read still refuses (#60)', async () => {
  const { saveSession } = await import('../../src/save-core.ts')
  const tmp = fs.mkdtempSync('/tmp/partial-')
  const mk = (events: never[]) => {
    const states = new Map<string, any>()
    const store = {
      get: async (id: string) => states.get(id) ?? freshSession(id),
      put: async (id: string, s: any) => { states.set(id, s) },
      mutate: async (id: string, fn: (s: any) => any) => { const n = fn(await store.get(id)); states.set(id, n); return n },
    }
    return { store: store as never, states, events, tmp }
  }
  const cfg = { artifactStoreRoot: '.dsh-chapters', chapterTokenTarget: 8000, chapterOversizeFactor: 2, toolResultDeferFloorTokens: 200, mergeThreshold: 0.3, chapterLimit: 8000 } as never

  // (a) a repair split whose part 2 holds only tool calls: it must ARCHIVE, and say which part is dry.
  const mixed = mk([
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'run the migration' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'running' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ] as never[])
  const outA = await saveSession({ events: mixed.events, sessionId: 'S', cwd: mixed.tmp, store: mixed.store, config: cfg, span: { fromSeq: 0, toSeq: 3 } })
  assert.equal(outA.skipped, null, 'a span with real messages archives')

  // (b) the #58 shape: event SHAPES with no payloads at all — refuse, reserve nothing.
  const shells = mk([
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: {} },
    { type: 'assistant/message', seq: 2, data: {} },
    { type: 'tool/call', seq: 3, data: { callId: 'c', name: 'bash' } },
    { type: 'tool/result', seq: 4, data: {} },
    { type: 'turn/end', seq: 5, data: { turn: 1 } },
  ] as never[])
  const outB = await saveSession({ events: shells.events, sessionId: 'S', cwd: shells.tmp, store: shells.store, config: cfg })
  assert.equal(outB.skipped, 'payloadless', 'a wholly payloadless read is still refused (#58)')
  // read it back through the STORE: a refusal writes nothing, so the map has no row — which is itself
  // the proof. `get` falls back to a fresh state, whose counter is still 1: nothing was spent.
  assert.equal((await shells.store.get('S')).nextChapterNumber, 1, 'and no number was spent')
  assert.equal(shells.states.size, 0, 'and no state was written at all')
})
