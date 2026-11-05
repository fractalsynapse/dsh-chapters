/**
 * #319 — the reload self-check, tested against BOTH truths: our predicate's verdicts on the
 * canonical shapes, and the VENDOR's own reader on the same fixtures. Agreement is the contract;
 * if their fold rule moves, the equivalence row goes red long before a chair gets surprised.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reloadRuleRefusal, type ReloadEvent } from '../../src/reload-check.ts'

const T = 1_700_000_000_000
const mk = (seq: number, type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): ReloadEvent =>
  ({ type, seq, time: T + seq, ...extra, data })
const sm = (seq: number) => mk(seq, 'system/message', { turn: 1, step: 1, message: { role: 'system', source: { kind: 'system-prompt' }, id: 'sm' + seq, content: [{ type: 'text', text: 'H' }] } }, { surfaceOp: 'append' })

const CHILD = [
  mk(0, 'user/message', { id: 'n', role: 'user', source: { kind: 'plugin:dsh-chapters', form: 'snapshot', sections: [{ name: 'chapters:toc', text: '# T' }] }, content: [{ type: 'text', text: '# T' }] }, { surfaceOp: 'append' }),
  mk(1, 'turn/start', { turn: 1 }), mk(2, 'step/start', { turn: 1, step: 1 }), sm(3),
  mk(4, 'step/end', { turn: 1, step: 1 }), mk(5, 'turn/end', { turn: 1 }),
]
const ROOT = [
  mk(0, 'permission/preset', { presetId: 'p' }), mk(1, 'sandbox/mode', {}),
  mk(2, 'turn/start', { turn: 1 }), mk(3, 'step/start', { turn: 1, step: 1 }), sm(4),
  mk(5, 'step/end', { turn: 1, step: 1 }), mk(6, 'turn/end', { turn: 1 }),
]

test('#319 the seeded-child shape is refused, named at the exact event', () => {
  const r = reloadRuleRefusal(CHILD)
  assert.ok(r !== null, 'the deadlock must be predicted')
  assert.equal(r!.seq, 3); assert.equal(r!.rule, 'protected-head')
})
test('#319 the root shape (setup events, then the kernel header as first surface node) passes', () => {
  assert.equal(reloadRuleRefusal(ROOT), null)
})
test('#319 non-surface events never count toward the surface', () => {
  const noisy = [mk(0, 'command/run', {}), mk(1, 'turn/start', { turn: 1 }), mk(2, 'step/start', { turn: 1, step: 1 }), sm(3), mk(4, 'step/end', { turn: 1, step: 1 }), mk(5, 'turn/end', { turn: 1 })]
  assert.equal(reloadRuleRefusal(noisy), null)
})
test('#319 EQUIVALENCE with the vendor reader on both shapes (skip-loud when unresolvable)', async () => {
  const format = await import('@deepseek-ai/dsh-session-format-v3-to-v4').catch(() => null)
  const kernel = await import('@deepseek-ai/dsh-session').catch(() => null)
  if (format === null || kernel === null) { /* the rows above still ran; this row names its own absence */ console.log('SKIP-EQUIVALENCE: host modules unresolvable'); return }
  const known = new Set((kernel as unknown as { KNOWN_SESSION_EVENT_TYPES: Set<string> }).KNOWN_SESSION_EVENT_TYPES)
  const header = { id: 'ch-eq', version: 4, createdAt: T, cwd: '/tmp/e', isSeeded: false, delegationDepth: 0, agentPreset: 'chapters' }
  const vendorVerdict = (events: ReloadEvent[]): boolean => {
    try { (format as unknown as { assertReleasedV4Relationships(a: unknown, k: unknown): void }).assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, known); return true } catch { return false }
  }
  assert.equal(vendorVerdict(ROOT), true, 'vendor accepts the root shape')
  assert.equal(reloadRuleRefusal(ROOT), null, 'we agree: pass')
  assert.equal(vendorVerdict(CHILD), false, 'vendor refuses the child shape')
  assert.ok(reloadRuleRefusal(CHILD) !== null, 'we agree: refuse')
})
