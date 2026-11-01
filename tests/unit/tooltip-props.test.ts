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
import { tooltipPropsFor, resolveTooltip, withTooltip, nativeTitle } from '../../src/client/tooltip.ts'
import { createElement } from 'react'

test('the tooltip recipe matches the goal bar exactly: portal, bottom, 500ms, label verbatim', () => {
  const p = tooltipPropsFor('Run the suggested next step')
  assert.equal(p.portal, true, 'portal lifts the popup to document level — the fix for the composer covering it')
  assert.equal(p.side, 'bottom')
  assert.equal(p.delayMs, 500)
  assert.equal(p.label, 'Run the suggested next step')
})

test('resolveTooltip probes once and falls back cleanly when the seat is absent', () => {
  // The probe path: our bundled require cannot find the host package in the test environment,
  // which IS the absent-seat arm — the same one 0.2.1-rc.5 fresh installs hit.
  const T = resolveTooltip()
  assert.equal(T, null, 'the absent seat resolves to null')
  assert.equal(resolveTooltip(), null, 'and the probe is cached, not re-run')
})

test('withTooltip returns the child bare when the seat is absent; nativeTitle supplies the title then', () => {
  const child = createElement('button', { type: 'button' }, 'Run')
  const wrapped = withTooltip('Run the suggested next step', child)
  assert.equal(wrapped, child, 'no host Tooltip ⇒ no wrapper: the child is returned as-is (it must carry title)')
  assert.deepEqual(nativeTitle('Run'), { title: 'Run' }, 'the native fallback fires only when the seat is absent')
  const childWithSeat = createElement('button', nativeTitle('Run'), 'Run')
  assert.equal((childWithSeat.props as Record<string, unknown>).title, 'Run', 'the button carries the hover text')
})
