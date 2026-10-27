/**
 * A strict-replay MISS is a rig fault, not a soft warning (#56).
 *
 * Measured 2026-10-26: `heavy` PASSED in the chain while the journal recorded two misses for it
 * (`MISS tape=heavy … messages=4` and `… messages=8`). A leg that passes while its tape could not answer
 * requests is a leg that did not run the journey it claims to have run — and the chain's green was therefore
 * worth less than it looked. The guard already stops a leg for persona/capability faults; the same rule has to
 * cover `MISS` when the mode is replay, because in replay there is no legitimate reason to miss.
 *
 * The distinction is kept explicit rather than global: in record and heal, a miss is the mechanism — the proxy
 * forwards live and appends. Enabling the pattern only under replay is what makes both statements true at once.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { findRigFault, REPLAY_MISS_PATTERN, RIG_FAULT_PATTERN } from '../../tests/e2e/rig-fault.ts'

const JOURNAL = [
  '2026-10-26T23:40:11.000Z HIT tape=heavy entries=47 messages=3',
  '2026-10-26T23:40:19.000Z MISS tape=heavy entries=47 messages=4 closest=0001.json commonPrefix=3 divergeAt=msg3',
].join('\n')

test('a miss is invisible to the persona/capability pattern alone', () => {
  assert.equal(findRigFault(JOURNAL), null, 'the existing behavior must not change for record/heal')
})

test('a miss is a fault when the guard is told replay semantics', () => {
  const found = findRigFault(JOURNAL, REPLAY_MISS_PATTERN)
  assert.ok(found !== null && found.includes('MISS tape=heavy'), `the miss line must be reported: ${found}`)
  assert.ok(!found.includes('HIT'), 'and not the innocent line')
})

test('a hit-only journal is clean under replay semantics too', () => {
  assert.equal(findRigFault('2026-10-26T23:40:11.000Z HIT tape=heavy entries=47 messages=3', REPLAY_MISS_PATTERN), null,
    'no false alarm on a tape that answered everything')
})

test('the patterns are additive, never replacing the persona guard', () => {
  const persona = '2026-10-26T23:40:19.000Z RIG-CAPABILITIES host lacks preset rows'
  assert.ok(findRigFault(persona, REPLAY_MISS_PATTERN) === null, 'the miss pattern does not claim a persona line')
  assert.ok(findRigFault(persona) !== null, 'the default pattern still catches it')
  assert.ok(findRigFault(persona, new RegExp(`${RIG_FAULT_PATTERN.source}|${REPLAY_MISS_PATTERN.source}`)) !== null,
    'and they compose into one guard')
})

/**
 * The guard must see only what THIS leg wrote.
 *
 * The journal is append-only across legs, and misses are routine in record/heal — so a replay leg that scanned
 * the whole file would abort on some other leg's history before its own browser had even opened. This is the
 * same trap `RIG FAULT` ordering caught on 2026-10-24 (a line that predated the boot), now on the miss axis.
 */
test('a fault line that predates the guard is not this leg’s fault', async () => {
  const { installRigFaultGuard } = await import('../../tests/e2e/rig-fault.ts')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigfault-'))
  const journal = path.join(dir, 'misses.log')
  try {
    fs.writeFileSync(journal, '2026-10-26T20:00:00Z MISS tape=suite entries=34 messages=9 (some other leg)\n')
    let exited = 0
    const stop = installRigFaultGuard({ journal, getStopBoot: () => null, exit: () => { exited += 1 }, intervalMs: 20, waitMs: 30, pattern: REPLAY_MISS_PATTERN })  // waitMs is short: the guard asks for a boot to stop before exiting, and there is no boot here
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(exited, 0, 'a pre-existing miss must not stop this leg')
    fs.appendFileSync(journal, '2026-10-26T20:01:00Z MISS tape=prompt entries=546 messages=6 (this leg)\n')
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(exited, 1, 'but a miss written after the guard was installed must')
    stop()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
