/**
 * #497 — the drift row for the projection call this plugin makes at session load.
 *
 * The birth-push dedup (and the pushBar suppression that replaced it) rest on one host
 * interface: `stateOf(session, key)` — parameter ORDER and shape included. The repo's own
 * call site duck-types it; duck types do not fail when the host reshuffles parameters, they
 * silently answer `undefined`, and undefined means "not redundant" means one more visible
 * record per visit for the user. That is not a hypothesis — it is the best explanation for
 * the maintainer's post-0.2.47 symptom, found because the wiring was never pinned and the
 * predicate alone was tested.
 *
 * This row reads the PINNED host's shipped type file and asserts the exact call contract we
 * depend on. When the host generation changes this surface, the row fails the day the pin
 * bumps — instead of the user failing to see the bar for the reason they wrote in #482.
 * (Matrix cells skip by name: this guards the pinned world, same doctrine as host-dep-pinning.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TYPES = path.join(ROOT, 'dev', 'dsh-host-lock', 'node_modules', '@deepseek-ai',
  'dsh-session-projection', 'lib', 'types', 'index.d.ts')

test('#497: the pinned host still declares stateOf(session, key) — the call our suppression makes', {
  skip: process.env.DSH_MATRIX_VERSION !== undefined ? `matrix cell for ${process.env.DSH_MATRIX_VERSION}: this row guards the PINNED host's types; the matrix's per-version truth is the sweep's own compile+run` : (fs.existsSync(TYPES) ? false : 'no pinned host tree installed (run the host-lock install, per the acceptance job)'),
}, () => {
  const src = fs.readFileSync(TYPES, 'utf8')
  // session FIRST, key SECOND — a flipped host signature would make our stateOf(session, key)
  // read a key-shaped slot from a Session and answer undefined forever, silently disabling
  // dedup while every unit test of the predicate kept passing.
  assert.match(src, /stateOf<K extends keyof SessionProjectionStateMap>\(\s*session: Session,\s*key: K\s*\)/,
    'stateOf(session, key) must keep its exact parameter contract — src/index.ts pushBar calls it that way')
  // and the registry member the plugin holds must still expose it on the service surface we cast to
  assert.match(src, /stateOf/, 'the service still publishes stateOf at all')
})
