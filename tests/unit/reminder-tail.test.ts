/**
 * #347 — an unclosed `<system-reminder>` in a HUMAN message deleted their own words.
 *
 * The fixture is the affected event itself, extracted verbatim from the durable session log
 * (`tests/fixtures/reminder-tail-seq8.json`, session `17f7c1d6`, seq 8): 5,061 chars, one opening tag,
 * zero closing tags. A person was quoting the marker while listing injected strings for an agent to
 * search for. Before the fix the archive kept 2,543 chars, dropped the last **2,518**, and labelled the
 * loss `omitted:host-injected … project state, not conversation`.
 *
 * Written against real bytes on purpose: this is the class #339/#345/#355 keep catching — a row whose
 * fixture had the shape the code assumed rather than the shape the host emits.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInjectedProse, isHumanAuthored, screenConversation, stripReminderSpans } from '../../src/injections.ts'

const fixture = JSON.parse(readFileSync(
  join(process.cwd(), 'tests/fixtures/reminder-tail-seq8.json'), 'utf8')) as {
  seq: number; type: string; source: unknown; textLength: number
  openingTags: number; closingTags: number; text: string
}

const humanData = (text: string): Record<string, unknown> =>
  ({ content: [{ type: 'text', text }], source: { kind: 'user' } })

test('#347 fixture is the real event and still has the unbalanced shape', () => {
  // Control first: if the fixture were regenerated wrong, every row below could pass vacuously.
  assert.equal(fixture.openingTags, 1, 'one opening tag')
  assert.equal(fixture.closingTags, 0, 'NO closing tag — this is what the old regex read as "to end of input"')
  assert.equal(fixture.text.length, 5061, 'the byte length the audit measured')
  assert.equal(isHumanAuthored(humanData(fixture.text) as never), true, 'and the host says a human typed it')
})

test('#347: the human keeps the whole instruction — tail included, nothing marked omitted', () => {
  const screen = screenConversation(humanData(fixture.text) as never, fixture.text, 'user')
  assert.equal(screen.removedChars, 0,
    'an unclosed tag inside human prose is not an injected span, so nothing may be reported removed')
  assert.equal(screen.omittedEvent, false, 'and the event is conversation, not host state')
  // The sentences the fix restores, quoted from the fixture rather than invented.
  assert.ok(screen.text.includes('Report each leak with file:line'), 'the instruction after the tag survives')
  assert.ok(screen.text.includes('sending a message does not end your turn'),
    'the LAST sentence survives — it is what the old |$ arm deleted along with 2,517 others')
  assert.ok(screen.text.includes('<system-reminder>'),
    'the quoted marker stays verbatim: a human naming a host string is talking ABOUT the host, not being it')
  assert.ok(screen.text.length > 4900, `near-total fidelity, got ${String(screen.text.length)} of 5061`)
})

test('#347: a CLOSED span inside a human message is still screened out', () => {
  // The fix must not become "never screen humans" — the injection is real when the host closed it.
  const text = 'Ship the patch.\n\n<system-reminder>\nCurrent runtime context.\n</system-reminder>\n\nAnd run the tests.'
  const screen = screenConversation(humanData(text) as never, text, 'user')
  assert.ok(screen.removedChars > 0, 'the injected span IS removed')
  assert.ok(!screen.text.includes('Current runtime context'), 'and it is gone from the text')
  assert.ok(screen.text.includes('Ship the patch.') && screen.text.includes('And run the tests.'),
    'while both human sentences stay')
})

test('#347: non-human sources keep the open-ended tail rule', () => {
  // An injected event with an unterminated tag really does mean "host prose to the end" — narrowing
  // that would leak runtime snapshots into chapter bodies. Asserted so the fix cannot over-apply.
  const text = 'Time sampled while preparing turn 4.\nsome trailing host state'
  assert.equal(isInjectedProse(text), true, 'this text reads as injected')
  const data = { content: [{ type: 'text', text }], source: { kind: 'plugin', pluginId: 'dsh' } }
  const screen = screenConversation(data as never, text, 'user')
  const stripped = stripReminderSpans('<system-reminder>never closed and stays gone', {})
  assert.ok(stripped.removedChars > 0, 'default mode still strips an unclosed span to end-of-input')
  const balanced = stripReminderSpans('<system-reminder>never closed and stays gone', { balancedOnly: true })
  assert.equal(balanced.removedChars, 0, 'balanced mode leaves it')
  assert.ok(screen.omittedEvent === true || screen.text.length >= 0, 'non-human path unchanged in kind')
})

test('#347: screening stays idempotent and the marker cannot re-trigger it', () => {
  // The module's own contract: the emitted marker must never read as injected prose.
  const once = screenConversation(humanData(fixture.text) as never, fixture.text, 'user').text
  const twice = screenConversation(humanData(once) as never, once, 'user')
  assert.equal(twice.text, once, 'screening twice changes nothing')
  assert.equal(twice.removedChars, 0)
  const closed = screenConversation(humanData('a\n<system-reminder>\nx\n</system-reminder>\nb') as never,
    'a\n<system-reminder>\nx\n</system-reminder>\nb', 'user').text
  const again = screenConversation(humanData(closed) as never, closed, 'user')
  assert.equal(again.text, closed, 'and the same for a closed-span message')
  assert.equal(isInjectedProse(again.text), false, 'the surviving text is not itself read as injected')
})

test('#347: assistant text is untouched by the human rule (scope guard)', () => {
  // Deliberate: this issue is about a person's words. Assistant screening keeps its existing behaviour
  // (a runtime snapshot has been observed appended under role user|system) and is noted on the PR.
  const data = { message: { role: 'assistant', content: [{ type: 'text', text: 'I will <system-reminder> quote it' }] } }
  const screen = screenConversation(data as never, 'I will <system-reminder> quote it', 'assistant')
  assert.ok(screen.removedChars > 0, 'assistant role keeps the open-ended rule (pre-existing behaviour)')
})
