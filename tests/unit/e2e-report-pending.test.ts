/**
 * The durable half of the enrich report assertion (#56).
 *
 * The leg failed a DOM text poll while the command it was polling for had provably run: the
 * session log contained `…· last: enrichment batch: 1/1 chapter(s)\npending: 0 chapter(s)` as a
 * `command/done`. On 0.2.x the conversation surface virtualizes, so "not on screen" is not
 * "not recorded" — and a gate that cannot tell those apart stops being a gate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { commandResultSaysPending, reportPendingInDurableLog } from '../../tests/e2e/session.ts'

const done = (text: string): string => JSON.stringify({
  type: 'command/done', seq: 26, data: { commandId: 'c-1', kind: 'success', text },
})

test('a recorded report with a pending count satisfies the claim', () => {
  const log = [done('enrichment: manual · last: enrichment batch: 1/1 chapter(s)\npending: 0 chapter(s)')].join('\n')
  assert.equal(commandResultSaysPending(log), true)
})

test('other command results do not — the predicate is about the report, not any text', () => {
  assert.equal(commandResultSaysPending(done('prompt model: OFF (unset)')), false,
    'the ghost status chatter contains no pending count')
  assert.equal(commandResultSaysPending(done('enrichment: processed 1 chapter(s); 0 pending')), true,
    'the run verb reports the same fact in another shape, and both count')
  assert.equal(commandResultSaysPending(''), false, 'no log is not a pass')
  assert.equal(commandResultSaysPending(JSON.stringify({ type: 'user/message', data: { message: { content: 'pending: whatever the human typed' } } })), false,
    'a human message must not satisfy a claim about a command result')
  // the shape that actually failed in the field, with the newline JSON-escaped inside the string
  assert.equal(commandResultSaysPending(JSON.stringify({ type: 'command/done', data: { text: 'enrichment: manual\npending: 0 chapter(s)' } })), true,
    'a real report whose pending count arrives after an escaped newline must count')
})

/**
 * The helper is pointed at a tree it did not compute — and that is exactly how it was wrong.
 * `reportPendingInDurableLog(dir)` used `sessionLogTextById(name)`, which resolves against the
 * boot-port home captured at import time, so passing ANY other directory returned false forever:
 * a durable gate that can never pass, which the leg then reads as "the report never happened".
 * Measured against the real stalled home: two session dirs, both holding the report, `false`.
 */
test('the helper reads the tree it is handed, not the one it happened to compute at import', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-tree-'))
  try {
    const sess = path.join(root, 'sessions', '--somewhere--')
    const one = path.join(sess, 'session-abc')
    fs.mkdirSync(one, { recursive: true })
    const line = JSON.stringify({
      type: 'command/done', seq: 26,
      data: { commandId: 'c-1', kind: 'success', text: 'enrichment: manual\npending: 0 chapter(s)' },
    })
    const raw = path.join(one, 'session.v4.jsonl')
    const packed = path.join(one, 'session.v4.jsonl.zstd')
    fs.writeFileSync(raw, line + '\n')
    // The fixture, not the product, was wrong the first time: `zstd file` writes `file.zst`, but
    // the host's durable name is `session.v<N>.jsonl.zstd` — the shape `sessionLogFileFor`
    // resolves. Compress to stdout and name it the way the rig names it, then drop the plain file
    // so the test proves it reads the compressed artifact and not the leftover.
    execFileSync('zstd', ['-q', '-c', raw], { maxBuffer: 8 * 1024 * 1024 })
    fs.writeFileSync(packed, execFileSync('zstd', ['-q', '-c', raw], { maxBuffer: 8 * 1024 * 1024 }))
    fs.rmSync(raw)
    assert.equal(reportPendingInDurableLog(sess), true,
      'an arbitrary tree holding a real report must read as delivered')
    assert.equal(reportPendingInDurableLog(path.join(root, 'nothing-here')), false,
      'a missing tree is false, not a crash')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the surface probe is bounded, so a churning list cannot hang the leg (#56)', () => {
  // Measured: the leg went silent for 17 minutes — no model request, no log write — because
  // `scrollIntoViewIfNeeded()` on `locator(...).last()` of a virtualized list never settled and
  // had no timeout. The guard is on the shape, because the symptom only shows up as a wasted
  // evening: any scrollIntoViewIfNeeded in this spec must carry a deadline.
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'tests', 'e2e', 'enrich.spec.ts'), 'utf8')
  const calls = src.split('\n').filter((l) => l.includes('scrollIntoViewIfNeeded'))
  assert.ok(calls.length >= 1, 'the observation must still be attempted')
  assert.ok(calls.every((l) => /timeout:\s*\d/.test(l) || /Promise\.race/.test(l)),
    `every scroll must be bounded: ${JSON.stringify(calls.map((l) => l.trim()))}`)
})
