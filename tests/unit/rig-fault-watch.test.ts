/**
 * One matching journal line ends the leg (#108). The pins make the CAUSE knowable in one second; this makes
 * the RUN cost one second too, instead of 22+ minutes of browser timeouts per spec.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findRigFault } from '../../tests/e2e/rig-fault.ts'

const FAULT = '2026-10-25T02:00:00.000Z RIG-CAPABILITIES tape=suite missing=[chaptersRules] present=[deliverables] — see #108'

test('findRigFault reads the journal as a diagnosis stream (#108)', () => {
  assert.equal(findRigFault(''), null, 'an empty journal is not a fault')
  assert.equal(findRigFault('2026-10-25T02:00:00Z HIT tape=suite served=0000.json\n'), null, 'a hit is not a fault')
  assert.equal(findRigFault('2026-10-25T02:00:00Z MISS tape=suite entries=7 divergeAt=msg0\n'), null,
    'an ordinary prefix miss stays a tape failure — it is NOT permission to abort a run that might recover')
  assert.match(findRigFault(`noise\n${FAULT}\nmore`), /RIG-CAPABILITIES/)
  assert.match(findRigFault('2026-1-1 PERSONA-MISMATCH tape=x'), /PERSONA-MISMATCH/, 'the persona refusal aborts too')
  assert.match(findRigFault('2026-1-1 PERSONA-RECORD-REFUSED tape=x'), /PERSONA-RECORD-REFUSED/, 'and the record refusal')
})
/**
 * The late-creation and fire-once properties formerly tested here now live in
 * `tests/unit/rig-fault-guard.test.ts`, which drives the single public entry point
 * (`installRigFaultGuard`) and additionally pins stop-before-exit. One predicate, one place to test it —
 * coverage moved, nothing was dropped.
 */
