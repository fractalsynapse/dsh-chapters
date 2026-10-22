/**
 * #71 client ghost — the pure body (src/client/prompt-ghost.ts). Same reason
 * the door runner is node-testable: the react chrome stayed in index.ts and
 * every decision lives here. Rows: the ONE visibility predicate, the gesture
 * table, the boundary reducer's race arms, both wire fetchers, and the
 * anti-dup rule (the wire is touched exactly once, and never from index.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ghostKeyAction, ghostReducer, makeModelLabelFetcher, makePromptFetcher, shouldShowGhost,
  type GhostSuggestion,
} from '../../src/client/prompt-ghost.ts'
import type { ClientRemote } from '../../src/client/doors.ts'

const SUG: GhostSuggestion = { text: 'run the migration' }

test('visibility: shown only when idle, empty, text-bearing, and boundary-open — the host placeholder agrees on whitespace-only drafts', () => {
  assert.equal(shouldShowGhost('shown', false, '', false, SUG), true)
  assert.equal(shouldShowGhost('shown', true, '', false, SUG), false, 'running hides')
  assert.equal(shouldShowGhost('shown', false, 'x', false, SUG), false, 'typed hides')
  assert.equal(shouldShowGhost('shown', false, '   ', false, SUG), false, 'whitespace-only hides (host parity)')
  assert.equal(shouldShowGhost('shown', false, '', true, SUG), false, 'an attachment is content (host parity)')
  assert.equal(shouldShowGhost('idle', false, '', false, SUG), false, 'before the answer lands')
  assert.equal(shouldShowGhost('accepted', false, '', false, SUG), false, 'accept closes the boundary')
  assert.equal(shouldShowGhost('dismissed', false, '', false, SUG), false, 'Esc closes the boundary')
  assert.equal(shouldShowGhost('refused', false, '', false, SUG), false, 'a refusal shows nothing, ever')
  assert.equal(shouldShowGhost('shown', false, '', false, null), false)
  assert.equal(shouldShowGhost('shown', false, '', false, { text: '' }), false)
})

test('gestures: ArrowRight accepts, Escape dismisses, every other key belongs to the host', () => {
  assert.equal(ghostKeyAction('ArrowRight'), 'accept')
  assert.equal(ghostKeyAction('Escape'), 'dismiss')
  for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'Tab', 'Enter', 'a', ' ']) {
    assert.equal(ghostKeyAction(key), null, `${key} is untouched`)
  }
})

test('the reducer: a late answer cannot resurrect an accepted or dismissed chip, and an idle-edge reopens the offer', () => {
  const open = ghostReducer({ phase: 'idle', boundary: 0 }, { type: 'idle-edge' })
  assert.deepEqual(open, { phase: 'idle', boundary: 1 })
  const shown = ghostReducer(open, { type: 'fetched', ok: true })
  assert.equal(shown.phase, 'shown')
  // Race: the answer lands after the human dismissed — dismiss wins, the chip stays gone.
  const dismissed = ghostReducer(open, { type: 'dismiss' })
  assert.deepEqual(ghostReducer(dismissed, { type: 'fetched', ok: true }), dismissed)
  const accepted = ghostReducer(shown, { type: 'accept' })
  assert.deepEqual(ghostReducer(accepted, { type: 'fetched', ok: false }), accepted)
  // Refusal is terminal until the NEXT boundary; a new edge clears it.
  const refused = ghostReducer(open, { type: 'fetched', ok: false })
  assert.equal(refused.phase, 'refused')
  assert.equal(ghostReducer(refused, { type: 'idle-edge' }).phase, 'idle')
})

test('the suggest fetcher: success passes the text; every failure arm answers refused and NEVER throws', async () => {
  const wire = (resp: unknown): ClientRemote => ({ commands: { execute: async () => resp as never } })
  const f = makePromptFetcher(wire({ ok: true, value: { result: { kind: 'success', text: 'do it' } } }))
  assert.deepEqual(await f('s'), { ok: true, text: 'do it' })
  const refused = makePromptFetcher(wire({ ok: true, value: { result: { kind: 'error', text: 'prompt suggestions are off' } } }))
  assert.deepEqual(await refused('s'), { ok: false, text: 'prompt suggestions are off', refused: true })
  const wireErr = makePromptFetcher(wire({ ok: false, error: { message: 'registry offline' } }))
  assert.equal((await wireErr('s')).ok, false)
  const throwing = makePromptFetcher({ commands: { execute: async () => { throw new Error('net down') } } })
  const t = await throwing('s')
  assert.equal(t.ok, false)
  assert.match(t.text, /net down/)
  const noRemote = makePromptFetcher({})
  assert.equal((await noRemote('s')).refused, true)
  // success with EMPTY text is not a suggestion (an empty ghost is a flicker bug).
  const empty = makePromptFetcher(wire({ ok: true, value: { result: { kind: 'success', text: '' } } }))
  assert.equal((await empty('s')).ok, false)
})

test('the label fetcher parses the ON sentence and tolerates everything else with null', async () => {
  const wire = (text: string, kind = 'success'): ClientRemote => ({ commands: { execute: async () => ({ ok: true, value: { result: { kind, text } } }) } })
  assert.equal(await makeModelLabelFetcher(wire('prompt model: local/qwen3.8-flash (override) — ON'))('s'), 'local/qwen3.8-flash')
  assert.equal(await makeModelLabelFetcher(wire('prompt model: OFF (unset)'))('s'), null)
  assert.equal(await makeModelLabelFetcher(wire('garbage'))('s'), null)
  assert.equal(await makeModelLabelFetcher({})('s'), null)
  assert.equal(await makeModelLabelFetcher({ commands: { execute: async () => { throw new Error('x') } } })('s'), null)
})

test('there is no second wire body: index.ts stays silent, prompt-ghost.ts holds ALL of it (two call sites, one per verb)', () => {
  const entry = readFileSync(path.resolve(import.meta.dirname, '../../src/client/index.ts'), 'utf8')
  assert.ok(!entry.includes('commands.execute'), 'index.ts must not talk to the wire itself (same rule as the doors)')
  const body = readFileSync(path.resolve(import.meta.dirname, '../../src/client/prompt-ghost.ts'), 'utf8')
  const calls = body.match(/remote\.commands\.execute/g) ?? []
  assert.equal(calls.length, 2, 'suggest + label — a third is a second body appearing')
})

test('the ghost is NOT a door row: it must not leak into the DOOR_ACTIONS table or the door runner', () => {
  const doors = readFileSync(path.resolve(import.meta.dirname, '../../src/client/doors.ts'), 'utf8')
  assert.ok(!doors.includes('chapters-prompt'), 'doors stay archive-only')
  const entry = readFileSync(path.resolve(import.meta.dirname, '../../src/client/index.ts'), 'utf8')
  assert.ok(entry.includes('makePromptFetcher'), 'the ghost fetcher is built once in apply()')
  assert.ok(entry.includes('conversation.input.overlay'), 'registered into the composer overlay slot')
})


