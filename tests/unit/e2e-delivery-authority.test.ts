/**
 * #81 — "did the instruction get through?" is answered by the durable log, not the editor.
 *
 * `typeComposer` decides success from `emptied()`, and the host clears the draft asynchronously.
 * When that flush was late, the helper pressed again and the session got the SAME instruction twice
 * (`STILL-HERE` at seq 40 and again at seq 47 in one `heavy` leg). A duplicated human turn is not
 * cosmetic: it changes the request sequence a tape records, so two runs of a deterministic journey
 * differ for a reason that is neither the product nor the assertion — and it inflates a verbatim
 * archive with a turn nobody sent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { humanMessageCarries, commandDispatched } from '../../tests/e2e/session.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

const line = (o: unknown): string => JSON.stringify(o)
const LOG = [
  line({ type: 'session', version: 4, id: 'session-a' }),
  line({ type: 'user/message', seq: 1, data: { message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly the single word: STILL-HERE.' }] } } }),
  line({ type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'STILL-HERE' }] } } }),
  line({ type: 'command/run', seq: 3, data: { commandId: 'c-1', name: 'chapters-enrich', args: ' run ' } }),
].join('\n')

test('a human turn already in the log counts as delivered, and only as a human turn', () => {
  assert.equal(humanMessageCarries(LOG, 'STILL-HERE.'), true)
  assert.equal(humanMessageCarries(LOG, 'a question nobody asked'), false,
    'the needle has to actually be in a user/message')
  assert.equal(humanMessageCarries('', 'anything'), false, 'no log is not a delivery')
  assert.equal(humanMessageCarries(line({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STILL-HERE.' }] } } }), 'STILL-HERE.'), false,
    "the model echoing the phrase is NOT proof the human's send landed — this is the false positive that would reintroduce the double send as a silent no-op")
})

test('a slash command counts as delivered from its command/run, not from an editor', () => {
  assert.equal(commandDispatched(LOG, 'chapters-enrich', 'run'), true)
  assert.equal(commandDispatched(LOG, 'chapters-status', 'report'), false)
  assert.equal(commandDispatched('', 'chapters-enrich', 'run'), false)
})

test('typeComposer asks that authority before pressing again (#81)', () => {
  const src = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..', '..'), 'tests', 'e2e', 'session.ts'), 'utf8')
  const fn = /export async function typeComposer[\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
  assert.ok(fn.length > 0, 'typeComposer must still exist to be guarded')
  assert.match(fn, /alreadyDelivered|delivered\(\)/,
    'the retry loop must consult a delivery predicate before sending again')
  // the claim is placement, not spelling: the check must be the FIRST thing each round does
  assert.match(fn, /if \(await alreadyDelivered\(\)\) return\n\s*if \(await emptied\(\)\) return/,
    'the delivery check must precede the editor check in every round, not only run at the end')
})

/**
 * The drift guard. #81 was fixed for ONE call site and left the rest, which is how the re-anchored
 * `heavy` tape came to record a duplicated instruction and then fail strict replay: record-time the
 * race sent twice, only one answer was on tape, and replay — same code, different timing — asked a
 * question the corpus has no entry for. A guard that covers one of N sites is a coin flip.
 */
test('every typeComposer call in the journeys passes a delivery predicate (#81)', () => {
  const dir = path.join(ROOT, 'tests', 'e2e')
  const offenders: string[] = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.spec.ts'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    let i = 0
    for (;;) {
      const j = src.indexOf('typeComposer(', i)
      if (j < 0) break
      // walk with quotes respected: the naive paren counter ends inside a string that contains
      // a bracket, which is how this scan first "found" a broken call that was fine
      let k = j + 'typeComposer('.length
      let depth = 1
      let quote: string | null = null
      while (k < src.length && depth > 0) {
        const ch = src[k]
        if (quote !== null) {
          if (ch === '\\') k += 2
          else if (ch === quote) quote = null
        } else if (ch === '"' || ch === "'" || ch === '`') quote = ch
        else if (ch === '(') depth += 1
        else if (ch === ')') depth -= 1
        k += 1
      }
      const call = src.slice(j, k)
      const line = src.slice(0, j).split('\n').length
      const isHelperSelf = f === 'session.ts'
      if (!isHelperSelf && !call.includes('deliveredFor') && !call.includes('delivered')) {
        offenders.push(`${f}:${line}`)
      }
      i = k
    }
  }
  assert.deepEqual(offenders, [],
    `these typeComposer calls decide success from the editor instead of the durable log: ${offenders.join(', ')}`)
})
