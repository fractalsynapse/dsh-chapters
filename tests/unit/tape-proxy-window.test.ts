/**
 * The tape proxy enforcing the pinned context window (#78, the `heavy` regime gap).
 *
 * A context-pressure journey distilled against an endpoint that happily accepts a 33K prompt does
 * not exercise context pressure at all: the base engine is entered with `trigger="pressure"`,
 * declines for a defensible reason (the oversized result is the newest thing in an unfinished
 * turn), and the trigger that WOULD relieve it — `context-overflow` — never arrives, because
 * nobody ever refuses the request. The local stress server refuses; a hosted route does not.
 *
 * So the proxy enforces the window the boot pins, by answering an over-window request the way an
 * OpenAI-compatible provider does. The refusal must be recognized by the host's own classifier,
 * whose rule (in `@deepseek-ai/dsh-llm`) needs three things in the message: a subject
 * (`input|prompt|request|messages`), a verb (`exceed|overflow|larger than`), and the object
 * (`context (length|window)`). A wording we invent is a wording the host may not read — hence
 * the drift row below, which re-reads the host's rule instead of trusting this comment.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { startModelProxy } from '../../tests/e2e/model-proxy.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

function post(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const u = new URL(url)
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      // one request per connection: the default global agent keeps sockets alive, and a
      // reused socket across three proxies in one file is how a passing row intermittently
      // reports "socket hang up" (seen on the second run of this very file)
      agent: new http.Agent({ keepAlive: false }),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

const upstreamText = (n = 400): string => 'x'.repeat(n)
const bigRequest = (tokens: number): Record<string, unknown> => ({
  model: 'qwen3-4b-instruct',
  messages: [
    { role: 'system', content: 'you are a coding agent' },
    { role: 'user', content: 'read the big file' },
    // the estimator is bytes/4, so this many characters ≈ that many tokens
    { role: 'assistant', content: upstreamText(tokens * 4) },
  ],
})

async function withProxy<T>(opts: { windowTokens?: number }, fn: (url: string, dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-proxy-'))
  const quiet = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/event-stream' }); r.end('data: [DONE]\n\n') })
  const addr = await new Promise<{ port: number }>((r) => quiet.listen(0, '127.0.0.1', () => r(quiet.address() as { port: number })))
  const proxy = await startModelProxy({
    mode: 'record', tapeDir: path.join(dir, 'tape'), journalPath: path.join(dir, 'misses.log'),
    upstream: `http://127.0.0.1:${addr.port}`, windowTokens: opts.windowTokens,
  })
  try { return await fn(proxy.url, path.join(dir, 'tape')) }
  finally {
    await proxy.close()
    await new Promise<void>((r) => { quiet.close(() => r()) })
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('an over-window request is refused in the provider shape, not forwarded', async () => {
  await withProxy({ windowTokens: 1000 }, async (url, tapeDir) => {
    const r = await post(url + '/v1/chat/completions', bigRequest(4000))
    assert.equal(r.status, 400, `a hosted endpoint would have swallowed this; the rig must not: ${r.status}`)
    const parsed = JSON.parse(r.body) as { error?: { message?: string, type?: string, code?: string } }
    assert.match(parsed.error?.message ?? '', /context/, 'the message names the context')
    assert.match(parsed.error?.message ?? '', /prompt|input|request|messages/i, 'and the thing that exceeded it')
    assert.match(parsed.error?.message ?? '', /exceed|overflow|larger than/i, 'and the verb the host looks for')
    assert.equal(parsed.error?.type, 'invalid_request_error', 'shaped like a provider rejection, not a proxy bug')
    assert.equal(parsed.error?.code, 'context_length_exceeded')
    const tape = fs.existsSync(tapeDir) ? fs.readdirSync(tapeDir).filter((f) => f.endsWith('.json')) : []
    assert.equal(tape.length, 0, 'a refusal is not an answer — it must never become a fixture')
    const log = fs.readFileSync(path.join(path.dirname(tapeDir), 'e2e-upstream.log'), 'utf8')
    assert.match(log, /OVERFLOW refused .*window=1000/, 'and the journal says the rig refused it, not the upstream')
  })
})

test('an under-window request still flows to the upstream untouched', async () => {
  await withProxy({ windowTokens: 100_000 }, async (url, tapeDir) => {
    const r = await post(url + '/v1/chat/completions', bigRequest(50))
    assert.equal(r.status, 200)
    assert.equal(fs.readdirSync(tapeDir).filter((f) => f.endsWith('.json')).length, 1, 'the normal record path is unaffected')
  })
})

test('window enforcement is OFF by default — replay and live are not newly constrained', async () => {
  await withProxy({}, async (url, tapeDir) => {
    const r = await post(url + '/v1/chat/completions', bigRequest(200_000))
    assert.equal(r.status, 200, 'no window configured ⇒ no refusal invented by the rig')
    assert.equal(fs.readdirSync(tapeDir).filter((f) => f.endsWith('.json')).length, 1)
  })
})

test('the refusal message satisfies the HOST classifier, read from its own bundle', async () => {
  // Not "the comment says three words". The host's regex lives in @deepseek-ai/dsh-llm as
  // EXCEEDS_MODEL_CONTEXT; if a future host tightens it, this row must fail, not the acceptance
  // chain, three evenings later.
  const trees = [
    path.join(ROOT, 'dev', 'dsh-host-lock', 'node_modules', '@deepseek-ai'),
    (() => { try { const b = execSync('readlink -f "$(command -v dsh)"', { encoding: 'utf8' }).trim(); const i = b.indexOf('/@deepseek-ai/'); return i > 0 ? b.slice(0, i) + '/@deepseek-ai' : '' } catch { return '' } })(),
  ].filter(Boolean)
  let source = ''
  for (const t of trees) {
    const f = path.join(t, 'dsh-llm', 'lib', 'types', 'error.js')
    if (fs.existsSync(f)) { source = fs.readFileSync(f, 'utf8'); break }
  }
  assert.ok(source.length > 0, 'the pinned host bundle with the overflow classifier must be readable')
  // `String.raw` and its backtick are separated by a newline + indent in the shipped file,
  // so the pattern must not assume they touch.
  const m = /const EXCEEDS_MODEL_CONTEXT = new RegExp\(\s*String\.raw\s*`([^`]+)`[\s\S]{0,400}?String\.raw\s*`([^`]+)`[\s\S]{0,400}?String\.raw\s*`([^`]+)`/.exec(source)
  assert.ok(m !== null, 'the classifier must still be composed of the three raw fragments this row expects')
  const hostRegex = new RegExp([m![1], m![2], m![3]].join(''), 'i')
  // the exact text the proxy returns, kept in one exported place so the row tests the product string
  const { OVERFLOW_REFUSAL } = await import('../../tests/e2e/model-proxy-window.ts')
  assert.ok(hostRegex.test(OVERFLOW_REFUSAL.message),
    `the host would NOT read our refusal as an overflow: ${OVERFLOW_REFUSAL.message}`)
})

/**
 * The estimator is only useful if it agrees with the host's meter at the sizes the host actually
 * reported. These are the field numbers from one `heavy` leg (proxy journal `reqBytes=` beside the
 * engine's `surface=… tok`), not round numbers invented for convenience.
 */
test('the estimator agrees with the host meter at the measured sizes', async () => {
  const { estimateRequestTokens, BYTES_PER_TOKEN } = await import('../../tests/e2e/model-proxy-window.ts')
  // 78,140 bytes ≈ 27,306–28,928 host tokens: UNDER a 32,000 window, and must stay under.
  const under = { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(78_140 - 60) }] }
  const estUnder = estimateRequestTokens(under)
  assert.ok(estUnder < 32_000, `a request the host measured at ~28K tokens must not be refused: ${String(estUnder)}`)
  assert.ok(estUnder > 24_000, `the estimate must not drift so early it refuses ordinary turns: ${String(estUnder)}`)
  // 120,129 bytes ≈ 35,428 host tokens: OVER the window, and must be refused.
  const over = { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(120_129 - 60) }] }
  const estOver = estimateRequestTokens(over)
  assert.ok(estOver > 32_000, `the host overflowed at 35,428 tokens; our estimate said ${String(estOver)}`)
  assert.equal(BYTES_PER_TOKEN, 3, 'the divisor is the conservative round value, and the measured 2.8 lives beside it')
})

test('REPLAY refuses the same over-window request and consumes no tape entry (#78)', async () => {
  // The regime is part of what a tape records. A distill that saw a refusal, relieved, and asked
  // again must see the SAME refusal on replay — otherwise the request sequence diverges and the
  // chain goes red for what looks like prompt drift but is really a rig that changed the world
  // between record and replay.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-replay-'))
  const tape = path.join(dir, 'tape')
  fs.mkdirSync(tape, { recursive: true })
  // one entry that WOULD match a small request; the big request must not consume it
  const small = { model: 'qwen3-4b-instruct', messages: [{ role: 'user', content: 'hi' }] }
  const key = (b: unknown): string => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    return createHash('sha256').update(JSON.stringify(b)).digest('hex').slice(0, 16)
  }
  fs.writeFileSync(path.join(tape, '0000.json'), JSON.stringify({
    key: 'ignore', prefix: [], status: 200, contentType: 'text/event-stream',
    bytes: Buffer.from('data: [DONE]\n\n').toString('base64'), model: 'qwen3-4b-instruct',
    recordedAt: new Date().toISOString(),
  }))
  void small; void key
  const quiet = http.createServer((_q, r) => { r.writeHead(200); r.end('{}') })
  const addr = await new Promise<{ port: number }>((r) => quiet.listen(0, '127.0.0.1', () => r(quiet.address() as { port: number })))
  const proxy = await startModelProxy({
    mode: 'replay', tapeDir: tape, journalPath: path.join(dir, 'misses.log'),
    upstream: `http://127.0.0.1:${addr.port}`, windowTokens: 1000,
  })
  try {
    const before = fs.readdirSync(tape).length
    const r = await post(proxy.url + '/v1/chat/completions', bigRequest(4000))
    assert.equal(r.status, 400, 'replay must refuse an over-window request the way record did')
    assert.equal(fs.readdirSync(tape).length, before, 'a refusal consumes nothing')
    const log = fs.readFileSync(path.join(dir, 'e2e-upstream.log'), 'utf8')
    assert.match(log, /OVERFLOW refused mode=replay/, 'and the journal says which mode enforced it')
  } finally {
    await proxy.close()
    await new Promise<void>((r) => { quiet.close(() => r()) })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A MISS must name the divergence (#56). Tonight's replay failures were only "messages=5" plus a
 * last-message preview, which could not distinguish a missing harness injection from a tape that
 * belongs to a different journey — and the difference decides whether to fix the rig or re-record.
 */
test('describeMiss names the closest entry and the message where the bytes stop agreeing', async () => {
  const { describeMiss } = await import('../../tests/e2e/model-proxy.ts')
  const mk = (s: string): string => JSON.stringify({ role: 'user', content: s })
  const tape = [
    { key: 'a', prefix: [mk('sys'), mk('question'), mk('answer one'), mk('next')], status: 200, contentType: 'text/event-stream', bytes: '', model: 'm', recordedAt: '2026-10-23T00:00:00.000Z' },
  ] as unknown as Parameters<typeof describeMiss>[0]
  const incoming = [mk('sys'), mk('question'), mk('ANSWER ONE — different'), mk('extra')]
  const line = describeMiss(tape, incoming)
  // the claim is that it NAMES the turn — a file name when the loader supplied one, an entry
  // index when it did not. A bare `?` would be the anonymous answer this row exists to forbid.
  assert.match(line, /closest=(?!\?)[^\s]+/, 'names which recorded turn it continues: ' + line)
  assert.match(line, /commonPrefix=2/, 'two messages agreed byte-for-byte: ' + line)
  assert.match(line, /divergeAt=msg2/, 'and the third is where they stop: ' + line)
  assert.match(line, /got=.*ANSWER ONE/, 'shows what replay asked: ' + line)
  assert.match(line, /expected=.*answer one/, 'and what the tape holds: ' + line)
})
