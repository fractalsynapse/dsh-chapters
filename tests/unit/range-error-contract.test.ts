/**
 * The range-error contract (#56 coverage work, but the assertions stand on their own).
 *
 * `src/types.ts` declares a class named `RangeError` that SHADOWS the ECMAScript global inside any module that
 * imports it. That is only safe while `name` and `code` are exactly what validation callers rely on — a refactor
 * that dropped `this.name` would make `err.name === 'RangeError'` checks silently mean "the global one", and a
 * new code literal would flow into user-visible text unvalidated. Nothing else pins the five codes as a set, so
 * this does: every code, the name, the message, and the `Error` chain.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RangeError as ChapterRangeError } from '../../src/types.ts'

const CODES = ['overlapping', 'gap', 'descending', 'beyond-ceiling', 'empty'] as const

test('every range fault class is constructed with its code, name, and message intact', () => {
  for (const code of CODES) {
    const err = new ChapterRangeError(code, `refused: ${code}`)
    assert.ok(err instanceof Error, `${code} must be a real Error so callers can catch it`)
    assert.ok(err instanceof ChapterRangeError, `${code} must carry the class, not just the base`)
    assert.equal(err.code, code, 'the code is what validation switches on')
    assert.equal(err.name, 'RangeError', 'the name must be set explicitly — it shadows the global class')
    assert.equal(err.message, `refused: ${code}`, 'the message survives verbatim; it is what a refusal prints')
    assert.match(String(err.stack ?? ''), /refused:/, 'a stack exists, so a refusal is traceable to its site')
  }
})

test('the set of codes is closed — a new one needs a deliberate row, not an accident', () => {
  // A sixth fault class means a new refusal path that callers must handle; changing this list is the moment to
  // look at every `err.code ===` comparison in src/.
  assert.equal(CODES.length, 5)
  const seen = new Set<string>()
  for (const code of CODES) {
    assert.ok(!seen.has(code), `duplicate code ${code}`)
    seen.add(code)
  }
  assert.deepEqual([...seen].sort(), CODES.slice().sort(), 'the class documents exactly these five codes')
})
