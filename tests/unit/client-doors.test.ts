/**
 * The client door rows — the buttons that pull the two deterministic server
 * doors (`/chapters-fork`, `/chapters-continue`). The runner is testable in
 * node because the react/primitives chrome stayed in src/client/index.ts;
 * what lives in src/client/doors.ts is the load-bearing part: which command
 * each row fires, how the reply is parsed, and that there is ONE body.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CHILD_ID, DOOR_ACTIONS, DOOR_BUILD, doorTitle, makeDoorRunner,
  type ClientRemote, type ClientSessions,
} from '../../src/client/doors.ts'

const byId = (id: string) => DOOR_ACTIONS.find((d) => d.id === id)
/** A reply exactly as `deterministicCommand` formats it (src/tools.ts). */
const reply = (noun: string, title: string, child: string): string =>
  `1 new chapter(s) archived (watermark respected: seqs 0..8), ${noun} \u201C${title}\u201D is session ${child}. Switch to it from the sidebar.`

function world(text: string, kind = 'success') {
  const executed: Array<{ sessionId: string; line: string }> = []
  const opened: string[] = []
  const remote = {
    commands: {
      execute: async (sessionId: string, line: string) => {
        executed.push({ sessionId, line })
        return { ok: true, value: { result: { kind, text } } }
      },
    },
  } as unknown as ClientRemote
  // A CLASS INSTANCE, like the real host service: verbs live on the prototype, and the
  // diagnostic that only looked at own keys reported "no methods" about a working service.
  const sessions = new (class {
    sink: (id: string) => void
    constructor(sink: (id: string) => void) { this.sink = sink }
    open(id: string) { this.sink(id) }
    refresh() { return Promise.resolve() }
  })((id: string) => { opened.push(id) }) as unknown as ClientSessions
  return { remote, sessions, executed, opened }
}

test('two rows, distinct ids/orders/labels/commands — and the fork row is untouched', () => {
  assert.equal(DOOR_ACTIONS.length, 2)
  const fork = byId('chapters-fork')
  const cont = byId('chapters-continue')
  assert.ok(fork !== undefined && cont !== undefined)
  // Existing e2e specs select on this exact label; it may not change.
  assert.equal(fork.label, 'Fork with chapters')
  assert.equal(fork.command, '/chapters-fork')
  assert.equal(fork.order, 30)
  assert.equal(cont.command, '/chapters-continue')
  assert.notEqual(cont.label, fork.label, 'two identical buttons would be one mystery')
  assert.notEqual(cont.order, fork.order, 'the row needs a deterministic order')
  for (const key of ['id', 'order', 'label', 'command', 'noun'] as const) {
    assert.equal(new Set(DOOR_ACTIONS.map((d) => d[key])).size, 2, `${key} must be distinct per row`)
  }
})

test('ONE child-id regex parses BOTH door wordings; the title regex is noun-scoped', () => {
  const branchText = reply('branch', 'Notes — branch', 'ch-aaa111')
  const contText = reply('continuation', 'Notes — continuation', 'ch-bbb222')
  assert.equal(CHILD_ID.exec(branchText)?.[1], 'ch-aaa111')
  assert.equal(CHILD_ID.exec(contText)?.[1], 'ch-bbb222')
  assert.equal(doorTitle('branch').exec(branchText)?.[1], 'Notes — branch')
  assert.equal(doorTitle('continuation').exec(contText)?.[1], 'Notes — continuation')
  // The noun is part of the title pattern on purpose: it keeps a refusal that
  // quotes other wording from being read as the child's title.
  assert.equal(doorTitle('branch').exec(contText), null)
})

test('both rows route through the SAME runner and switch to the child it names', async () => {
  const seen: string[] = []
  for (const door of DOOR_ACTIONS) {
    const w = world(reply(door.noun, `T ${door.id}`, `ch-${door.id}`))
    const result = await makeDoorRunner(w.remote, w.sessions, door)('sess-1')
    assert.deepEqual(w.executed, [{ sessionId: 'sess-1', line: door.command }], `${door.id} fires its own command`)
    assert.deepEqual(w.opened, [`ch-${door.id}`], `${door.id} opens the child the reply names`)
    assert.deepEqual(result, { ok: true, message: '' }, `${door.id} leaves no note after a switch`)
    seen.push(`${w.executed.length}:${w.opened.length}`)
  }
  assert.deepEqual(seen, ['1:1', '1:1'], 'both doors behaved identically, differing only by command')
})

test('a refusal is reported, never swallowed into a silent success', async () => {
  for (const door of DOOR_ACTIONS) {
    const w = world(`${door.command} refused: nothing to archive yet`, 'error')
    const result = await makeDoorRunner(w.remote, w.sessions, door)('sess-1')
    assert.equal(result.ok, false, `${door.id} reports the refusal`)
    assert.equal(result.message, `${door.command} refused: nothing to archive yet`)
    assert.deepEqual(w.opened, [], `${door.id} opens nothing when the door refused`)
  }
  const noRemote = await makeDoorRunner({} as ClientRemote, undefined, DOOR_ACTIONS[0]!)('sess-1')
  assert.deepEqual(noRemote, { ok: false, message: 'commands remote unavailable' })
  // The note beside the button is short by design, so a long refusal is clipped
  // at 90 chars — the same budget for both doors.
  const long = await makeDoorRunner(world('r'.repeat(400), 'error').remote, undefined, DOOR_ACTIONS[1]!)('s')
  assert.equal(long.message.length, 90, 'clipped, not swallowed')
})

test('when the switch cannot happen the note still names the door\'s own child', async () => {
  for (const door of DOOR_ACTIONS) {
    const w = world(reply(door.noun, 'T', `ch-${door.id}`))
    // No sessions service and no document: both switch paths decline.
    const result = await makeDoorRunner(w.remote, undefined, door)('sess-1')
    assert.equal(result.ok, true, `${door.id}: the child is durable either way`)
    assert.match(result.message, new RegExp(`^${door.noun} created`))
  }
})

test('the wording the client parses is the server\'s own (no drift between the planes)', () => {
  const tools = readFileSync(path.resolve(import.meta.dirname, '../../src/tools.ts'), 'utf8')
  // Both doors come from one builder, and both success texts carry
  // `<noun> “title” is session <id>` — what CHILD_ID and doorTitle depend on.
  assert.ok(tools.includes('${door.noun} \\u201C${title}\\u201D is session'), 'archived reply template')
  assert.ok(tools.includes('is session ${forked.childSessionId'), 'citation-only reply template')
  for (const door of DOOR_ACTIONS) {
    assert.ok(tools.includes(`noun: '${door.noun}'`), `server door for ${door.id} still names '${door.noun}'`)
  }
})

test('there is no second runner body in the client chrome', () => {
  const entry = readFileSync(path.resolve(import.meta.dirname, '../../src/client/index.ts'), 'utf8')
  assert.ok(!entry.includes('commands.execute'), 'index.ts must not talk to the wire itself')
  assert.ok(!entry.includes('is session'), 'index.ts must not parse the reply itself')
  assert.ok(entry.includes('makeDoorRunner'), 'both rows come from the shared runner')
})

/**
 * #54 — the switch must be CONFIRMED, not assumed from a call that did not throw.
 * On host 0.2.0-rc.2 the fork door left no note element (meaning `sessions.open()`
 * resolved), yet `dsh.sessions.current` still named the parent and the child never
 * appeared in the sidebar even after a reload. A void-returning open() cannot tell
 * "switched" from "accepted the request and did nothing", so the runner asks the
 * client what is current now.
 */
test('a verified switch leaves no note; an unverified one says the app did not switch', async () => {
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const w = world(reply(door.noun, 'Branch work', 'ch-verify-1'))
  const okRun = await makeDoorRunner(w.remote, w.sessions, door, async () => true)(
    'parent-1',
  )
  assert.deepEqual(okRun, { ok: true, message: '' }, 'a confirmed switch is silent, as today')

  const w2 = world(reply(door.noun, 'Branch work', 'ch-verify-2'))
  const badRun = await makeDoorRunner(w2.remote, w2.sessions, door, async () => false)('parent-1')
  assert.equal(badRun.ok, true, 'the child IS created and durable — the door does not lie the other way')
  assert.match(badRun.message, /did not switch|not switch/i,
    'but it says the affordance failed, instead of silently claiming the switch')
  assert.match(badRun.message, new RegExp(door.noun), 'in the door’s own noun, like every other note')
  // #56/#57: the note names the verbs the service actually exposes, so one field failure
  // tells the next reader whether a refresh exists to call or `open` is all there is.
  assert.match(badRun.message, /sessions verbs: [^)]*open/,
    `the failure note must deliver the diagnosis, got: ${badRun.message}`)
})

test('the client wires a real verifier — absence would restore the silent no-op', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/client/index.ts'), 'utf8')
  assert.match(src, /makeDoorRunner\([^)]*\)/, 'the runner is still built once per door')
  assert.match(src, /dsh\.sessions\.current/,
    'the verifier reads the host-published current session (dsh-client-ui-workspace); without it the door is back to trusting a void call')
})

/**
 * #57 — the client must CATALOGUE a plugin-created session before `open()` can address it.
 * The host's own client create/fork paths both end in `this.projectList()`
 * (`dsh-api-session-controller/lib/client.js`); a session the client never catalogued is not
 * openable however many times `open()` resolves — which is precisely the 0.2.0-rc.2 symptom
 * the fork journeys were failing on.
 */
test('the door re-projects the client catalog before it tries to open the child', async () => {
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const calls: string[] = []
  const remote = {
    commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-proj-1') } } }) },
  } as unknown as ClientRemote
  const sessions = {
    projectList: () => { calls.push('projectList') },
    open: (id: string) => { calls.push(`open:${id}`) },
  } as unknown as ClientSessions
  await makeDoorRunner(remote, sessions, door, async () => true)('parent-1')
  assert.deepEqual(calls, ['projectList', 'open:ch-proj-1'],
    `open() before re-projection can only ever address a stale roster: ${calls.join(' → ')}`)
})

test('the failure note reports roster presence from the store, and UNKNOWN when there is none', async () => {
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const mk = (list: unknown) => ({
    commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-note-1') } } }) },
  }) as unknown as ClientRemote
  const svcMissing = { open: () => undefined, list: { getSnapshot: () => ({ ids: ['session-a', 'session-b'] }) } } as unknown as ClientSessions
  const r1 = await makeDoorRunner(mk('x'), svcMissing, door, async () => false)('parent-1')
  assert.match(r1.message, /roster: MISSING, 2 sessions — the client never catalogued/,
    `the note must name the real cause, got: ${r1.message}`)

  const svcHas = { open: () => undefined, list: { getSnapshot: () => ({ ids: ['ch-note-1'] }) } } as unknown as ClientSessions
  const r2 = await makeDoorRunner(mk('x'), svcHas, door, async () => false)('parent-1')
  assert.match(r2.message, /roster: contains ch-note-1…, 1 sessions — open\(\) is the failure/,
    `a session the client KNOWS but cannot open is a different bug and must read differently: ${r2.message}`)

  const svcNoStore = { open: () => undefined } as unknown as ClientSessions
  const r3 = await makeDoorRunner(mk('x'), svcNoStore, door, async () => false)('parent-1')
  assert.match(r3.message, /UNKNOWN, not absent/, 'absence of evidence is never reported as evidence of absence')
  assert.doesNotMatch(r3.message, /0 sessions/, 'the old misread that made a live conversation look empty')
})

/**
 * #77 — one `open()` is not enough, and which attempt works IS the diagnosis.
 *
 * The client's session manager pulls the list with `refreshList()`, documented as
 * "single-flight within one Host generation" (`dsh-api-session-controller/lib/types/client/
 * sessions/manager.js`) — so a refresh issued while another pull is in flight can resolve from
 * the STALE in-flight result, which is exactly when a session created microseconds ago is
 * missing. The door therefore re-pulls, re-projects and re-opens a bounded number of times, and
 * reports which attempt took. If attempt 2 or 3 succeeds, the problem is ordering and ours to
 * fix; if every attempt fails with `roster: MISSING`, the client is never being told at all and
 * the fix is host-side announcement.
 */
test('a switch that lands on the second attempt is reported as success, not as a note', async () => {
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  let opens = 0
  const remote = { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-retry-1') } } }) } } as unknown as ClientRemote
  const pulls: number[] = []
  const sessions = {
    refresh: () => { pulls.push(pulls.length); return Promise.resolve() },
    projectList: () => undefined,
    open: () => { opens += 1 },
  } as unknown as ClientSessions
  const r = await makeDoorRunner(remote, sessions, door, async () => opens >= 2, { attemptPauseMs: 1 })('parent-1')
  assert.deepEqual(r, { ok: true, message: '' }, `the second attempt opened it: ${JSON.stringify(r)}`)
  assert.equal(opens, 2, 'and it stopped retrying once the switch verified')
  assert.equal(pulls.length, 2, 'each attempt re-pulls the list — that is the point of the retry')
})

test('an attempt-exhausted switch says how many tries and what the roster said', async () => {
  const door = byId('chapters-continue')
  assert.ok(door !== undefined)
  const remote = { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Continued work', 'ch-retry-2') } } }) } } as unknown as ClientRemote
  let opens = 0
  const sessions = { refresh: () => Promise.resolve(), projectList: () => undefined, open: () => { opens += 1 }, list: { getSnapshot: () => ({ ids: ['session-a'] }) } } as unknown as ClientSessions
  const r = await makeDoorRunner(remote, sessions, door, async () => false, { attemptPauseMs: 1, attempts: 3 })('parent-1')
  assert.equal(r.ok, true, 'the continuation is still durable and real')
  assert.equal(opens, 3, 'every attempt tried to open')
  assert.match(r.message, /after 3 attempts/, `the note must count the tries, got: ${r.message}`)
  assert.match(r.message, /roster: MISSING/, 'and repeat the roster verdict, so one reading gives both halves of the diagnosis')
})

test('a service without refresh still gets exactly one honest attempt', async () => {
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const remote = { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-retry-3') } } }) } } as unknown as ClientRemote
  let opens = 0
  const sessions = { open: () => { opens += 1 } } as unknown as ClientSessions
  const r = await makeDoorRunner(remote, sessions, door, async () => false, { attemptPauseMs: 1 })('parent-1')
  assert.equal(opens, 1, 'no refresh verb means retrying `open` alone would only re-ask a stale roster')
  assert.match(r.message, /roster: unreadable|did not switch/, 'and the note still says what is known: ' + r.message)
})

/**
 * #77 — adopt-and-catalogue, the only client path that writes its own roster.
 *
 * `manager.create()` in `dsh-api-session-controller/lib/types/client/sessions/manager.js` is
 * documented "on success merge into summaries immediately (no wait for the next refresh)" and it
 * sends `sessionId` when the caller owns one. The server side is idempotent by contract:
 * `create(request)` takes `request.sessionId ?? brand(...)` and calls
 * `ensureSession(sessionId, cwd, request.sessionId !== undefined, preset)` — i.e. it ADOPTS an
 * already-persisted session rather than authoring a second one. Nothing about the child's content
 * is touched here: the seed notice was committed by the host plane long before this call. So the
 * door can make the client see what the host already knows, and if adoption is refused (a cwd
 * conflict, a closed session), that refusal must be delivered, not swallowed.
 */
test('a child missing from the client roster is adopted through create({sessionId}) before open', async () => {
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const calls: string[] = []
  const remote = { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-adopt-1') } } }) } } as unknown as ClientRemote
  let opened = false
  const sessions = {
    refresh: () => Promise.resolve(),
    projectList: () => { calls.push('projectList') },
    create: (opts: { sessionId?: string }) => { calls.push(`create:${opts?.sessionId ?? 'none'}`); return Promise.resolve('ch-adopt-1') },
    open: (id: string) => { calls.push(`open:${id}`); opened = true },
    list: { getSnapshot: () => ({ ids: opened ? ['session-a', 'ch-adopt-1'] : ['session-a'] }) },
  } as unknown as ClientSessions
  const r = await makeDoorRunner(remote, sessions, door, async () => opened, { attemptPauseMs: 1 })('parent-1')
  assert.deepEqual(r, { ok: true, message: '' }, `adoption then open should have switched: ${JSON.stringify(r)}`)
  assert.deepEqual(calls, ['projectList', 'create:ch-adopt-1', 'projectList', 'open:ch-adopt-1'],
    `the roster must be re-projected after adopting, and only then opened: ${calls.join(' → ')}`)
})

test('a child the client ALREADY lists is never re-created', async () => {
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const calls: string[] = []
  const remote = { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-adopt-2') } } }) } } as unknown as ClientRemote
  const sessions = {
    refresh: () => Promise.resolve(),
    projectList: () => { calls.push('projectList') },
    create: () => { calls.push('create-SHOULD-NOT-RUN'); return Promise.resolve('ch-adopt-2') },
    open: () => { calls.push('open') },
    list: { getSnapshot: () => ({ ids: ['ch-adopt-2'] }) },
  } as unknown as ClientSessions
  await makeDoorRunner(remote, sessions, door, async () => true)('parent-1')
  assert.ok(!calls.includes('create-SHOULD-NOT-RUN'), `inventing a session the client already has: ${calls.join(' → ')}`)
})

test('a refused adoption is delivered in the note, not swallowed', async () => {
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const remote = { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-adopt-3') } } }) } } as unknown as ClientRemote
  const sessions = {
    refresh: () => Promise.resolve(),
    create: () => Promise.reject(new Error('session cwd conflict')),
    open: () => undefined,
    list: { getSnapshot: () => ({ ids: ['session-a'] }) },
  } as unknown as ClientSessions
  const r = await makeDoorRunner(remote, sessions, door, async () => false, { attemptPauseMs: 1, attempts: 1 })('parent-1')
  assert.equal(r.ok, true, 'the continuation is still durable — a failed affordance is not a failed archive')
  assert.match(r.message, /adoption refused: session cwd conflict/,
    `the refusal reason must reach the human: ${r.message}`)
  assert.match(r.message, /roster: MISSING/, 'alongside the roster verdict that made adoption necessary')
})

test('the note reports the roster RIGHT AFTER adoption, before a later refresh can wipe it', async () => {
  // `refreshList()` reassigns the manager's mutations from the server result (manager.js:
  // `const mutations = []; this.listMutations = mutations`), so a placeholder written by an
  // adopted `create()` is GONE by the time the last attempt fails. Reading the roster only at
  // the end therefore reports "MISSING" even if adoption worked momentarily — and that
  // distinction is exactly what decides whether #77 is an ordering bug or a publication gap.
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const remote = { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-momentary-1') } } }) } } as unknown as ClientRemote
  let adopted = false
  const sessions = {
    refresh: () => { adopted = false; return Promise.resolve() },   // a refresh discards the placeholder
    projectList: () => undefined,
    create: () => { adopted = true; return Promise.resolve('ch-momentary-1') },
    open: () => undefined,
    list: { getSnapshot: () => ({ ids: adopted ? ['session-a', 'ch-momentary-1'] : ['session-a'] }) },
  } as unknown as ClientSessions
  const r = await makeDoorRunner(remote, sessions, door, async () => false, { attemptPauseMs: 1, attempts: 2 })('parent-1')
  assert.match(r.message, /right after adopt: contains ch-momentary-1/,
    `the note must show adoption took effect at the moment, got: ${r.message}`)
  assert.match(r.message, /roster: MISSING/, 'and still report the final state honestly')
})

/**
 * #77, second candidate: make the CLIENT subscribe to the session it cannot see.
 *
 * `ClientSessions.retain(target, {source})` / `using(target, {source}, fn)` resolve the id through
 * the manager and open a scope for it (`sessions/service.js`: `retain` →
 * `reference.attachOpening(this.manager.get(id).open(), signal)`), which is the host's own way of
 * addressing a session that is not currently displayed. Adoption via `create` was measured and did
 * not populate the roster; this is the other legitimate door, so it gets the same treatment:
 * bounded, verified, and reported — and dropped the moment measurement says it does nothing.
 */
test('an uncatalogued child is retained through the client service before it is opened', async () => {
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const calls: string[] = []
  const remote = { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-retain-1') } } }) } } as unknown as ClientRemote
  let visible = false
  const sessions = {
    refresh: () => Promise.resolve(),
    projectList: () => { calls.push('projectList') },
    using: (id: string, opts: { source?: string }, fn: () => Promise<void>) => {
      calls.push(`using:${id}:${opts?.source ?? '?'}`)
      visible = true
      return fn()
    },
    open: (id: string) => { calls.push(`open:${id}`) },
    list: { getSnapshot: () => ({ ids: visible ? ['session-a', 'ch-retain-1'] : ['session-a'] }) },
  } as unknown as ClientSessions
  const r = await makeDoorRunner(remote, sessions, door, async () => visible, { attemptPauseMs: 1 })('parent-1')
  assert.deepEqual(r, { ok: true, message: '' }, `subscribe-then-open should have worked: ${JSON.stringify(r)}`)
  assert.deepEqual(calls, ['projectList', 'using:ch-retain-1:dsh-chapters-door', 'projectList', 'open:ch-retain-1'],
    `the roster must be re-read after subscribing: ${calls.join(' → ')}`)
})

test('a refused subscribe is named in the note, and a session already listed is never subscribed', async () => {
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const mk = (execute: () => Promise<unknown>) => ({ commands: { execute } } as unknown as ClientRemote)
  const okText = () => Promise.resolve({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-retain-2') } } })

  const refusedCalls: string[] = []
  const refused = {
    refresh: () => Promise.resolve(),
    projectList: () => refusedCalls.push('projectList'),
    using: () => Promise.reject(new Error('session/not-found')),
    open: () => refusedCalls.push('open'),
    list: { getSnapshot: () => ({ ids: ['session-a'] }) },
  } as unknown as ClientSessions
  const r1 = await makeDoorRunner(mk(okText), refused, door, async () => false, { attemptPauseMs: 1, attempts: 1 })('parent-1')
  assert.match(r1.message, /subscribe refused: session\/not-found/, `the refusal must reach the human: ${r1.message}`)

  const listedCalls: string[] = []
  const listed = {
    refresh: () => Promise.resolve(),
    projectList: () => listedCalls.push('projectList'),
    using: () => { listedCalls.push('using-SHOULD-NOT-RUN'); return Promise.resolve() },
    open: () => listedCalls.push('open'),
    list: { getSnapshot: () => ({ ids: ['ch-retain-2'] }) },
  } as unknown as ClientSessions
  await makeDoorRunner(mk(okText), listed, door, async () => true)('parent-1')
  assert.ok(!listedCalls.includes('using-SHOULD-NOT-RUN'), `subscribing a listed session is redundant: ${listedCalls.join(' → ')}`)
})

test('a LOADED-BUT-EMPTY roster still triggers adoption — unknown does not', async () => {
  // The predicate that gates adoption is a claim about knowledge, and getting it wrong silently
  // disables every #77 candidate: `ids.size > 0` read a store that had not loaded yet as "nothing
  // to do", so neither adopt nor subscribe ever ran in the live probe, and the negative result I
  // nearly recorded was measuring a code path that never executed.
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const mkRemote = (child: string): ClientRemote => ({
    commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', child) } } }) },
  })

  const calls: string[] = []
  const emptyStore = {
    refresh: () => Promise.resolve(),
    projectList: () => calls.push('projectList'),
    create: () => { calls.push('create'); return Promise.resolve('ch-empty-1') },
    open: () => calls.push('open'),
    list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }) },
  } as unknown as ClientSessions
  await makeDoorRunner(mkRemote('ch-empty-1'), emptyStore, door, async () => false, { attemptPauseMs: 1, attempts: 1 })('parent-1')
  assert.ok(calls.includes('create'), `a ready-but-empty roster must not suppress adoption: ${calls.join(' → ')}`)

  const noStore: string[] = []
  const unreadable = {
    refresh: () => Promise.resolve(),
    projectList: () => noStore.push('projectList'),
    create: () => { noStore.push('create'); return Promise.resolve('ch-unk-1') },
    open: () => noStore.push('open'),
  } as unknown as ClientSessions
  const r = await makeDoorRunner(mkRemote('ch-unk-1'), unreadable, door, async () => false, { attemptPauseMs: 1, attempts: 1 })('parent-1')
  assert.ok(!noStore.includes('create'), 'an UNREADABLE roster is unknown, and unknown must not invent a session')
  assert.match(r.message, /UNKNOWN, not absent/, 'and the note must say it was unknown — that is the sentence that prevents the wrong conclusion')
})

test('the note records what the roster reader saw at EACH attempt, not just at the end (#77)', async () => {
  // The live probe said `roster: MISSING, 1 sessions` at the end while neither adoption nor
  // subscribe ever fired — which is only possible if the reader answered differently at the
  // moment of decision. One number cannot show that; a per-attempt trace can, and it turns an
  // argument about my own control flow into a line someone can read.
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const remote = { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-trace-1') } } }) } } as unknown as ClientRemote
  let loaded = false
  const sessions = {
    refresh: () => { loaded = true; return Promise.resolve() },
    projectList: () => undefined,
    create: () => Promise.resolve('ch-trace-1'),
    open: () => undefined,
    list: { getSnapshot: () => (loaded ? { ids: ['session-a', 'ch-trace-1'] } : { ids: [], byId: {}, phase: 'pending' }) },
  } as unknown as ClientSessions
  const r = await makeDoorRunner(remote, sessions, door, async () => false, { attemptPauseMs: 1, attempts: 3 })('parent-1')
  // this fake HAS create and LACKS using, so the markers must read +c-u — the row describes its
  // own fixture, which is the point of printing the shape at all.
  assert.match(r.message, /\[roster per attempt: empty\+c-u → has\+c-u → has\+c-u\]/,
    `the trace must show the reader's answer at each decision point: ${r.message}`)
})

test('a failed switch names the BUILD that failed, so a stale tree is not read as a refusal (#77)', async () => {
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  assert.ok(DOOR_BUILD.length > 10, 'the stamp must be a real marker, not a placeholder')
  const remote = { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-build-1') } } }) } } as unknown as ClientRemote
  const sessions = { open: () => undefined, list: { getSnapshot: () => ({ ids: ['session-a'] }) } } as unknown as ClientSessions
  const r = await makeDoorRunner(remote, sessions, door, async () => false, { attempts: 1, attemptPauseMs: 1 })('parent-1')
  assert.ok(r.message.includes(DOOR_BUILD), `the note must carry the build stamp: ${r.message}`)
})

test('a refusal with no message is still VISIBLE — an empty reason is not a silence (#77)', async () => {
  // Every candidate path formats its reason through `String(err.message ?? err).slice(0,90)`, and
  // a host error that carries an empty message produced exactly `''` — which the note then
  // rendered as nothing at all. The live probe showed precisely that shape: adoption warranted,
  // both verbs present, no outcome reported. An unhelpful reason is still a reason; "no text" is
  // the one answer that must never be the output.
  const door = byId('chapters-fork')
  assert.ok(door !== undefined)
  const remote = { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: reply(door.noun, 'Branch work', 'ch-empty-err') } } }) } } as unknown as ClientRemote
  const sessions = {
    refresh: () => Promise.resolve(),
    projectList: () => undefined,
    create: () => Promise.reject(new Error('')),
    open: () => undefined,
    list: { getSnapshot: () => ({ ids: ['session-a'] }) },
  } as unknown as ClientSessions
  const r = await makeDoorRunner(remote, sessions, door, async () => false, { attempts: 1, attemptPauseMs: 1 })('parent-1')
  assert.match(r.message, /adoption refused: \(\S[^)]*\)|adoption refused: [^\s(][^)]*/,
    `a refusal whose message is empty must say so with something, got: ${r.message}`)
  assert.doesNotMatch(r.message, /adoption refused: \)/, 'and never render an empty reason')
})
