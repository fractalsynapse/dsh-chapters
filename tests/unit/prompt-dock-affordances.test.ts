/**
 * #282 affordance pins for the Suggested Next Step dock: the click-state tooltips, the expanded-pane
 * collapse control, and the unknown-is-not-running doctrine the clear-on-run depends on. Source-scan
 * rows like prompt-dock-placement.test.ts, because the behaviours are one-attribute facts whose
 * absence is silent in the wire and loud in the chair.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOCK = fs.readFileSync(path.join(ROOT, 'src', 'client', 'prompt-dock.ts'), 'utf8')

test('#282: the row tooltip names the click outcome per state', () => {
  assert.ok(DOCK.includes("Click to expand the full suggested prompt"), 'collapsed names expand')
  assert.ok(DOCK.includes("Click to send this prompt to the chat input for editing"), 'expanded names the composer handoff')
})

test('#282: the expanded pane carries a collapse control wired to the reducer', () => {
  assert.match(DOCK, /t: 'collapse'/, 'collapse dispatches the existing reducer case (keeps the offer — only human/prompt or off dismisses it)')
  assert.match(DOCK, /dsh-chapters_promptCollapse/, 'with its own corner class')
})

test('#282: unknown running is NOT running — the clear-on-run must never strand a non-publishing host', () => {
  assert.doesNotMatch(DOCK, /running \?\? true/, 'the #221 doctrine extended: `?? true` made an absent signal mean "a turn is in flight", which under clear-on-run would clear the bar forever')
  assert.match(DOCK, /running === true/, 'strict boolean: only a published true edge folds to running')
})

test('#291: the ✕ executes the session-scoped verb — never the plane-wide off', () => {
  assert.match(DOCK, /exec\('\/chapters-prompt off-session'\)/, 'the label and the verb now share one scope')
  assert.doesNotMatch(DOCK, /exec\('\/chapters-prompt off'\)/, 'the plane-wide verb is out of the dock entirely')
})
