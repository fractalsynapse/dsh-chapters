/**
 * #314 — the seeded-continuation load deadlock, pinned against the host's OWN reader.
 *
 * The kernel records a first-turn `system/message` (the composed header) into every session it
 * runs, and its native-V4 relationships validator admits that event ONLY as the protected first
 * surface head. Our continuation seed is `user/message@0` (the sanctioned shape — invariant 2,
 * `agents.create({seed:[notice]})`), so the recorded header lands mid-surface and the log then
 * fails its own load validation forever: the GUI refuses the child after any restart
 * ("system/message requires a protected first surface head", gateway/internal). Measured
 * 2026-11-05 on the maintainer's box: 4/4 seeded children, byte-perfect logs, all four passing
 * cleanly once the FIRST system/message is allowed to adopt the head at any position —
 * resolution option (d) in the upstream report (var/host-bug-report.md).
 *
 * Three rows, and the third is the point:
 *   1. EVIDENCE  — the installed reader throws on the seeded shape (today's contract).
 *   2. CONTROL   — the same engine event loads fine as the first surface node (the reader and
 *                  our fixtures are real; row 1 cannot be a vacuous red).
 *   3. WISH      — the seeded shape must VALIDATE, as a `{ todo: ... }` row: today it reports
 *                  `not ok # TODO` (the deadlock, visibly red where anyone looks, while the
 *                  suite stays green — the only honest way to ship a known-failure into CI;
 *                  node:test's `failing` option does NOT invert on this runner, measured here,
 *                  it only passes tests that already pass). The day a host release lands
 *                  option (d), validate() stops throwing, the row goes GREEN, and the whole
 *                  file flips to its retired form: delete the `failing` expectations in rows 1
 *                  and 2 (they throw no more) and clear the todo marker.
 *                  Do not delete rows 1–3 — retire them together with the host-line bump.
 *
 * If the host packages do not resolve, the rows say SKIP in their NAMES — an unmeasured gate
 * must never look like a passed one (the pattern this file copies from host-seed-contract).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTocNotice } from '../../src/notice.ts'

const FORMAT = '@deepseek-ai/dsh-session-format-v3-to-v4'
const KERNEL = '@deepseek-ai/dsh-session'
const format = await import(FORMAT).catch(() => null)
const kernel = await import(KERNEL).catch(() => null)
const ready = format !== null && kernel !== null
const guard = ready ? 'RUN' : 'SKIP'
const skipReason = ready ? false : `${FORMAT}/${KERNEL} not installed (devDependency drift — bump to the live host line)`

type Ev = Record<string, unknown>
const T = 1_700_000_000_000
const header = { id: 'ch-drift-314', version: 4, createdAt: T, cwd: '/tmp/drift', isSeeded: false, delegationDepth: 0, agentPreset: 'chapters' }
const mk = (seq: number, type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): Ev =>
  ({ type, seq, time: T + seq, ...extra, data })

/** The production builder's bytes, at the position the seed places them. */
const noticeAt0 = (): Ev => {
  const ev = buildTocNotice('## Conversation TOC\n\n1. [Drift](x/001.md) — #314 pin row.', {
    newId: () => 'drift-314-notice', time: T,
  }) as unknown as Ev
  return { ...ev, seq: 0, time: T }
}

/** Exactly the shape the kernel's header recorder writes (measured in the corrupted logs):
 *  surfaceOp append, and the message carrying id + system-prompt source — both required,
 *  and the missing-id refusal re-uses the SOURCE-KIND message string (gotcha #1). */
const systemMessage = (seq: number): Ev =>
  mk(seq, 'system/message', {
    turn: 1, step: 1,
    message: { role: 'system', source: { kind: 'system-prompt' }, id: 'drift-314-sm', content: [{ type: 'text', text: 'composed header' }] },
  }, { surfaceOp: 'append' })

const seededShape = (): Ev[] => [
  noticeAt0(),
  mk(1, 'turn/start', { turn: 1 }), mk(2, 'step/start', { turn: 1, step: 1 }),
  systemMessage(3),
  mk(4, 'step/end', { turn: 1, step: 1 }), mk(5, 'turn/end', { turn: 1 }),
]
const healthyShape = (): Ev[] => [
  mk(0, 'turn/start', { turn: 1 }), mk(1, 'step/start', { turn: 1, step: 1 }),
  systemMessage(2),
  mk(3, 'step/end', { turn: 1, step: 1 }), mk(4, 'turn/end', { turn: 1 }),
]

function validate(events: Ev[]): void {
  const f = format as unknown as { assertReleasedV4Relationships(artifact: unknown, known: unknown): void }
  const k = kernel as unknown as { KNOWN_SESSION_EVENT_TYPES: Set<string> }
  f.assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, new Set(k.KNOWN_SESSION_EVENT_TYPES))
}

test(`${guard} — #314 EVIDENCE: the host reader refuses our seeded continuation shape`, { skip: skipReason }, () => {
  assert.throws(() => validate(seededShape()), /system\/message requires a protected first surface head/)
})

test(`${guard} — #314 CONTROL: the same engine event loads fine as the first surface node`, { skip: skipReason }, () => {
  validate(healthyShape()) // any throw fails the row: this is what makes row 1 non-vacuous
})

test(`${guard} — #314 WISH: the seeded child must load (TODO until host option-d lands)`, {
  skip: skipReason, todo: 'the host fold rule still refuses the seeded shape — green = option (d) landed; then retire rows 1–2',
}, () => {
  validate(seededShape())
})
