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
import { startModelProxy, personaDigest, corpusPersonas, isAgentPersona } from '../../tests/e2e/model-proxy.ts'

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

/**
 * Prevention (#108, the half the fast-fail commit did not do): recording must not be able to produce a
 * corpus this rig cannot replay. `tests/fixtures/model-tape/PERSONA` lists the agent-header digests the
 * corpus was recorded under; an unknown digest refuses the record BEFORE the upstream is called, so no GPU
 * time buys a corpus that is guaranteed red on another machine.
 */
const AGENT_HEAD = (tail: string) => `You are an AI agent powered by DeepSeek Harness. You are a coding agent powered by the qwen3.8-flash-next model. ${tail}`

test('record bootstraps the persona file when none exists (#108)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-rec-'))
  const tape = path.join(dir, 'tape', 'suite')
  fs.mkdirSync(tape, { recursive: true })
  const upstream = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })) })
  await new Promise<void>((res) => upstream.listen(0, '127.0.0.1', res))
  const proxy = await startModelProxy({ mode: 'record', tapeDir: tape, journalPath: path.join(dir, 'misses.log'), upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` })
  const post = (m: unknown[]) => new Promise<number>((res) => {
    const req = http.request(proxy.url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode ?? 0)) })
    req.on('error', () => res(0))
    req.end(JSON.stringify({ messages: m, model: 'local/qwen3.8-flash-next' }))
  })
  try {
    const code = await post([{ role: 'system', content: AGENT_HEAD('Alpha paragraph.') }, { role: 'user', content: 'go' }])
    assert.equal(code, 200, 'a first recording on a fresh rig bootstraps the digest and proceeds')
    const personaFile = path.join(dir, 'tape', 'PERSONA')
    assert.ok(fs.existsSync(personaFile), 'the persona file is written next to the corpus root')
    assert.match(fs.readFileSync(personaFile, 'utf8'), new RegExp(personaDigest([{ role: 'system', content: AGENT_HEAD('Alpha paragraph.') }]) as string))
  } finally {
    await proxy.close()
    await new Promise<void>((r) => { upstream.close(() => r()) })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('record REFUSES a header the corpus was not pinned to, and spends no upstream call (#108)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-refuse-'))
  const root = path.join(dir, 'tape')
  const tape = path.join(root, 'suite')
  fs.mkdirSync(tape, { recursive: true })
  const pinned = personaDigest([{ role: 'system', content: AGENT_HEAD('Alpha paragraph.') }]) as string
  fs.writeFileSync(path.join(root, 'PERSONA'), `# pinned agent-header digests\n${pinned}\n`)
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
    const code = await post([{ role: 'system', content: AGENT_HEAD('Beta paragraph — what CI composes.') }, { role: 'user', content: 'go' }])
    assert.equal(code, 500, 'an unpinned agent header must refuse the record')
    assert.equal(upstreamCalls, 0, 'and refuse BEFORE spending the model — a corpus this rig cannot replay is worthless')
    assert.equal(fs.readdirSync(tape).filter((f) => f.endsWith('.json')).length, 0, 'no tape may be written for a refused request')
    const journal = fs.readFileSync(path.join(dir, 'misses.log'), 'utf8')
    assert.match(journal, /PERSONA-RECORD-REFUSED/, 'the journal names the class and carries both digests')
    assert.match(journal, new RegExp(pinned), 'including what the corpus is pinned to')
  } finally {
    await proxy.close()
    await new Promise<void>((r) => { upstream.close(() => r()) })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The row that would have caught my own inert fix: real tape entries store prefixes as ALREADY-MASKED
 * STRINGS, and that text is not valid JSON. An implementation that parses them returns nothing, an empty
 * persona set makes the mismatch check never true, and the fast-fail looks correct while doing nothing.
 */
test('the persona pin reads the corpus as it is actually stored (#108)', () => {
  const root = path.join(process.cwd(), 'tests', 'fixtures', 'model-tape')
  const entry = JSON.parse(fs.readFileSync(path.join(root, 'suite', '0001.json'), 'utf8')) as { prefix: unknown[] }
  assert.equal(typeof entry.prefix[0], 'string', 'recorded heads are stored as strings, not objects')
  assert.ok(isAgentPersona(entry.prefix), 'the agent header must be recognized from the stored string form')
  const d = personaDigest(entry.prefix)
  assert.equal(typeof d, 'string', 'and must yield a digest')
  assert.ok(corpusPersonas([entry] as never).has(d as string), 'corpusPersonas must enumerate real tape entries, or the pin is inert')

  // the corpus-wide facts the pin depends on, measured rather than assumed.
  let heads = 0, unparseable = 0, agentHeads = 0
  const distinct = new Set<string>()
  for (const leg of fs.readdirSync(root)) {
    const dir = path.join(root, leg)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { prefix?: unknown[] }
      const h = e.prefix?.[0]
      if (typeof h !== 'string' || !h.startsWith('{"role":"system"')) continue
      heads++
      try { JSON.parse(h) } catch { unparseable++ }
      if (isAgentPersona(e.prefix)) { agentHeads++; distinct.add(personaDigest(e.prefix) as string) }
    }
  }
  assert.ok(heads > 40, `the corpus should carry dozens of system heads, found ${String(heads)}`)
  assert.ok(unparseable > heads / 2,
    `most stored heads are NOT parseable JSON (masked text sits unescaped inside them) — found ${String(unparseable)} of ${String(heads)}; parse-based matching is unsafe, which is why headView takes the string as-is`)
  // Two digests, and the reason is composed-in state, not staleness: the `plans` leg's first agent request is
  // made WHILE IN PLAN MODE, and plan mode contributes a paragraph to the header — measured byte-for-byte,
  // `plans/0000.json` diverges from the majority at char 141 with "You are in plan mode. Stay in plan mode
  // until exit_plan_mode succeeds…". So the pin is a SET, one entry per composed state. Asserting one digest
  // would have been my own over-strict guess about how headers form; the corpus corrected it.
  assert.equal(distinct.size, 2, `the corpus pins one header per composed agent state (plain + plan mode); found ${String(distinct.size)}: ${[...distinct].join(', ')}`)
  const pin = fs.readFileSync(path.join(root, 'PERSONA'), 'utf8')
  const pinned = pin.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'))
  assert.deepEqual([...new Set(pinned)].sort(), [...distinct].sort(),
    'PERSONA must describe the corpus exactly: every digest in the tapes is pinned, and nothing extra is pinned')
})
