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
import { humanMessageCarries, commandDispatched, countHumanMessagesCarrying, countCommandsDispatched, adoptSessionForTurn } from '../../tests/e2e/session.ts'

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

/**
 * #77's lesson, applied to the rig: on a pristine home a draft commits under a fresh id while
 * `dsh.sessions.current` still names the draft. Measured on the cold home — the instruction at seq 10
 * and `turn/end` at seq 42, 28 s apart, in `c553d23b…`, while the spec watched `105939e9…` and timed
 * out for twelve minutes. The durable log decides which session a send lives in; the view is a hint.
 */
test('session adoption follows the durable log, not the view (#77-class, rig side)', () => {
  const turn = line({ type: 'user/message', seq: 10, data: { message: { content: [{ type: 'text', text: 'Which file defines the chapter composer merge rule? answer in one sentence.' }] } } })
  const logs: Record<string, string> = {
    'session-105939': line({ type: 'session', version: 4, id: 'session-105939' }),
    'session-c553d2': [line({ type: 'session', version: 4, id: 'session-c553d2' }), turn].join('\n'),
  }
  const readLog = (id: string): string => logs[id] ?? ''
  assert.equal(adoptSessionForTurn({ candidates: ['session-105939', 'session-c553d2'], needle: 'Which file defines the chapter composer merge rule?', readLog }),
    'session-c553d2', 'the session that HOLDS the turn wins, even though the view named the other first')
  assert.equal(adoptSessionForTurn({ candidates: ['session-c553d2', 'session-105939'], needle: 'Which file defines the chapter composer merge rule?', readLog }),
    'session-c553d2', 'and order-independently: a correct first candidate is kept')
})

test('adoption refuses to guess when no candidate holds the turn', () => {
  const empty: Record<string, string> = { 'session-a': line({ type: 'session', version: 4, id: 'session-a' }) }
  assert.equal(adoptSessionForTurn({
    candidates: ['session-a', null],
    needle: 'a message nobody received',
    readLog: (id: string) => { if (id === 'session-boom') throw new Error('unreadable'); return empty[id] ?? '' },
  }), null, 'null means the caller keeps its target and the poll fails HONESTLY — inventing an id is how a rig hides a real stall')
  assert.equal(adoptSessionForTurn({ candidates: [null, ''], needle: 'anything', readLog: () => 'x' }), null,
    'and a null/empty candidate is skipped, not read as a log')
})

test('a throwing log read is absence, not a crash', () => {
  assert.equal(adoptSessionForTurn({ candidates: ['session-boom'], needle: 'n', readLog: () => { throw new Error('zstd failed') } }), null,
    'one unreadable directory must not take the journey down with it')
})

test('newSessionWithTurn actually uses the adoption (#77-class)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'session.ts'), 'utf8')
  assert.match(src, /adoptSessionForTurn\(\{[\s\S]{0,200}readLog: sessionLogTextById/,
    'the helper must be wired where the send happens, not just exported')
  assert.match(src, /if \(adopted !== null\) sid = adopted/,
    'and it may only OVERRIDE the view, never clear a good id with null')
})

/**
 * The adoption has to reach the whole home, not just the ids the view happens to offer. Measured on
 * the rules leg (cold home, 2026-10-23): the committed session directory was `2304a071…`, holding the
 * question at seq 10 and `turn/end` at seq 21 — a completed turn the poll never saw, because every
 * candidate the view offered (draft id, rotated id) named a directory that does not exist, and
 * `sessionLogTextById` correctly answered '' for an id with no log. Twelve minutes of waiting on a
 * session that had already finished is what "the view is a hint" fails to fix when the hint is empty.
 */
test('adoption discovers the session holding the turn when the view offers nothing real', () => {
  const turn = line({ type: 'user/message', seq: 10, data: { message: { content: [{ type: 'text', text: 'Reply with exactly one short sentence naming an HTTP redirect status code.' }] } } })
  const done = line({ type: 'turn/end', seq: 21, data: { turn: 1, reason: { kind: 'completed' } } })
  const logs: Record<string, string> = {
    'session-2304a071': [line({ type: 'session', version: 4, id: 'session-2304a071' }), turn, done].join('\n'),
  }
  const got = adoptSessionForTurn({
    candidates: [null, null],                       // the view had nothing real to offer
    discover: () => ['session-2304a071'],          // the home does
    needle: 'Reply with exactly one short sentence',
    readLog: (id: string) => logs[id] ?? '',
  })
  assert.equal(got, 'session-2304a071',
    'the log that HOLDS the completed turn wins even when no candidate pointed at it')
})

test('the poll re-resolves the session on every interval, not once (#77-class)', () => {
  // The stall's shape, in one sentence: adoption ran once at send time, before the committed session
  // existed, and the poll then stared at an empty draft log while the turn finished elsewhere
  // (needle seq 10, turn/end seq 39). A single resolution is not "the durable log decides" — it is
  // the view's answer, sampled early.
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'session.ts'), 'utf8')
  const fn = /const turnSeen = \(\): boolean => \{[\s\S]*?\n  \}\n/.exec(src)?.[0] ?? ''
  assert.ok(fn.length > 0, 'the poll predicate must exist to be checked')
  assert.match(fn, /adoptSessionForTurn\(\{[\s\S]{0,220}discover: listRecentSessionIds/,
    'the predicate itself must consult the home while it waits')
  assert.match(fn, /if \(again !== null\) sid = again/, 'and only ever move to a session that holds the turn')
})

/**
 * The stall's actual root cause, third time this lesson has been paid for (#89): when the hermetic
 * move changed `boot.ts`'s home location, `session.ts` kept rebuilding `ROOT/var/e2e-home-<port>`
 * itself, so every durable-log read returned '' and a completed turn was polled for twelve minutes
 * (`home=[]` in my own diagnostic was the sentence that ended the guessing).
 */
test('the spec side never re-derives boot paths — it imports them (#89)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'session.ts'), 'utf8')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|#)/.test(l))
  const own = code.filter((l) => /e2e-home-/.test(l))
  assert.deepEqual(own, [],
    `boot paths must come from boot.ts; re-derived here they drift silently: ${JSON.stringify(own.map((l) => l.trim().slice(0, 80)))}`)
  assert.match(src, /import \{ e2eHome, rigMirrorRoot, rigStoreRoot \} from '\.\/boot\.ts'/,
    'the shared derivation must actually be imported')
  assert.match(src, /export const E2E_HOME = e2eHome\(bootPort\(\)\)/, 'the home is boot\u2019s function')
  assert.match(src, /export const E2E_STORE_ROOT = rigStoreRoot\(bootPort\(\)\)/, 'and so is the store root (#70\u2019s lesson, same class)')
})

/**
 * The session-directory scan, as behavior (measured 2026-10-27, from the clone's `home=[]` diagnostic).
 *
 * Two silent failure modes lived in `sessDirs`: returning BARE NAMES while callers did `statSync(dir)` against
 * the process cwd (discovery empty everywhere), and trusting `sessSlug(ROOT)` when the app slugs the SESSION's
 * workspace — which on a throwaway home is the host's default workspace directory. From a clone at any other
 * path, every durable-log read became '' and a-knowledge-loop polled a completed turn for 720 seconds
 * (`needle` at seq 10, `turn/end` at seq 43, both on disk the whole time). The home is per-port and disposable,
 * so nothing inside it can be another boot's: union the workspace directories, preferred first.
 */
test('session discovery finds dirs under a workspace slug that is not the repo path', async () => {
  const { sessDirsIn } = await import('../../tests/e2e/session.ts')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-scan-'))
  try {
    const base = path.join(home, 'sessions')
    const other = path.join(base, '--home-someone-else-clone--')
    const mine = path.join(base, '--home-adrian-Projects-dsh-chapters--')
    fs.mkdirSync(path.join(other, 'session-aaa11111-1111-1111-1111-111111111111'), { recursive: true })
    fs.writeFileSync(path.join(other, 'session-aaa11111-1111-1111-1111-111111111111', 'session.lock'), '')
    fs.mkdirSync(path.join(mine, 'session-bbb22222-2222-2222-2222-222222222222'), { recursive: true })
    fs.writeFileSync(path.join(mine, 'notes.txt'), 'not a session dir')

    const found = sessDirsIn(base, path.basename(mine))
    assert.ok(found.every((d) => path.isAbsolute(d)), `paths must be absolute, got ${String(found[0])}`)
    assert.equal(found.length, 2, `both workspaces belong to this boot: ${found.join(' , ')}`)
    assert.ok(found[0].endsWith('session-bbb22222-2222-2222-2222-222222222222'), 'preferred slug sorts first')
    assert.ok(found.some((d) => d.includes('session-aaa11111')), 'the other workspace is NOT ignored')
    assert.equal(sessDirsIn(path.join(home, 'absent'), 'anything').length, 0, 'a missing home is empty, not a throw')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
