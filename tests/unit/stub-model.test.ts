/**
 * The scripted upstream's decision rule, pinned because its FIRST version read the
 * whole message array for `exit_plan_mode`/`approved` — words that live in the
 * SYSTEM PROMPT (tool catalog + plan policy) — so every turn answered in prose and
 * the review card never opened. A stub that quietly answers wrongly is worse than
 * no stub: the journey would have recorded a tape of a session that never planned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, PLAN_TRIGGER, STUB_MODEL, SUGGEST_TRIGGER } from '../e2e/stub-model.ts'

const msg = (role: string, content: string) => ({ role, content })

test('the title assembly is its own decision — a single system prompt about titling', () => {
  assert.equal(decide({ messages: [msg('system', 'Create a concise title for an AI coding-assistant session'), msg('user', '[]')] }).kind, 'title')
})

test('a fresh conversation submits the plan — even though the system prompt names exit_plan_mode and approval', () => {
  const withCatalog = [
    msg('system', 'Tools include exit_plan_mode: Present your plan for the user\'s review and, on approval, leave plan mode.'),
    msg('user', `Plan only, then present it with the ${PLAN_TRIGGER} — which file defines the chapter renderer?`),
  ]
  assert.equal(decide({ messages: withCatalog }).kind, 'plan', 'catalog text is NOT a verdict')
})

test('a tool message in the transcript is the only thing that means the human answered', () => {
  const answered = [
    msg('system', 'exit_plan_mode may be approved'),
    msg('user', 'Plan only'),
    { role: 'assistant', content: [], toolCalls: [{ name: 'exit_plan_mode' }] },
    { role: 'tool', content: 'Plan approved' },
  ]
  assert.equal(decide({ messages: answered }).kind, 'after-approval')
})

test('the stub names itself, never impersonates the distilled model', () => {
  assert.equal(STUB_MODEL, 'stub-plan-carriage', 'a tape recorded here must be readable as such')
})

test('the continuation leg uses the ceiling the real tool reported', async () => {
  const { decide, PLAN_TRIGGER } = await import('../e2e/stub-model.ts')
  const segResult = '{"ok":true,"archiveCeiling":37,"eventCount":38,"plans":[],"livePlans":[]}'
  const d = decide({ messages: [
    { role: 'system', content: 'tools include chapters_continue' },
    { role: 'user', content: 'call chapters_segment then chapters_continue' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'chapters_segment' } }] },
    { role: 'tool', content: segResult },
  ] } as never) as { kind: string; toSeq?: number }
  assert.equal(d.kind, 'continue')
  assert.equal(d.toSeq, 37, 'ranges come from the real archiveCeiling')
})

test('an escaped JSON payload parses the ceiling too — the runner-side shape', async () => {
  const { decide, PLAN_TRIGGER } = await import('../e2e/stub-model.ts')
  // What the runner actually sends: the tool payload as a JSON STRING inside a JSON
  // document, so the inner quotes arrive backslash-escaped. Written with
  // JSON.stringify so the escaping is real rather than whatever a source quote
  // happens to mean — the first version of this test passed as a false green.
  const escaped = JSON.stringify(JSON.stringify({ ok: true, archiveCeiling: 41, plans: [] }))
  const d = decide({ messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'call chapters_segment then chapters_continue' },
    { role: 'tool', content: escaped },
  ] } as never) as { kind: string; toSeq?: number }
  assert.equal(d.kind, 'continue', 'escaped quotes must not hide the number')
  assert.equal(d.toSeq, 41)
})

test('an unreadable ceiling refuses to invent a range', async () => {
  const { decide, PLAN_TRIGGER } = await import('../e2e/stub-model.ts')
  const d = decide({ messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'call chapters_segment' },
    { role: 'tool', content: 'archiveCeiling: not-a-number' },
  ] } as never) as { kind: string }
  assert.equal(d.kind, 'no-ceiling', 'a failed parse is reported, not guessed around')
})

test('segment is asked for exactly once — a measured ceiling is not re-measured', async () => {
  const { decide, PLAN_TRIGGER } = await import('../e2e/stub-model.ts')
  const asked = decide({ messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'please run chapters_segment and then chapters_continue' },
  ] } as never)
  assert.equal((asked as { kind: string }).kind, 'segment')
  const after = decide({ messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'please run chapters_segment and then chapters_continue' },
    { role: 'tool', content: '{"ok":true,"childSessionId":"ch-1","budget":{}}' },
  ] } as never)
  assert.equal((after as { kind: string }).kind, 'after-approval', 'the journey closes with text, not another archive')
})

test('the human ask is found even when injected user messages come AFTER it', async () => {
  const { decide, PLAN_TRIGGER } = await import('../e2e/stub-model.ts')
  const d = decide({ messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: `Plan only, no tools. ${PLAN_TRIGGER}.` },
    // what the harness really appends, in this order, after the human's words:
    { role: 'user', content: '<system-reminder> The following workspace instructions may be relevant…' },
    { role: 'user', content: 'Current runtime context. This snapshot supersedes earlier ones.' },
    { role: 'user', content: '<system-reminder> A skill is a reusable set of task-specific instructions…' },
  ] } as never) as { kind: string }
  assert.equal(d.kind, 'plan', 'the LAST user message is the skill catalog — keying on it read "no request" and hung the journey')
})

test('#71: the second reader is its own decision — keyed on the persona phrase, nothing else claims it', () => {
  // The suggest call: one user message, the persona line, no tools.
  assert.equal(decide({ messages: [msg('user', `You are the ${SUGGEST_TRIGGER} — write the next prompt`)] }).kind, 'suggest')
  // A normal conversation message must NOT look like a suggestion request, and the
  // persona phrase appearing anywhere else (system prompt, catalog) must not fire it:
  assert.equal(decide({ messages: [msg('system', `even a ${SUGGEST_TRIGGER} reference in the system prompt`), msg('user', 'hello there')] }).kind, 'plain')
  // The trigger ranks ABOVE the plan arm: a suggest request never carries PLAN_TRIGGER,
  // but if both phrases ever collided, the bounded aux call is answered, not replayed as a plan.
  assert.equal(decide({ messages: [msg('user', `${SUGGEST_TRIGGER} ${PLAN_TRIGGER}`)] }).kind, 'suggest')
})
