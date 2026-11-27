/**
 * #588: the invisible-command-card class, gated at its source.
 *
 * #545 closed with the cause byte-proven: the host's session-surface fold
 * (dsh-session/lib/index.js, SURFACE_EVENT_TYPES + isSurfaceEligibleType)
 * decides which durable events a timeline may render, and command/run +
 * command/done are NOT members. Consequence, measured live 2026-11-27: a
 * command EXECUTES, its full reply lands in the durable log, and the
 * timeline of a RESTARTED+RESUMED session shows nothing — a hard reload
 * included. The product promise is recoverability (the log); the promise
 * the screen keeps making (cards) belongs to the host's fold.
 *
 * This row is the falsifiable watch (#553/#554 doctrine, #180 precedent for
 * reading pinned-host files): it asserts the EXACT current membership and
 * fails, naming the flip direction, the day the host changes it in EITHER
 * direction — command events ADDED means #545's class is fixed and the
 * cards-after-resume UX must be re-validated and this row promoted to
 * requiring them; a message member REMOVED means the fold regressed for
 * ordinary history. The mutation rows (#456 discipline) prove the parse is
 * not vacuous: a fixture with command events added MUST be detected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CURRENT = ['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'] as const

/** Parse the fold constant out of a host bundle. Kept pure so the mutation rows can feed it fixtures. */
export function surfaceMembers(source: string): string[] | null {
  const m = source.match(/SURFACE_EVENT_TYPES\s*=\s*new Set\(\[([^\]]*)\]\)/)
  if (m === null) return null
  return [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1] ?? '')
}

function pinnedHostSource(): string {
  return readFileSync(new URL('../../dev/dsh-host-lock/node_modules/@deepseek-ai/dsh-session/lib/index.js', import.meta.url), 'utf8')
}

test('#588 drift guard: the pinned host fold surfaces EXACTLY the five message types — no command events', {
  // The version-sweep cells run OTHER hosts by design; their fold posture is the sweep's report, not this pin row.
  skip: process.env.DSH_MATRIX_VERSION !== undefined ? `matrix cell for ${process.env.DSH_MATRIX_VERSION}` : false,
}, () => {
  const members = surfaceMembers(pinnedHostSource())
  assert.ok(members !== null, 'SURFACE_EVENT_TYPES vanished from the pinned dsh-session bundle — the fold moved or renamed: re-measure #545/#588 before trusting either')
  const set = new Set(members)
  const added = members.filter((x) => !CURRENT.includes(x as (typeof CURRENT)[number]))
  const missing = CURRENT.filter((x) => !set.has(x))
  const commandSurfaced = members.some((x) => x.startsWith('command/'))
  if (commandSurfaced) {
    assert.fail(`HOST FIXED THE FOLD: ${members.filter((x) => x.startsWith('command/')).join(', ')} now surface. #545's invisible-card class ends here — re-validate cards-after-resume in the live app, add the DOM assertion the reload leg defers, and rewrite this row to REQUIRE them (issue #588).`)
  }
  assert.deepEqual(added, [], `the fold grew non-command members (${added.join(', ')}) — new surface kinds change what a resumed timeline replays; check the #545-class UX and this row`)
  assert.deepEqual(missing, [], `the fold LOST message members (${missing.join(', ')}) — ordinary resumed history now renders less than it recorded; host regression, file upstream and pin the version in the matrix`)
})

test('#588: the durable plane still records what the fold refuses to render — command events are RECORDED kinds', {
  skip: process.env.DSH_MATRIX_VERSION !== undefined ? `matrix cell for ${process.env.DSH_MATRIX_VERSION}` : false,
}, () => {
  // The other half of the contract: command events are first-class in the session event map, which is
  // WHY the log holds the full reply and recovery is always possible even while the screen shows nothing.
  const src = readFileSync(new URL('../../dev/dsh-host-lock/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /["'`]command\/run["'`]/, 'command/run is a declared event kind on the pinned client contract')
  assert.match(src, /["'`]command\/done["'`]/, 'and command/done too — the pair exists durably; the fold set is what hides it (#545)')
})

test('#588 mutation proof: the parser catches BOTH flips — command events added, message members removed', () => {
  const base = 'x=SURFACE_EVENT_TYPES=new Set([`system/message`,`developer/message`,`user/message`,`assistant/message`,`tool/result`]);'
  assert.deepEqual(surfaceMembers(base), [...CURRENT], 'the fixture itself parses (the shape the pin carries today)')
  const withCommand = 'x=SURFACE_EVENT_TYPES=new Set([`system/message`,`developer/message`,`user/message`,`assistant/message`,`tool/result`,`command/run`,`command/done`]);'
  const added = (surfaceMembers(withCommand) ?? []).filter((x) => x.startsWith('command/'))
  assert.deepEqual(added, ['command/run', 'command/done'], 'a host that FIXES the fold must flip the guard, not slip past it')
  const shrunk = 'x=SURFACE_EVENT_TYPES=new Set([`system/message`,`user/message`,`assistant/message`,`tool/result`]);'
  const lost = CURRENT.filter((x) => !(surfaceMembers(shrunk) ?? []).includes(x))
  assert.deepEqual(lost, ['developer/message'], 'a host that LOSES a member must flip the guard too')
  assert.equal(surfaceMembers('no constant here'), null, 'and a moved/renamed constant reads as null — the guard treats invisibility as drift')
})
