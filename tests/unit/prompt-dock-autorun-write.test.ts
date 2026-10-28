/**
 * The Autorun button must WRITE to the server, or it is decoration (objective item 3, found 2026-10-28).
 *
 * Measured in a live recording run: with a goal armed and the host offering `Pause goal`, clicking our bar's
 * Autorun never produced `Autorun off` — because the click only dispatches local state (`prompt-dock.ts:386`) and
 * `refresh()` then reads the server, which still says `disarmed`, so the label snaps straight back. The user
 * watches their own click being refused, and the whole loop — the "worker" half of the director/worker design —
 * cannot be started from the bar at all. The `off` button two lines below DOES send its command (`:392`), which is
 * what made the asymmetry visible.
 *
 * The server side is complete and was never the problem: `/chapters-prompt autorun on|off` exists
 * (`src/commands.ts:462-478`) and even prints the displacement fact ("its own auto-continuation is disarmed"). So
 * this is a one-line client defect, and the row is a source-shape guard because the client plane has no DOM harness
 * here — same style as `prompt-dock-placement.test.ts`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const DOCK = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'client', 'prompt-dock.ts'), 'utf8')

test('the autorun control sends the server command, like the off control does', () => {
  // Property, not layout: within the ONE Action block that dispatches the autorun toggle, the server command must
  // be issued. Splitting on the component's own call site is how this survives the handler growing nested braces
  // (the first version matched `[^}]*`, which stopped at the async IIFE's own brace and failed for the wrong
  // reason — the shape assumption broke, the product did not).
  const blocks = DOCK.split(/h\(Action, \{/).slice(1)
  const autorunBlock = blocks.find((b) => b.includes("t: 'autorun'")) ?? ''
  assert.ok(autorunBlock.length > 0, "no Action block dispatches the autorun toggle — the control was renamed or removed")
  assert.match(autorunBlock, /exec\s*\(\s*`\/chapters-prompt autorun/,
    `the Autorun control must write through the command, not just flip local state:\n${autorunBlock.slice(0, 520)}`)
})

test('the OFF control still writes too (the asymmetry must not invert)', () => {
  const offHandlers = [...DOCK.matchAll(/onClick: \(\) => \{[\s\S]{0,220}?chapters-prompt off[\s\S]{0,80}?\}/g)]
  assert.ok(offHandlers.length >= 1, 'the off control must keep sending `/chapters-prompt off`')
})
