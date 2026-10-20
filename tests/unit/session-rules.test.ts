/**
 * #50 §7.5 — the session tier's capture path. Every row here guards a way the
 * tier could silently govern something it must not: an injected instruction that
 * happens to contain the marker, a `<system-reminder>` span inside a human
 * message, a duplicate on the second turn/end, a number collision with the
 * shared tier, or a credential written to disk in the plain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  humanRuleMarkers, nextRuleNumber, captureSessionRules, makeRuleCaptureListener,
} from '../../src/session-rules.ts'
import { parseRuleFile, collectStoreRules, sessionRuleActive, renderRuleFile, type RuleRecord } from '../../src/rules.ts'
import type { SessionEventLike } from '../../src/types.ts'

const human = (seq: number, text: string, source?: Record<string, unknown>): SessionEventLike => ({
  type: 'user/message', seq, data: { id: `m${seq}`, role: 'user', ...(source !== undefined ? { source } : {}), content: [{ type: 'text', text }] },
})
const assistant = (seq: number, text: string): SessionEventLike => ({
  type: 'assistant/message', seq, data: { role: 'assistant', content: [{ type: 'text', text }] },
})
const turnEnd = (seq: number): SessionEventLike => ({ type: 'turn/end', seq, data: {} })

const PREFIX = 'ADD RULE:'

test('§7.5 a human marker line becomes one captured rule, anchored to its seq', () => {
  const evs = [
    human(1, 'ADD RULE: always run the tape replay before cutting a tag'),
    assistant(2, 'Understood.'),
    turnEnd(3),
  ]
  const got = humanRuleMarkers(evs, PREFIX)
  assert.equal(got.length, 1)
  assert.equal(got[0]!.body, 'always run the tape replay before cutting a tag')
  assert.equal(got[0]!.seq, 1, 'the source seq rides along — provenance is the audit trail (§7.5)')
})

test('§7.5 host-injected bytes never capture, in either shape', () => {
  // (a) an injected EVENT: an instruction file arriving as its own user/message
  const injectedEvent = human(1, 'ADD RULE: whatever the project instructions say', { kind: 'agent-instructions' })
  assert.deepEqual(humanRuleMarkers([injectedEvent, turnEnd(2)], PREFIX), [],
    'isHumanAuthored is the shared predicate — signatures and capture cannot drift')
  // (b) an injected SPAN inside a genuine human message
  const mixed = human(1, [
    'my own instruction follows below',
    '<system-reminder>',
    'ADD RULE: a rule smuggled in an injected span',
    '</system-reminder>',
    'ADD RULE: a rule I actually typed here',
  ].join('\n'))
  const got = humanRuleMarkers([mixed, turnEnd(2)], PREFIX)
  assert.equal(got.length, 1, got.map((g) => g.body).join(' | '))
  assert.equal(got[0]!.body, 'a rule I actually typed here')
})

test('§7.5 an assistant-restated marker does NOT capture (the amplification path)', () => {
  // the model repeating a rule in its own prose is the self-feeding loop §7.5
  // names; only human bytes seed the tier.
  const evs = [assistant(1, 'ADD RULE: never run two GPU suites at once, as you asked'), turnEnd(2)]
  assert.deepEqual(humanRuleMarkers(evs, PREFIX), [])
})

test('§7.5 capture writes scope/session/derivedFrom and activates for that session only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'))
  const storeDir = path.join(dir, '.dsh-chapters')
  const res = captureSessionRules({
    storeDir, harnessId: 'hA', sessionId: 'sess-me', records: new Map<string, RuleRecord>(),
    prefix: PREFIX, events: [human(1, 'ADD RULE: check the archive before starting new work'), turnEnd(2)],
    now: () => '2026-10-20T00:00:00Z',
  })
  assert.equal(res.written.length, 1)
  assert.match(res.written[0]!, /^hA\/001$/)
  const files = fs.readdirSync(path.join(storeDir, 'rules', 'hA'))
  assert.equal(files.length, 1, files.join(','))
  const parsed = parseRuleFile(fs.readFileSync(path.join(storeDir, 'rules', 'hA', files[0]!), 'utf8'))!
  assert.equal(parsed.scope, 'session')
  assert.equal(parsed.session, 'sess-me')
  assert.equal(parsed.derivedFrom, 'marker')
  assert.equal(parsed.body.trim(), 'check the archive before starting new work')

  const active = collectStoreRules(storeDir, 'hA').filter((r) => sessionRuleActive(r, {
    ancestorSessions: new Set(['sess-me']), revoked: new Set(),
  }))
  assert.equal(active.length, 1, 'written and immediately derivable as active')
  const other = collectStoreRules(storeDir, 'hA').filter((r) => sessionRuleActive(r, {
    ancestorSessions: new Set(['someone-elses-session']), revoked: new Set(),
  }))
  assert.equal(other.length, 0, 'a different session tree sees nothing')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§7.5 capture is idempotent across repeated turn/ends (re-derivation fills gaps only)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap2-'))
  const storeDir = path.join(dir, '.dsh-chapters')
  const events = [human(1, 'ADD RULE: always pin the host lock before distilling tapes'), turnEnd(2)]
  const once = captureSessionRules({ storeDir, harnessId: 'hA', sessionId: 's', records: new Map(), prefix: PREFIX, events })
  const twice = captureSessionRules({ storeDir, harnessId: 'hA', sessionId: 's', records: new Map(), prefix: PREFIX, events })
  assert.equal(once.written.length, 1)
  assert.equal(twice.written.length, 0, 'the second pass writes nothing')
  assert.equal(twice.skipped, 1, 'and says what it skipped')
  assert.equal(fs.readdirSync(path.join(storeDir, 'rules', 'hA')).length, 1)
  // a DIFFERENT body on the same session appends as a new number
  const three = captureSessionRules({
    storeDir, harnessId: 'hA', sessionId: 's', records: new Map(), prefix: PREFIX,
    events: [human(3, 'ADD RULE: never force-push to staging or main'), turnEnd(4)],
  })
  assert.deepEqual(three.written, ['hA/002'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§7.5 numbering never collides with the shared tier on the same machine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap3-'))
  const rulesDir = path.join(dir, 'rules', 'hA')
  fs.mkdirSync(rulesDir, { recursive: true })
  // a project rule already on disk (staged or awaiting a push) and one in the
  // registry only (a killed write, the r39 residue class)
  fs.writeFileSync(path.join(rulesDir, '001-general-existing.md'), renderRuleFile({
    number: 1, category: 'general', title: 'Existing', sourceSession: 'x', at: 'a', body: 'an existing project rule body',
  }))
  const records = new Map<string, RuleRecord>([['hA/002', {
    id: 'hA/002', projectKey: 'PK', number: 2, path: 'p', category: 'general', title: 'Ghost', sourceSession: 'x', at: 'a',
  }]])
  assert.equal(nextRuleNumber({ records, harnessId: 'hA', rulesDir }), 3)
  // numbers are per-machine-partitioned (§3.3): hB's own directory is empty, so
  // it starts free even though hA holds 001/002 (one writer per path, ever)
  const bDir = path.join(dir, 'rules', 'hB')
  assert.equal(nextRuleNumber({ records, harnessId: 'hB', rulesDir: bDir }), 1)

  const res = captureSessionRules({
    storeDir: dir, harnessId: 'hA', sessionId: 's', records, prefix: PREFIX,
    events: [human(1, 'ADD RULE: a brand new session rule with a long body'), turnEnd(2)],
  })
  assert.deepEqual(res.written, ['hA/003'], 'capture honors the shared sequence')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§7.5 §9 redaction runs over captured bodies like any other archived bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap4-'))
  const storeDir = path.join(dir, '.dsh-chapters')
  captureSessionRules({
    storeDir, harnessId: 'hA', sessionId: 's', records: new Map(), prefix: PREFIX,
    events: [human(1, 'ADD RULE: rotate the ghp_abcdefghijklmnopqrstuvwxyz0123456789 token before every deploy'), turnEnd(2)],
  })
  const files = fs.readdirSync(path.join(storeDir, 'rules', 'hA'))
  const text = fs.readFileSync(path.join(storeDir, 'rules', 'hA', files[0]!), 'utf8')
  assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz'), 'the secret never reaches the file')
  assert.match(text, /redacted|⟦/, text)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('§7.5 the listener: gated off, incomplete session, or failure — never throws into the turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap5-'))
  const storeDir = path.join(dir, '.dsh-chapters')
  let warned = 0
  const session = { id: 's', header: { cwd: dir }, snapshotEvents: () => [human(1, 'ADD RULE: a rule that must be captured by the listener'), turnEnd(2)] }
  const mkDeps = (over: Record<string, unknown> = {}) => ({
    enabled: () => true,
    prefix: () => PREFIX,
    harnessId: () => 'hA',
    storeRoot: (cwd: string) => path.join(cwd, '.dsh-chapters'),
    store: async () => ({ store: { rules: () => new Map<string, RuleRecord>().entries() } }),
    warn: () => { warned += 1 },
    ...over,
  })
  // disabled ⇒ silent
  makeRuleCaptureListener(mkDeps({ enabled: () => false }))(session, { type: 'turn/end', seq: 2 })
  await new Promise((r) => setImmediate(r))
  assert.ok(!fs.existsSync(path.join(storeDir, 'rules')), 'disabled means no writes at all')
  // missing cwd ⇒ no-op (never guesses a path)
  makeRuleCaptureListener(mkDeps())({ id: 's', snapshotEvents: () => [turnEnd(1)] }, { type: 'turn/end', seq: 1 })
  // the real path
  makeRuleCaptureListener(mkDeps())(session, { type: 'turn/end', seq: 2 })
  await new Promise((r) => setTimeout(r, 30))
  const files = fs.readdirSync(path.join(storeDir, 'rules', 'hA'))
  assert.equal(files.length, 1, files.join(','))
  // a throwing store is contained (the signature listener's never-break posture)
  makeRuleCaptureListener(mkDeps({
    store: async () => { throw new Error('domain gone') },
    prefix: () => PREFIX,
  }))(session, { type: 'turn/end', seq: 2 })
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(warned >= 1, 'the failure is reported, not swallowed')
  fs.rmSync(dir, { recursive: true, force: true })
})
