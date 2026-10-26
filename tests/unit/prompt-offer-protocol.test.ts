/**
 * The `GOAL:` protocol — the smallest possible way to encode "this step needs a human" in a one-line answer
 * (#113).
 *
 * Alternatives considered and rejected: a second structured auxiliary call (doubles the cost of the feature
 * that exists to spend the big model less), and heuristic detection of goal-editing language (a classifier
 * that guesses at intent is how the ghost decided to error on "nothing to offer"). A prefix the model is TOLD
 * to write is auditable, strips clean, and costs five characters of `promptMaxChars`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { classifyOffer } from '../../src/prompt-state.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

test('classifyOffer reads the prefix and hands the worker clean bytes', () => {
  assert.deepEqual(classifyOffer('GOAL: narrow the objective to the replay failures'),
    { intent: 'goal-edit', text: 'narrow the objective to the replay failures' })
  assert.deepEqual(classifyOffer('  goal :  Pause the corpus work until #108 lands  '),
    { intent: 'goal-edit', text: 'Pause the corpus work until #108 lands' }, 'case and spacing are not the contract')
  assert.deepEqual(classifyOffer('Run the eight-leg replay and report.'),
    { intent: 'worker-step', text: 'Run the eight-leg replay and report.' })
})

test('the prefix is only honoured at the start, and an empty re-cut is not a phantom offer', () => {
  assert.equal(classifyOffer('Before we GOAL: anything, run the replay').intent, 'worker-step',
    'a sentence MENTIONING the token is not a directive to change the goal — the misread would strand an offer')
  assert.equal(classifyOffer('GOAL:').intent, 'worker-step',
    'and a bare prefix with no objective must not block the loop with an offer nobody can run')
  assert.equal(classifyOffer('GOAL:').text, 'GOAL:', 'kept verbatim rather than emptied — an offer with no bytes is a bug, not a design')
})

test('the suggestion model is actually told the protocol, in the rules it receives', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'prompt.ts'), 'utf8')
  assert.match(src, /prefix it with GOAL:/, 'no protocol row is worth anything if the model was never asked to write it')
  assert.match(src, /the human sends those/, 'and it is told WHO sends a re-cut, so it does not hedge every step with the prefix')
  assert.match(src, /autorun will not/, 'and told the loop will not do it — the reason the prefix exists')
  assert.match(src, /Do not use the prefix for an ordinary next step/, 'the negative case is stated: an over-used prefix would freeze the loop')
  const backticks = (src.split('\n').find((l) => l.includes('Write the ONE next prompt')) ?? '').split('`').length - 1
  assert.equal(backticks, 2, 'the rules template must open and close exactly once — a backtick inside it silently ends the literal (I shipped that bug and typecheck caught it)')
})
