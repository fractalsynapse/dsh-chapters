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
  CHILD_ID, DOOR_ACTIONS, doorTitle, makeDoorRunner,
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
  const sessions = { open: (id: string) => { opened.push(id) } } as unknown as ClientSessions
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
})

test('the client wires a real verifier — absence would restore the silent no-op', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/client/index.ts'), 'utf8')
  assert.match(src, /makeDoorRunner\([^)]*\)/, 'the runner is still built once per door')
  assert.match(src, /dsh\.sessions\.current/,
    'the verifier reads the host-published current session (dsh-client-ui-workspace); without it the door is back to trusting a void call')
})
