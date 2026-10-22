/**
 * The seventh archive moment and Amendment B of the injection screen (#61).
 *
 * Both halves have a measured field case, and both are gates that must be able to SAY why they
 * declined: a door that fires on everything is a door that archives a user's own session behind their
 * back; a screen that widens by kind alone swallows a project's private instruction files.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldForceChildArchive } from '../../src/auto-save.ts'
import { isArchivableConversation, isHumanAuthored, screenConversation } from '../../src/injections.ts'

const base = { chapterCount: 1, lastArchivedSeq: 100, anchor: 140, completedTurnsAboveWatermark: 6, minTurns: 4, enabled: true }

test('the forced child archive fires exactly where door 5 cannot reach (#61)', () => {
  // the field case: ch-dc3be3ab — 2,363 events, 414 tool calls, 2 completed turns, chapters: []
  const neverArchived = shouldForceChildArchive({ ...base, header: { origin: 'user', agentPreset: 'chapters', parentSession: 'session-parent' }, chapterCount: 0, completedTurnsAboveWatermark: 2 })
  assert.equal(neverArchived.fire, true, `a rooted chapters child with nothing archived must fire: ${neverArchived.reason}`)
  assert.match(neverArchived.reason, /never archived/)

  // door 5 owns delegation — two doors on one child double-write the same span
  assert.equal(shouldForceChildArchive({ ...base, header: { origin: 'subagent', agentPreset: 'chapters', parentSession: 'p' } }).fire, false)
  // THE FIELD SHAPE, measured 2026-10-22: `ch-dc3be3ab` has NO header parentSession and NO origin —
  // the first version of this gate asked the header alone and would have walked past the exact case it
  // was written for. Lineage from the `ch-` id (or the registry row) counts.
  const fieldShape = shouldForceChildArchive({ ...base, header: { agentPreset: 'chapters' }, lineageParent: 'continuation-id', chapterCount: 0, completedTurnsAboveWatermark: 2 })
  assert.equal(fieldShape.fire, true, `a ch- child with no header lineage must still fire: ${fieldShape.reason}`)
  const rowLineage = shouldForceChildArchive({ ...base, header: { agentPreset: 'chapters' }, lineageParent: 'session-parent', chapterCount: 0, completedTurnsAboveWatermark: 2 })
  assert.equal(rowLineage.fire, true, 'a registry-row parent counts too (linkChild wrote it)')
  // the user's own session belongs to doors 1–3; archiving it behind them is not this plugin's call
  const root = shouldForceChildArchive({ ...base, header: { origin: 'user', agentPreset: 'chapters' } })
  assert.equal(root.fire, false, 'no lineage at all ⇒ a root session')
  assert.match(root.reason, /root session/)
  // a different preset is none of our business
  assert.equal(shouldForceChildArchive({ ...base, header: { origin: 'user', agentPreset: 'standard', parentSession: 'p' } }).fire, false)
  // below the lag: quiet
  const lag = shouldForceChildArchive({ ...base, header: { origin: 'user', agentPreset: 'chapters', parentSession: 'p' }, completedTurnsAboveWatermark: 2 })
  assert.equal(lag.fire, false)
  assert.match(lag.reason, /childAutoArchiveMinTurns/, 'and it names the config key that held it')
  // the operator closed the door
  const off = shouldForceChildArchive({ ...base, header: { origin: 'user', agentPreset: 'chapters', parentSession: 'p' }, enabled: false })
  assert.equal(off.fire, false)
  assert.match(off.reason, /childAutoArchive is off/)
})

test('Amendment B: a delegate\u2019s report is conversation; a project\u2019s instructions are not (#61)', () => {
  const ev = (source: Record<string, string>, text: string) => ({ role: 'user', source, content: [{ type: 'text', text }] })
  const shapes: Array<[string, Record<string, string>, boolean]> = [
    ['agent-message (the report itself)', { kind: 'agent-message', form: 'relay' }, true],
    ['subagent-settled (when it finished)', { kind: 'subagent-settled', form: 'notice' }, true],
    ['agent-instructions (a project\u2019s private file)', { kind: 'agent-instructions', form: 'instructions' }, false],
    ['plan-mode notice (the existing exception)', { kind: 'plan-mode', form: 'notice' }, true],
    ['a runtime snapshot', { kind: 'runtime-context', form: 'snapshot' }, false],
    ['the TOC notice we seed ourselves', { kind: 'plugin:dsh-chapters', form: 'snapshot' }, false],
    // widened-by-accident guards: same producer, DIFFERENT form ⇒ still screened
    ['agent-message with no form', { kind: 'agent-message' }, false],
    ['subagent-settled as a snapshot', { kind: 'subagent-settled', form: 'snapshot' }, false],
  ]
  for (const [label, source, want] of shapes) {
    const got = isArchivableConversation(ev(source, 'x') as never)
    assert.equal(got, want, `${label}: expected archivable=${want}`)
  }
})

test('the report reaches the chapter text; the instruction file does not (#61 behaviour, not source)', () => {
  const report = { type: 'user/message', seq: 3, data: { role: 'user', source: { kind: 'agent-message', form: 'relay' }, content: [{ type: 'text', text: 'Agent a132bfe4-282a-4df1-97a8-58b8243b445d sent a message: Both Starlight documentation files have been written.' }] } }
  const instructions = { type: 'user/message', seq: 4, data: { role: 'user', source: { kind: 'agent-instructions', form: 'instructions' }, content: [{ type: 'text', text: 'This project uses pnpm and never touches gradle.' }] } }
  const reportText = (report.data.content[0] as { text: string }).text
  const kept = screenConversation(report.data as never, reportText, 'user')
  assert.equal(kept.omittedEvent, false, 'the delegate report is archived')
  assert.match(kept.text, /Both Starlight documentation files/)
  const instrText = (instructions.data.content[0] as { text: string }).text
  const dropped = screenConversation(instructions.data as never, instrText, 'user')
  assert.equal(dropped.omittedEvent, true, 'the project instruction file stays out of the shared corpus')
})

test('topic signatures still IGNORE the report — the r28 rule survives (#61)', () => {
  const report = { role: 'user', source: { kind: 'agent-message', form: 'relay' }, content: [{ type: 'text', text: 'x' }] }
  assert.equal(isHumanAuthored(report as never), false,
    'isHumanAuthored stays strict: a 2 KB report must not drag a signature toward the filenames it mentions')
})
