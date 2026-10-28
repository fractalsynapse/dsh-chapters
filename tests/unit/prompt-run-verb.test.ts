/**
 * `/chapters-prompt run` — the bar's Run button is a command, not a keystroke (#113).
 *
 * Why this plane owns it: the composer-write path (`inputActions.setDraft`) is accepted by the host and does
 * not put text in the editor on this build — measured twice — while the plugin's one dependable human-authored
 * submission is the same follow-up autorun already uses. So Run must go through the command plane, and that
 * path has to refuse in the two ways that matter: with no session scope, and with nothing on screen. A Run
 * that silently did neither would look like a dead button, which is the failure this feature has spent a day
 * producing from other causes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

const src = read('src/commands.ts')

test('the prompt command carries a run verb', () => {
  assert.match(src, /if \(verb === 'run'\) \{/, 'the verb exists at all')
})

test('run refuses without a session scope rather than guessing one', () => {
  const block = src.slice(src.indexOf("if (verb === 'run') {"), src.indexOf("if (verb === 'autorun') {"))
  assert.ok(block.includes("run needs a session scope"), `it says why: ${block.slice(0, 80)}`)
  assert.match(block, /return \{ kind: 'error'/, 'and it returns an error, not a success with nothing done')
})

test('run refuses when there is no offer on screen, through the bar access', () => {
  // The refusal lives behind bar.runNow — asserted there so the command and the store cannot disagree about
  // what "nothing to run" means.
  const idx = src.indexOf("if (verb === 'run') {")
  const block = src.slice(idx, src.indexOf("if (verb === 'autorun') {"))
  assert.match(block, /config\.prompt\.bar\.runNow\(runId\)/, 'it delegates to the single submission path')
  assert.match(block, /cannot run: /, 'the failure keeps the reason, verbatim, so the bar can show it')
})

test('the interface declares runNow so no caller can invent its own shape', () => {
  const txt = read('src/prompt-state.ts')
  assert.match(txt, /runNow\(sessionId: string\): Promise<\{ ok: boolean; text\?: string; reason\?: string \}>/,
    'the declaration is part of PromptBarAccess, not a cast at the call site')
})

test('one submission path serves both autorun and the human keystroke', () => {
  const idx = read('src/index.ts')
  assert.match(idx, /const submitOffer = \(sessionId: string, text: string\): void => \{/, 'the shared body exists once')
  assert.match(idx, /followup: submitOffer,/, 'autorun uses it')
  assert.match(idx, /submitOffer\(sessionId, st\.text\)/, 'Run uses it')
  assert.ok(!/agent\.followup\(suggestPromptMessage/.test(idx.split('const submitOffer')[1].slice(600)),
    'and there is no second copy of the follow-up call hidden in another arm')
})
