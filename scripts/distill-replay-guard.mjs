/**
 * #411 — classification table for distill's replay-after-record gate.
 *
 * The lesson this encodes (measured at #340's re-anchor): a leg whose RECORD went green can
 * still carry an unrecorded call — the post-Run suggestion regeneration won a teardown race
 * against live streaming at record time but fires under replay's instant cache. Only a STRICT
 * REPLAY after every green record sees that class; only ONE bounded heal is attempted, because
 * a second miss after healing is a product/spec question, not a tape gap. The same logic in the
 * other direction: a failing replay with ZERO new MISS lines is a leg failure — healing it would
 * paper a real defect onto the corpus.
 *
 * Imported by tests/unit/distill-replay-guard.test.ts; called from scripts/distill-tapes.sh via
 * `node --input-type=module -e` (a sourced bash loop stays readable; the DECISION stays testable).
 */

/**
 * @param input {{recordRc:number, entries:number, replayRc:number|null, newMisses:number|null, healed?:boolean}}
 * @returns {{action:'pass'|'heal'|'fail', verdict:string}}
 */
export function classifyLeg(input) {
  const { recordRc, entries, replayRc, newMisses } = input
  const healed = input.healed === true
  if (recordRc !== 0) return { action: 'fail', verdict: `record exit=${String(recordRc)}` }
  if (entries === 0) {
    return { action: 'fail', verdict: 'VACUOUS — exit 0 with zero tape entries (the journey never ran; refusing)' }
  }
  if (replayRc === null || replayRc === undefined) {
    return { action: 'fail', verdict: 'replay-after-record never ran — a tape is only proven by strict replay (#411)' }
  }
  if (replayRc === 0) {
    return {
      action: 'pass',
      verdict: healed
        ? `record+replay green (healed=1, ${String(entries)} entries)`
        : `record+replay green (${String(entries)} entries)`,
    }
  }
  if (!healed && (newMisses ?? 0) > 0) {
    return { action: 'heal', verdict: `replay exit=${String(replayRc)} with ${String(newMisses)} new tape MISS(es) — one bounded heal` }
  }
  if ((newMisses ?? 0) === 0) {
    return { action: 'fail', verdict: `replay exit=${String(replayRc)} with NO new tape MISS — leg failure, not a corpus gap (healing would hide it)` }
  }
  return { action: 'fail', verdict: `replay still failing after the one allowed heal (${String(newMisses)} new MISS(es)) — a product/spec question, not a tape gap` }
}
