/**
 * The rig capability pin (#108): a composed agent header missing required sections is a RIG fault, and it
 * must be named at the first request instead of surfacing as a tape miss at char 142 followed by 25 minutes
 * of dead UI. Measured that way on CI run 40145460775 (PR #107): the corpus's 57 agent heads carry six
 * capability sections, CI's 2,783-char head carries three of them, and the same pinned host version was
 * blamed on the corpus.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { headerCapabilities, REQUIRED_CAPABILITIES } from '../../tests/e2e/rig-capabilities.ts'
import { startModelProxy } from '../../tests/e2e/model-proxy.ts'

const FULL = 'You are an AI agent powered by DeepSeek Harness. '
  + 'Prefer showing the primary results within your final response. '
  + 'the DeepSeek Harness Web GUI at http://127.0.0.1:3080. '
  + 'The implementation checkout is at /home/adrian/. '
  + 'Tokens prefixed with @ are paths the user explicitly referenced. '
  + '## Chapters memory and rules — run chapters_rules. '
  + 'create_goal may infer goal intent.'

const CI_LIKE = 'You are an AI agent powered by DeepSeek Harness. '
  + 'Prefer showing the primary results within your final response. '
  + 'the DeepSeek Harness Web GUI at http://127.0.0.1:3080. '
  + 'The implementation checkout is at /home/runner/. '
  + 'No goal tools, no file-reference guidance, no rules surface here.'

test('the pin requires what the corpus was recorded under (#108)', () => {
  assert.deepEqual(Object.keys(REQUIRED_CAPABILITIES).sort(),
    ['checkout', 'chaptersRules', 'deliverables', 'fileReference', 'goalTool', 'webGui'].sort(),
    'the six sections are the measured difference between the corpus header and CI’s')
  const full = headerCapabilities(FULL)
  assert.deepEqual(full.missing, [], 'a header carrying all six must pass')
  assert.equal(full.present.length, 6)
})

test('a CI-shaped header names the three absent capabilities (#108)', () => {
  const r = headerCapabilities(CI_LIKE)
  assert.deepEqual(r.missing.sort(), ['chaptersRules', 'fileReference', 'goalTool'],
    `the refusal must say WHICH capabilities the rig lost: ${JSON.stringify(r)}`)
  assert.ok(r.present.includes('deliverables'), 'and must not claim the shared sections are missing')
})

test('record REFUSES a rig whose header lost capabilities, spending no upstream call (#108)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigcap-'))
  const tape = path.join(dir, 'tape', 'suite')
  fs.mkdirSync(tape, { recursive: true })
  let upstreamCalls = 0
  const upstream = http.createServer((_q, r) => { upstreamCalls++; r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })) })
  await new Promise<void>((res) => upstream.listen(0, '127.0.0.1', res))
  const proxy = await startModelProxy({ mode: 'record', tapeDir: tape, journalPath: path.join(dir, 'misses.log'), upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` })
  const post = (m: unknown[]) => new Promise<number>((res) => {
    const req = http.request(proxy.url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode ?? 0)) })
    req.on('error', () => res(0))
    req.end(JSON.stringify({ messages: m, model: 'local/qwen3.8-flash-next' }))
  })
  try {
    const code = await post([{ role: 'system', content: CI_LIKE }, { role: 'user', content: 'go' }])
    assert.equal(code, 500, 'a rig missing required capabilities may not distill a corpus')
    assert.equal(upstreamCalls, 0, 'refuse BEFORE the model call')
    assert.equal(fs.readdirSync(tape).filter((f) => f.endsWith('.json')).length, 0, 'no tape written')
    assert.ok(!fs.existsSync(path.join(dir, 'tape', 'PERSONA')), 'and the persona is NOT bootstrapped from a rig that cannot compose the pinned header')
    const journal = fs.readFileSync(path.join(dir, 'misses.log'), 'utf8')
    assert.match(journal, /RIG-CAPABILITIES/, 'the journal names the class')
    assert.match(journal, /chaptersRules|fileReference|goalTool/, 'and which sections the rig lost')
  } finally {
    await proxy.close()
    await new Promise<void>((r) => { upstream.close(() => r()) })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
