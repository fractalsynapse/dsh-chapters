/**
 * Structural rows for the docked bar (#113) — placement and wiring are decisions, not styling.
 *
 * Why a source-scan row rather than a render test: the behaviour lives in `prompt-bar.ts` (8 rows), and the
 * browser journey is blocked on the corpus line (#117's lockout is fixed, the tape re-distill is not). What
 * IS verifiable now is the load-bearing contract: the slot name, the order that puts it under every other
 * dock entry, and the fact the client plane actually type-checks these files (the client bundle is checked
 * by `typecheck:client`, which CI runs beside `typecheck` — an unlisted file silently escapes it, #71).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const CLIENT = fs.readFileSync(path.join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
const STRICT = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.client.strict.json'), 'utf8')) as { files: string[] }

test('the bar registers into the composer dock, under every other entry (#113)', () => {
  assert.match(CLIENT, /slots\.inject\('conversation\.input\.dock'/,
    'the goal bar uses this slot; an overlay would put us back on top of the placeholder')
  assert.match(CLIENT, /id: 'chapters-prompt'/)
  const dock = CLIENT.slice(CLIENT.indexOf("slots.inject('conversation.input.dock'"))
  assert.match(dock, /order: 30/, 'todo 0 · goal 10 · queue 20 — 30 is the measured "directly above the composer card"')
  assert.match(dock, /PromptDock\)/, 'and the component is the one in prompt-dock.ts, built once outside the factory')
})

test('both bar modules are inside the client strict plane (#71)', () => {
  assert.ok(STRICT.files.includes('src/client/prompt-bar.ts'), 'unlisted = unchecked = silently untyped')
  assert.ok(STRICT.files.includes('src/client/prompt-dock.ts'))
})

test('the bar speaks only to the command plane (#113, no private channel)', () => {
  assert.match(CLIENT, /exec: \(line: string\) => runCommandText\(remote, sessionId, line\)/,
    'the bar rides the ONE client wire body in doors.ts — the guard "no second runner body in the client chrome" is what keeps it that way')
  assert.ok(!CLIENT.includes('commands.execute'), 'and index.ts still never touches the wire, comment included')
  const dockSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'prompt-dock.ts'), 'utf8')
  assert.match(dockSrc, /BAR_STATE_COMMAND/, 'and it pulls the same verb a human types')
})

test('#208: the dock source keeps the plane-wide silence wired — the flag is read in tick and written from the reply', () => {
  // Source-scan row, the pattern this file already uses for client wiring: the dock has no DOM
  // harness here, and an unwired flag is exactly the silent regression this row exists to catch.
  // CLIENT is index.ts in this file; the flag lives in the dock module, so read it here.
  const DOCK = fs.readFileSync(path.join(ROOT, 'src/client/prompt-dock.ts'), 'utf8')
  assert.match(DOCK, /if \(parseModelAbsent\(text\)\) featureAbsent = true/, 'the reply hook sets the flag')
  assert.match(DOCK, /if \(featureAbsent\) return/, 'and tick honors it before any other decision')
})
