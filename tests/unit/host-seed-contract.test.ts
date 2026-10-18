/**
 * The host-drift gate for the seeded continuation (docs/plans-carriage.md § 10).
 *
 * Seeding `plan/mode` into a continuation child is the one place this plugin leans on
 * kernel internals: it works because the host (a) KNOWS the `plan/mode` event type and
 * (b) treats it as LOG-ONLY, never surface-eligible. Both facts were measured against
 * the installed kernel on 2026-10-10 — and neither is checked by anything else in the
 * suite, which is exactly how a kernel upgrade would turn into silent behavioural
 * drift: a child that is no longer gated, or a seed the constructor refuses outright,
 * with every test still green.
 *
 * These rows read the kernel's own exported predicates rather than reimplementing its
 * rules, so they fail when the kernel's INTENT changes, not when its code is refactored.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildTocNotice } from '../../src/notice.ts'

const KERNEL = '@deepseek-ai/dsh-session'

const kernel = await import(KERNEL).catch(() => null)

// The host is a devDependency: if it cannot be resolved the gate is not "skipped
// quietly", it is unmeasured — so say which, in the test name.
const guard = kernel === null ? 'SKIP' : 'RUN'

test(`${guard} — plan/mode is a kernel-known event type`, { skip: kernel === null ? `${KERNEL} not installed` : false }, async () => {
  assert.ok(kernel !== null)
  const types = kernel.KNOWN_SESSION_EVENT_TYPES as Set<string>
  assert.equal(types.has('plan/mode'), true,
    'the host stopped knowing plan/mode: a seeded plan/mode event would now be rejected, and continuations would silently stop being gated')
})

test(`${guard} — plan/mode is log-only, never surface-eligible`, { skip: kernel === null ? `${KERNEL} not installed` : false }, async () => {
  assert.ok(kernel !== null)
  assert.equal(kernel.isSurfaceEligibleType('plan/mode'), false,
    "the host made plan/mode surface-eligible: the seeded event would enter the child's context, changing what a continuation is charged for")
})

test(`${guard} — the surface/append predicates still distinguish the seed shape`, { skip: kernel === null ? `${KERNEL} not installed` : false }, async () => {
  assert.ok(kernel !== null)
  // `isAppendSurfaceEvent` narrows on the event's MARKER as well as its type, so a
  // hand-built object is not evidence about the kernel — an earlier revision of this
  // row asserted on its own fixture and "failed" for that reason. The notice's
  // reachability is proven end to end instead: the browser journey reads the child's
  // TOC back off the durable log. What is gated here is the type-level intent, which
  // is the part a kernel change can flip without touching our code.
  assert.equal(kernel.isSurfaceEligibleType('user/message'), true, 'the notice event must stay surface-eligible')
  const mode = { type: 'plan/mode', seq: 1, data: { active: true } }
  assert.equal(kernel.isAppendSurfaceEvent(mode as never), false, 'a seeded plan/mode stays out of the surface')
  const flip = { type: 'plan/mode', seq: 2, data: { active: false } }
  assert.equal(kernel.isAppendSurfaceEvent(flip as never), false, 'and so does the exit flip')
})

test(`${guard} — a plugin-authored synthetic event is a permitted shape`, { skip: kernel === null ? `${KERNEL} not installed` : false }, async () => {
  assert.ok(kernel !== null)
  // Invariant 2's amendment depends on the plugin authoring the state event itself.
  // adoptSessionEvent is the host's own coercion boundary; if it starts rejecting a
  // synthetic plan/mode, the seed contract is gone and the child is not gated.
  const adopted = kernel.adoptSessionEvent({ type: 'plan/mode', seq: 1, data: { active: true } } as never)
  assert.equal(adopted?.type, 'plan/mode')
})

// ------------------------------------------------------ v4 source admission (issue #43)
//
// Session format v4 (host 0.2.x) RETIRED the bare `source.kind: 'plugin'` wrapper:
// the kernel refuses it at persistence-row admission with
// "format v4 message requires a producer-owned source kind". This gate measures the
// refusal AND the admission against the kernel's OWN migration module
// (`@deepseek-ai/dsh-session-format-v3-to-v4`, devDependency pinned to the live
// host line) — not against our transcription in src/notice.ts. If the kernel's
// vocabulary moves again, these rows go red while the continuation still works
// or breaks LOUDLY — never silently the way 0.2.0-rc.2 broke every seed in the dark.

const FORMAT = '@deepseek-ai/dsh-session-format-v3-to-v4'
const format = await import(FORMAT).catch(() => null)
const fguard = format === null ? 'SKIP' : 'RUN'

test(`${fguard} — the v4 kernel ADMITS the notice as our builder emits it`, {
  skip: format === null ? `${FORMAT} not installed (bump devDependencies to the live host line)` : false,
}, () => {
  assert.ok(format !== null)
  const event = buildTocNotice('## Conversation TOC\n\n1. [Probe](p/001.md) — pin row.', {
    newId: () => 'gate-notice-1', time: 1700000000000,
  })
  // Throws SessionFormatError on any retired shape; silent return = admitted.
  format.assertV4RowAdmission(event as never)
})

test(`${fguard} — the v4 kernel REFUSES the retired plugin wrapper we no longer emit`, {
  skip: format === null ? `${FORMAT} not installed` : false,
}, () => {
  assert.ok(format !== null)
  const retired = {
    type: 'user/message', seq: 0, time: 1700000000000, surfaceOp: 'append',
    data: {
      id: 'gate-notice-2', role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-chapters', form: 'snapshot', sections: [{ name: 'chapters:toc', text: 'x' }] },
      content: [{ type: 'text', text: 'x' }],
    },
  }
  assert.throws(() => format.assertV4RowAdmission(retired as never), /producer-owned source kind/,
    'the kernel stopped refusing the retired wrapper: our refusal text in src/notice.ts is a transcription that must be re-anchored together with this row')
})
