/**
 * The rig's bounded-goal fixture (#138), pinned because a bounded budget is the whole reason a goal leg can be a tape.
 *
 * Written against the shape upstream's own fixture uses (`seed-goal.ts`: `inject = ['goals']`, `agent/pre-step`,
 * `goals.create(agent, { objective, maxGoalRounds })`). My first version skipped `inject` and read `ctx.goals` from a
 * context that never received the service — the plugin mounted, looked wired in the boot's plugin list, and did
 * nothing. So the fake below serves `goals` the way cordis does, keyed off `inject`, and the row asserts the handler
 * was actually SUBSCRIBED, not just that a function exists.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const load = async () => await import('../../tests/e2e/fixtures/rig-goal-plugin.js')

test('the fixture subscribes at pre-step and creates a bounded goal from the marker', async () => {
  const mod = await load()
  assert.deepEqual(mod.inject, ['goals'], '`inject` must name the services it reads — without it ctx.goals is absent')
  const handlers = []
  const created = []
  const ctx = {
    on: (event, fn) => { handlers.push({ event, fn }) },
    goals: { get: () => undefined, create: (agent, request) => { created.push({ agent, request }); return request } },
  }
  mod.apply(ctx)
  assert.equal(handlers.length, 1, `one listener subscribed, got ${String(handlers.length)}`)
  assert.equal(handlers[0].event, 'agent/pre-step', 'subscribed where a pending human message is visible')

  const agent = { id: 'A', inbox: { nextStep: [{ content: [{ type: 'text', text: 'RIG-GOAL Ship the widget and verify it in the browser' }] }], nextTurn: [] } }
  let nexted = 0
  await handlers[0].fn({ agent }, () => { nexted++ })
  assert.equal(nexted, 1, 'next() must be called — a waterfall listener that swallows it stalls the step')
  assert.equal(created.length, 1, 'the marker created exactly one goal')
  assert.deepEqual(created[0].request, { objective: 'Ship the widget and verify it in the browser', maxGoalRounds: 1 },
    `a 256-round goal puts latency back in the tape, got ${JSON.stringify(created[0].request)}`)
})

test('an unmarked turn creates nothing, and a lone number is an objective rather than a budget', async () => {
  const { parseGoalMarker } = await load()
  assert.equal(parseGoalMarker('Reply with exactly: OK'), null, 'no marker, no goal')
  assert.equal(parseGoalMarker('RIG-GOAL'), null, 'a bare marker has no objective to bind')
  assert.deepEqual(parseGoalMarker('RIG-GOAL migrate the index 3'), { objective: 'migrate the index', maxGoalRounds: 3 })
  assert.deepEqual(parseGoalMarker('RIG-GOAL 2026'), { objective: '2026', maxGoalRounds: 1 })
})

test('a goal that already exists is not re-created, and a missing service cannot wedge the boot', async () => {
  const mod = await load()
  let nexted = 0
  const existing = { on: (_e, fn) => { void fn({ agent: { inbox: { nextStep: [{ content: 'RIG-GOAL x' }] } } }, () => { nexted++ }) },
    goals: { get: () => ({ id: 'G' }), create: () => { throw new Error('must not be called') } } }
  mod.apply(existing)
  assert.equal(nexted, 1, 'pre-existing goal: pass through with next()')

  let bare = 0
  const noService = { on: (_e, fn) => { void fn({ agent: { inbox: { nextStep: [] } } }, () => { bare++ }) } }
  mod.apply(noService)
  assert.equal(bare, 1, 'a plane without the goals service must still reach next()')
})
