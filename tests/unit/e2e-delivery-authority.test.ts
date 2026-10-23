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
import { humanMessageCarries, commandDispatched, countHumanMessagesCarrying, countCommandsDispatched } from '../../tests/e2e/session.ts'

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

/**
 * #84: the guard must not be able to swallow a SECOND, different instruction.
 *
 * Tonight's replay MISS is exactly this shape — a request the `suite` tape never recorded, because
 * the follow-up was judged "already delivered". Matching an 80-character window makes two prompts
 * that open alike indistinguishable, and a swallowed send is worse than a duplicated one: the leg
 * asserts against whatever the first send produced and still exits 0.
 */
const P1 = 'Read the file var/e2e-bigfile.md COMPLETELY using the read tool with ranges, then answer.'
const P2 = 'Read the file var/e2e-bigfile.md COMPLETELY using the read tool with ranges, then summarize it.'

test('two instructions sharing a long prefix are NOT the same delivery (#84)', () => {
  assert.equal(P1.slice(0, 80), P2.slice(0, 80),
    'the fixture must really collide under the old 80-char window — if this fails, the premise is gone')
  const log = line({ type: 'user/message', seq: 4, data: { message: { content: [{ type: 'text', text: P1 }] } } })
  assert.equal(humanMessageCarries(log, P2), false,
    'P1 in the log is not proof P2 was delivered; this is the swallow that broke replay')
  assert.equal(humanMessageCarries(log, P1), true, 'and the real match still works')
})

test('delivery is waited for, not assumed from a flush race (#84)', () => {
  // record and replay differ in when the durable write lands; a predicate that reads the log once
  // can answer "not delivered" in one mode and "delivered" in the other for the SAME send.
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'session.ts'), 'utf8')
  const fn = /export async function typeComposer[\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
  assert.match(fn, /waitForTimeout\(\s*GRACE|deliveredGraceMs/,
    'after a press, give the durable log a grace window before concluding it did not land')
  assert.match(fn, /for \(let round = 0; round < 48/, 'the round bound survives (the r38 busy-state tolerance)')
})

/**
 * #88 — a guard that swallows a legitimate repeat is not a guard.
 *
 * Measured: a knowledge-loop replay stalled SIXTEEN MINUTES because the spec runs `/chapters-status`
 * twice and the delivery predicate answered "already delivered" from the first record, so the second
 * send never happened. Existence answers "has something like this ever been sent"; the question at a
 * press is "has THIS press landed". Counting is the difference.
 */
const cmd = (name: string, args: string, id: string): string =>
  line({ type: 'command/run', seq: 1, data: { commandId: id, name, args } })

test('two identical commands are two deliveries, not one (#88)', () => {
  const log = [cmd('chapters-status', '', 'c-1'), cmd('chapters-status', '', 'c-2')].join('\n')
  assert.equal(countCommandsDispatched(log, 'chapters-status', ''), 2,
    'the second run is a real run; the count is what makes a repeat deliverable')
  assert.equal(commandDispatched(log, 'chapters-status', ''), true, 'the boolean is derived from the count')
  assert.equal(countCommandsDispatched(log, 'chapters-save', ''), 0, 'a different name is not this delivery')
})

test('commands are matched on full args, not a 24-character prefix (#88)', () => {
  const log = [cmd('chapters-rule', 'add security never log tokens', 'c-1')].join('\n')
  assert.equal(countCommandsDispatched(log, 'chapters-rule', 'add security never log tokens'), 1)
  assert.equal(countCommandsDispatched(log, 'chapters-rule', 'add security never log tokens and headers'), 0,
    'an args prefix that matches a DIFFERENT invocation is the #84 bug in command clothing')
})

test('a repeated human instruction counts twice (#88)', () => {
  const log = [
    line({ type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'Now answer again.' }] } } }),
    line({ type: 'user/message', seq: 5, data: { message: { content: [{ type: 'text', text: 'Now answer again.' }] } } }),
  ].join('\n')
  assert.equal(countHumanMessagesCarrying(log, 'Now answer again.'), 2)
})

test('the guard snapshots a baseline and compares counts (#88)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'session.ts'), 'utf8')
  const fn = /export function deliveredFor[\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
  assert.match(fn, /const baseline = countDeliveries\(sid, line\)/,
    'the closure must capture what existed BEFORE this press')
  assert.match(fn, /countDeliveries\(sid, line\) > baseline/,
    'and answer only for THIS press having landed — not for the instruction ever having been sent')
})
