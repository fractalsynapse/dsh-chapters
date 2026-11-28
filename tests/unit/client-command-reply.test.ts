// #590 rows: the reply-record parse, excerpt bounds, and host-card suppression.
// The channel was MEASURED, not assumed: the follow wire carries 0 command events (reload-leg
// snapshot, 2026-11-27), so the row reads the server's settings-row record through exec. These
// fixtures are the maintainer's live reply bytes shaped exactly as commands.ts records them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReplyRow, excerptOf, hostCardShowsReply, EXCERPT_CHARS, subscribeReply } from '../../src/client/command-reply.ts'

test('#590: the record parses to the live report byte-for-byte', () => {
  const raw = JSON.stringify({ line: '/chapters-enrich report', kind: 'success', text: 'enrichment: manual, model qwen-token-plan/qwen3.8-flash · mining qwen-token-plan/qwen3.8-max (dedicated)\npending: 0 chapter(s)', at: '2026-11-27T10:11:16.000Z' })
  const r = parseReplyRow(raw)
  assert.ok(r !== null)
  assert.equal(r.line, '/chapters-enrich report')
  assert.equal(r.kind, 'success')
  assert.match(r.text, /pending: 0/)
  assert.ok(r.seq > 0, 'the record timestamp becomes the ordering key')
})

test('#590: empty and junk records read as NO row — never a crash, never a blank row', () => {
  assert.equal(parseReplyRow(''), null)
  assert.equal(parseReplyRow('not json'), null)
  assert.equal(parseReplyRow(JSON.stringify({ line: '', kind: 'success', text: 'x' })), null)
})

test('#590: error kind survives the round trip', () => {
  const r = parseReplyRow(JSON.stringify({ line: '/chapters-rule reprocess all', kind: 'error', text: 'reprocess takes a positive whole-number limit', at: '2026-11-27T10:12:00.000Z' }))
  assert.ok(r !== null)
  assert.equal(r.kind, 'error')
})

test('#590: excerpt bounds — flat, capped, ellipsis; full text untouched for expansion', () => {
  const long = `line one\n${'x'.repeat(400)}`
  const ex = excerptOf(long)
  assert.doesNotMatch(ex, /\n/, 'excerpts are single-line')
  assert.equal(ex.length, EXCERPT_CHARS + 1, 'cap plus ellipsis')
  assert.equal(excerptOf('short'), 'short')
})

test('#590: suppression — the host card already showing the reply hides the row; absence shows it', () => {
  const text = 'enrichment: manual, model qwen-token-plan/qwen3.8-flash · rule mining ON · pending: 0 chapter(s)'
  const ex = excerptOf(text)
  assert.equal(hostCardShowsReply(ex, { body: { innerText: `chat… ${text.slice(0, 80)} …rest` } }), true, 'host rendered it: no duplicate')
  assert.equal(hostCardShowsReply(ex, { body: { innerText: 'no cards here at all' } }), false, 'host hid it: the row is the fix')
  assert.equal(hostCardShowsReply('', undefined), false, 'running/empty never suppresses')
  assert.equal(hostCardShowsReply(ex, undefined), false, 'no document reads as not-shown: fail-visible')
})

test('#590: subscribeReply pulls the record through exec — mount pull answers, junk keeps the last truth', async () => {
  const calls: string[] = []
  let replies = 0
  const exec = async (line: string): Promise<string> => {
    calls.push(line)
    return line === '/chapters-reply last' ? JSON.stringify({ line: '/chapters-status', kind: 'success', text: 'Version: 0.2.60', at: '2026-11-27T11:00:00.000Z' }) : ''
  }
  const stop = subscribeReply(exec, (r) => { if (r !== null) replies += 1 })
  await new Promise((res) => setTimeout(res, 20))
  assert.deepEqual(calls, ['/chapters-reply last'], 'exactly one mount pull, slash-shaped like the bar\'s own exec calls — no drumbeat')
  assert.equal(replies, 1)
  stop()
})

test('#594: the self-echo regression — a mounted row must NEVER suppress itself (the maintainer-measured flash-then-vanish)', () => {
  const text = 'enrichment: manual, model qwen-token-plan/qwen3.8-flash · rule mining ON · pending: 0 chapter(s)'
  const ex = excerptOf(text)
  // The exact live shape: the probe runs AFTER the row mounted, so body.innerText already
  // contains the row's own text. First cut: found the echo, suppressed, row ate itself.
  const selfOnly = {
    body: { innerText: `sidebar… ${ex} …composer` },
    querySelector: (sel: string) => (sel === '[data-chapters-reply]' ? { innerText: ex } : null),
  }
  assert.equal(hostCardShowsReply(ex, selfOnly as never), false, 'own echo is NOT the host card — the row stays')
  // Host card present IN ADDITION to the row: suppress (the real #590 behavior, now measured outside own text).
  const cardAndRow = {
    body: { innerText: `timeline card: ${text} … dock row: ${ex}` },
    querySelector: (sel: string) => (sel === '[data-chapters-reply]' ? { innerText: ex } : null),
  }
  assert.equal(hostCardShowsReply(ex, cardAndRow as never), true, 'text OUTSIDE the row is the host card — the row stands aside')
  // Row absent (first probe before mount) with a card: suppress.
  const cardOnly = {
    body: { innerText: `timeline card: ${text}` },
    querySelector: () => null,
  }
  assert.equal(hostCardShowsReply(ex, cardOnly as never), true, 'pre-mount card detection still works')
})
