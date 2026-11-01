/**
 * #210: the tooltip recipe is the goal bar's own, pinned field by field. The maintainer's report —
 * "the hoverover tooltips are covered by the main chat input container" — was the missing `portal`:
 * without it the popup renders inside our dock's stacking context and the composer card covers it.
 * GoalBar.tsx:101-142 is the proof-by-example: same strip, same seat, `portal side="bottom"
 * delayMs={500}`, no coverage. Our old compile-time types rejected portal/delayMs at the overload;
 * the runtime host always accepted them, and since #194-compat the seat is typed by US.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tooltipPropsFor } from '../../src/client/tooltip.ts'

test('the tooltip recipe matches the goal bar exactly: portal, bottom, 500ms, label verbatim', () => {
  const p = tooltipPropsFor('Run the suggested next step')
  assert.equal(p.portal, true, 'portal lifts the popup to document level — the fix for the composer covering it')
  assert.equal(p.side, 'bottom')
  assert.equal(p.delayMs, 500)
  assert.equal(p.label, 'Run the suggested next step')
})
