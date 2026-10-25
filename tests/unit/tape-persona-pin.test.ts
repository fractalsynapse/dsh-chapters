/**
 * A tape miss on request zero is a rig fault (#108), and it must say so in seconds, not 25 minutes.
 *
 * Measured on CI (run 40145460775, PR #107): `MISS tape=suite … commonPrefix=0 divergeAt=msg0`, then a
 * 25-minute browser hang on a fork door that never rendered because no answer was ever served. Root cause
 * byte-diffed after masking through the rig's own `normalize()`: CI composes
 * `Prefer showing the primary results…` (dsh-client-ui-deliverables), the corpus carries
 * `Tokens prefixed with @ …` (dsh-file-reference-local) — same pinned host version, different
 * prompt-contributing package set, and nothing in `rig-pins.ts` controls that set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startModelProxy, personaDigest, corpusPersonas } from '../../tests/e2e/model-proxy.ts'

const CI_PERSONA = '{"role":"system","content":"You are an AI agent powered by DeepSeek Harness. You are a coding agent powered by the qwen3.8-flash-next model. Prefer showing the primary results within your final response alongside a brief explanation. Use ![Description](<path/to/image.png>) when an image supports an explanation."}'
const TAPE_PERSONA = '{"role":"system","content":"You are an AI agent powered by DeepSeek Harness. You are a coding agent powered by the qwen3.8-flash-next model. Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root."}'

const entry = (prefix: unknown[]) => ({ key: 'k1', prefix, status: 200, contentType: 'application/json', bytes: Buffer.from('{"choices":[{"message":{"content":"ok"}}]}').toString('base64') })

test('the persona digest is the masked header, not its machine-specific facts (#108)', () => {
  const a = personaDigest([{ role: 'system', content: 'Base. GUI at http://127.0.0.1:41731 and workspace /home/adrian/Projects/dsh-chapters' }])
  const b = personaDigest([{ role: 'system', content: 'Base. GUI at http://127.0.0.1:42999 and workspace /home/runner/work/dsh-chapters/dsh-chapters' }])
  assert.equal(typeof a, 'string', 'a system-first request must yield a digest')
  assert.equal(a, b, 'the rig\u2019s HOSTPORT-BLIND and WORKSPACE-BLIND forms are masked facts, not prompt identity')
  assert.equal(personaDigest([{ role: 'user', content: 'hi' }]), null, 'a request without a system head has no persona')
  // a tape prefix stores messages as JSON STRINGS and a live request sends OBJECTS: the digest is of the
  // message, not the encoding. Without this the corpus would mismatch its own recorded header.
  assert.equal(personaDigest([CI_PERSONA]), personaDigest([JSON.parse(CI_PERSONA)]), 'string-encoded and object-encoded heads must agree')
  assert.notEqual(personaDigest([JSON.parse(CI_PERSONA)]), personaDigest([JSON.parse(TAPE_PERSONA)]),
    'the two real paragraphs must land on different digests — that is what CI and the corpus disagree about')
})

test('corpusPersonas enumerates what the leg was actually recorded under (#108)', () => {
  const set = corpusPersonas([entry([JSON.parse(TAPE_PERSONA)]), entry([{ role: 'user', content: 'q' }])] as never)
  assert.equal(set.size, 1, 'only system-headed entries count')
  assert.ok(set.has(personaDigest([JSON.parse(TAPE_PERSONA)]) as string), 'the recorded persona is in the set')
  assert.ok(!set.has(personaDigest([JSON.parse(CI_PERSONA)]) as string), 'and the other header is not')
})

test('a replay whose header the corpus never saw fails fast and names the mismatch (#108)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-pin-'))
  const tape = path.join(dir, 'tape')
  fs.mkdirSync(tape, { recursive: true })
  fs.writeFileSync(path.join(tape, '0000.json'), JSON.stringify(entry([JSON.parse(TAPE_PERSONA), { role: 'user', content: 'go' }])))
  const quiet = http.createServer((_q, r) => { r.writeHead(500); r.end('{}') })
  await new Promise<void>((res) => quiet.listen(0, '127.0.0.1', res))
  const proxy = await startModelProxy({ mode: 'replay', tapeDir: tape, journalPath: path.join(dir, 'misses.log'), upstream: `http://127.0.0.1:${(quiet.address() as { port: number }).port}` })
  const post = (messages: unknown[]) => new Promise<{ code: number; body: string }>((res) => {
    const t0 = Date.now()
    const req = http.request(proxy.url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => {
      let b = ''
      r.on('data', (d) => { b += d })
      r.on('end', () => res({ code: r.statusCode ?? 0, body: `${b}|${String(Date.now() - t0)}ms` }))
    })
    req.on('error', (e) => res({ code: 0, body: String(e) }))
    req.end(JSON.stringify({ messages, model: 'local/qwen3.8-flash-next' }))
  })
  try {
    const first = await post([JSON.parse(CI_PERSONA), { role: 'user', content: 'go' }])
    assert.equal(first.code, 503, 'the request must be refused, not silently unanswered')
    assert.match(first.body, /PERSONA-MISMATCH/, `the refusal must name the class, not just "tape miss": ${first.body.slice(0, 120)}`)
    assert.match(first.body, /#108/, 'and point at the rig fix')
    const second = await post([JSON.parse(CI_PERSONA), { role: 'user', content: 'again' }])
    const ms = Number((second.body.split('|')[1] ?? '9999ms').replace('ms', ''))
    assert.ok(ms < 1500, `a latched mismatch must answer immediately, took ${String(ms)}ms`)
    assert.match(second.body, /PERSONA-MISMATCH/, 'and repeat the same sentence for every later request')
    const journal = fs.readFileSync(path.join(dir, 'misses.log'), 'utf8')
    assert.match(journal, /PERSONA-MISMATCH/, 'the journal carries the diagnosis for the CI artifact')
  } finally {
    await proxy.close()
    await new Promise<void>((r) => { quiet.close(() => r()) })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
