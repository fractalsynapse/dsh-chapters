/**
 * One matching journal line ends the leg (#108). The pins make the CAUSE knowable in one second; this makes
 * the RUN cost one second too, instead of 22+ minutes of browser timeouts per spec.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findRigFault, watchRigFault } from '../../tests/e2e/rig-fault.ts'

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

test('watchRigFault fires once, when the journal appears late (#108)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigfault-'))
  const journal = path.join(dir, 'e2e-tape-misses.log')
  const seen: string[] = []
  const stop = watchRigFault(journal, (line) => { seen.push(line) })
  try {
    await new Promise((r) => setTimeout(r, 1200))
    assert.deepEqual(seen, [], 'a journal that does not exist yet is not a fault')
    fs.writeFileSync(journal, `2026-1-1 HIT tape=suite\n${FAULT}\n`)
    const deadline = Date.now() + 6000
    while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
    assert.equal(seen.length, 1, 'the fault is reported exactly once')
    assert.match(seen[0]!, /RIG-CAPABILITIES/)
    fs.appendFileSync(journal, `\n${FAULT}\n`)
    await new Promise((r) => setTimeout(r, 1500))
    assert.equal(seen.length, 1, 'and later lines do not re-fire the abort')
    stop()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
