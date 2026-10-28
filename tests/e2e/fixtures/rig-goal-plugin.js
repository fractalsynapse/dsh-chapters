/**
 * RIG-ONLY fixture (#138): opens a goal whose round budget is bounded, with no model cooperation.
 *
 * Why this exists. A goal round is itself a turn and every turn ends, so an armed goal drives itself round after round
 * (`packages/goal/goal/src/index.ts` stops only at `roundsStarted >= maxGoalRounds`; the human `/goal` command passes
 * no budget, so the default is 256). In tape replay the proxy answers instantly, so however many rounds precede a
 * click is machine latency — which is what made `prompt`'s goal test fail on the runner twice for docs-only changes
 * (runs 40677174778 / 40706037817: `MISS tape=prompt … storedCandidates: []`, the runner holding
 * `Round: 1/256`…`Round: 4/256` where the capture had none).
 *
 * The shape is copied from upstream's own test fixture, `packages/goal/goal/tests/fixtures/domain/seed-goal.ts`, which
 * documents the same hazard in its own words: *"An armed goal makes the shipped goal-round-driver start a round at
 * idle, racing the test driver's disposal."* Two facts from that file matter here:
 *
 *   - `export const inject = ['goals']` is what makes `ctx.goals` real. My first version omitted `inject` and read
 *     `ctx.goals` anyway: the plugin mounted (it appeared in the boot's plugin list) and did nothing, and the leg
 *     failed at `the host goal bar appears once a goal exists` while looking perfectly wired. Presence is not shape.
 *   - With a budget of 1 the driver reaches a state it CANNOT leave, so a leg may wait for it and then act. That is a
 *     bound; "wait until a round appears" was not, because at 256 the next round is always pending.
 *
 * Opt-in by marker, so only the leg that asks for a goal gets one: the human turn says `RIG-GOAL <objective>
 * [rounds]` and this fixture creates the goal on the step that carries it. Nothing here ships — mounted only by e2e
 * boots that ask for it, and in no preset the product declares.
 */

/** Text of a pending inbox message, tolerant of block-array and plain-string content. */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : (b?.text ?? ''))).join(' ')
  return ''
}

/** `RIG-GOAL finish the migration 3` → `{ objective, maxGoalRounds }`; rounds default to 1, because one IS the bound. */
export function parseGoalMarker(text) {
  const m = /^\s*RIG-GOAL\s+(.+?)(?:\s+(\d{1,4}))?\s*$/u.exec(String(text ?? ''))
  // The budget must be separated by whitespace: `\s*` here parsed `RIG-GOAL 2026` as objective `2` with 26 rounds.
  if (m === null) return null
  const objective = (m[1] ?? '').trim()
  if (objective === '') return null
  return { objective, maxGoalRounds: m[2] !== undefined && m[2] !== '' ? Number(m[2]) : 1 }
}

export const name = 'dsh-rig-goal-fixture'
export const inject = ['goals']

export function apply(ctx) {
  if (typeof ctx?.on !== 'function') return
  ctx.on('agent/pre-step', ({ agent }, next) => {
    try {
      const goals = ctx.goals
      if (goals === undefined || typeof goals.create !== 'function' || typeof goals.get !== 'function') return next()
      if (goals.get(agent) !== undefined) return next()
      const pending = [...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])]
      for (const message of pending) {
        const request = parseGoalMarker(textOf(message))
        if (request === null) continue
        goals.create(agent, request)
        break
      }
    } catch {
      // A rig fixture must never be able to break the boot under test. Silence here costs a leg that fails loudly on
      // its own missing goal bar — a truthful failure — instead of a wedged server.
    }
    return next()
  })
}

export default { name, inject, apply }
