/**
 * The tape proxy's record path against a REMOTE upstream (#54).
 *
 * Distilling the eight acceptance projects used to mean "the GPU box must be up", because
 * `dev/settings.yaml` pins the local provider and the harness therefore sends
 * `LOCAL_API_KEY` — or a dummy the boot injects when no key is configured — straight through
 * the proxy to `localhost:8080`. A hosted endpoint does not accept a dummy, and the harness's
 * credential must NOT be the one the proxy carries upstream either: the tape rig talks to a
 * proxy precisely so the model's identity is a test fixture, not a secret in the profile.
 *
 * So: the proxy keeps receiving the dummy from the harness, and substitutes
 * `E2E_UPSTREAM_KEY` on the way out. These rows pin BOTH halves — the substitution, and the
 * fact that the harness's own value never reaches the upstream.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { startModelProxy } from '../e2e/model-proxy.ts'

/** An upstream that ONLY answers a bearer it recognises — the hosted behavior exactly. */
function startGuardedUpstream(want: string): Promise<{ url: string; seen: () => string[]; close: () => Promise<void> }> {
  const received: string[] = []
  const server = http.createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '')
    received.push(auth)
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => {
      if (auth !== `Bearer ${want}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid API-key provided', code: 'invalid_api_key' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"id":"u1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n')
      res.write('data: {"id":"u1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
      res.write('data: {"id":"u1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5,"total_tokens":16}}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        seen: () => received,
        close: () => new Promise<void>((r) => { server.close(() => r()) }),
      })
    })
  })
}

const post = async (url: string, key: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'qwen3.8-flash', messages: [{ role: 'user', content: 'ping the tape rig' }] }),
  })
  return { status: res.status, body: await res.text() }
}

test('record mode substitutes E2E_UPSTREAM_KEY and the harness dummy never reaches upstream', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-proxy-key-'))
  const upstream = await startGuardedUpstream('real-upstream-key')
  const proxy = await startModelProxy({
    mode: 'record',
    tapeDir: dir,
    upstream: upstream.url,
    upstreamKey: 'real-upstream-key',
  })
  try {
    const r = await post(proxy.url, 'e2e-tape-proxy-dummy')
    assert.equal(r.status, 200, `the proxy must present the upstream key, not the dummy: ${r.body.slice(0, 120)}`)
    assert.match(r.body, /ok/, 'the streamed answer must pass through untouched')
    assert.deepEqual(upstream.seen(), ['Bearer real-upstream-key'],
      'exactly one credential reaches the upstream, and it is not the profile value')
    const tapes = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.equal(tapes.length, 1, 'a successful record leg writes the tape')
  } finally {
    await proxy.close(); await upstream.close(); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('without an upstream key the dummy still goes out unchanged — the local regime must not break', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-proxy-local-'))
  const upstream = await startGuardedUpstream('whatever')
  const proxy = await startModelProxy({ mode: 'record', tapeDir: dir, upstream: upstream.url })
  try {
    const r = await post(proxy.url, 'local-server-does-not-check')
    assert.equal(r.status, 401, 'a guarded upstream rejects the passthrough credential — proving nothing was substituted')
    assert.deepEqual(upstream.seen(), ['Bearer local-server-does-not-check'],
      'with no upstreamKey configured the header passes through verbatim, exactly as the local vLLM rig needs it')
  } finally {
    await proxy.close(); await upstream.close(); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the recorded tape is what a later replay answers from — no upstream touched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-proxy-replay-'))
  const upstream = await startGuardedUpstream('k')
  const rec = await startModelProxy({ mode: 'record', tapeDir: dir, upstream: upstream.url, upstreamKey: 'k' })
  try {
    assert.equal((await post(rec.url, 'dummy')).status, 200)
  } finally { await rec.close() }
  const before = upstream.seen().length
  const replay = await startModelProxy({ mode: 'replay', tapeDir: dir, upstream: upstream.url })
  try {
    const r = await post(replay.url, 'dummy')
    assert.equal(r.status, 200, 'the replay answers from the tape')
    assert.match(r.body, /ok/)
    assert.equal(upstream.seen().length, before, 'replay must never reach the upstream, keyed or not')
  } finally {
    await replay.close(); await upstream.close(); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed upstream answer is relayed with ITS status and is NEVER written to the tape', async () => {
  // The corpus is the acceptance fixture. A 401 recorded as a tape becomes a
  // "successful" distill whose replayed turns are error JSON — the suite then
  // fails somewhere far away, on a fixture that looked like it worked.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-proxy-noerr-'))
  const upstream = await startGuardedUpstream('right-key')
  const proxy = await startModelProxy({ mode: 'record', tapeDir: dir, upstream: upstream.url, upstreamKey: 'wrong-key' })
  try {
    const r = await post(proxy.url, 'dummy')
    assert.equal(r.status, 401, 'the upstream status reaches the caller — a distill that failed must LOOK like it failed')
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')), [],
      'no tape may be written from a non-2xx answer')
  } finally {
    await proxy.close(); await upstream.close(); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the upstream model name is rewritten on the way out, and the tape keeps the fixture name', async () => {
  // The profile pins `qwen3.8-flash-next` (the 32K stress-regime id). A hosted
  // endpoint knows a different id, and editing the fixture's profile per-machine
  // is exactly the drift the hermetic host lock exists to prevent — so the proxy
  // translates, and the TAPE still records the profile's name.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-proxy-model-'))
  let upstreamModel = ''
  const upstream = http.createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => {
      try { upstreamModel = String((JSON.parse(Buffer.concat(parts).toString('utf8')) as { model?: string }).model ?? '') } catch { /* not JSON */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"id":"m1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n')
      res.write('data: {"id":"m1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
      res.write('data: [DONE]\n\n'); res.end()
    })
  })
  const addr = await new Promise<{ port: number }>((r) => upstream.listen(0, '127.0.0.1', () => r(upstream.address() as { port: number })))
  const proxy = await startModelProxy({
    mode: 'record', tapeDir: dir, upstream: `http://127.0.0.1:${addr.port}`,
    upstreamModel: 'qwen3.8-flash',
  })
  try {
    const r = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'fixture name' }] }),
    })
    assert.equal(r.status, 200)
    assert.equal(upstreamModel, 'qwen3.8-flash', 'the remote is addressed by the id it serves')
    const entry = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), 'utf8')) as { model: string }
    assert.equal(entry.model, 'qwen3.8-flash-next', 'the tape records the PROFILE name — a fixture of this rig, not of the service that distilled it')
  } finally {
    await proxy.close()
    await new Promise<void>((r) => { upstream.close(() => r()) })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A non-loopback IPv4 this machine serves on, or null. `localModelUp()`'s remote branch is
 * keyed on "not loopback" BY DESIGN (loopback is how the local stress server is addressed),
 * so the branch can only be exercised through a real host interface — 0.0.0.0 binding plus
 * this address is what makes that happen without pretending localhost is remote.
 */
async function nonLoopbackAddress(): Promise<string | null> {
  const os = await import('node:os')
  for (const group of Object.values(os.networkInterfaces())) {
    for (const i of group ?? []) {
      if (i.family !== 'IPv4' || i.address === '127.0.0.1' || i.address.startsWith('169.254.')) continue
      return i.address
    }
  }
  return null
}

/**
 * `localModelUp()` decides whether a browser journey RUNS or SKIPS. #54 found it
 * answering that question by probing port 8080 even when the run was pointed at a
 * remote distill target — so a remote `E2E_MODEL=record` pass came back as
 * `1 skipped`, which is the worst possible green: silent, and indistinguishable
 * from success in a summary line.
 */
test('a remote distill target answers the reachability question, a dead one does not', async () => {
  const { localModelUp } = await import('../e2e/session.ts')
  const wide = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}') })
  const widePort = await new Promise<number>((r) => wide.listen(0, '0.0.0.0', () => r((wide.address() as { port: number }).port)))
  const host = await nonLoopbackAddress()
  const saved = { up: process.env.E2E_UPSTREAM, key: process.env.E2E_UPSTREAM_KEY, mode: process.env.E2E_MODEL }
  try {
    process.env.E2E_MODEL = 'record'
    // no quiet pass: without a non-loopback address the branch is UNCOVERED, and a row
    // that nods along is the row that lets the skip come back
    assert.ok(host !== null, 'this machine exposes no non-loopback IPv4 — the remote branch of localModelUp() is UNCOVERED, not passing')
    const h = host as string
    process.env.E2E_UPSTREAM = `http://${h}:${widePort}`
    process.env.E2E_UPSTREAM_KEY = 'k'
    assert.equal(await localModelUp(), true, 'a reachable remote distill target must RUN the journey, not skip it')
    // a REFUSED port on the same host: an unroutable address (10.255.255.1) does not
    // fail fast, it black-holes the SYN and the row sat for two minutes — a test that
    // cannot finish is a test that does not exist.
    const dead = await new Promise<number>((r) => { const srv = net.createServer(); srv.listen(0, h, () => { const p = (srv.address() as { port: number }).port; srv.close(() => r(p)) }) })
    process.env.E2E_UPSTREAM = `http://${h}:${dead}`
    assert.equal(await localModelUp(), false, 'an unreachable remote must be a NO, never an assumed yes')
    process.env.E2E_UPSTREAM = `http://127.0.0.1:${widePort}`
    assert.equal(await localModelUp(), false, 'loopback stays the LOCAL stress regime: it is answered on :8080, not by E2E_UPSTREAM')
    process.env.E2E_MODEL = 'replay'
    assert.equal(await localModelUp(), true, 'replay IS the model: reachability never enters it, or a tape miss becomes a skip')
  } finally {
    for (const [k, v] of [['E2E_UPSTREAM', saved.up], ['E2E_UPSTREAM_KEY', saved.key], ['E2E_MODEL', saved.mode]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    wide.closeAllConnections()
    await new Promise<void>((r) => { wide.close(() => r()) })
  }
})

/**
 * The proxy's own visibility (#54). A distill that produced no tape entry for 20
 * minutes could not be classified from any artifact: no timeout on the upstream, no
 * record that a request was even in flight. These rows pin both halves — the bound,
 * and the journal that answers "was it progressing or was it hung?".
 */
test('a silent upstream dies at the bound and says so, instead of hanging the run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-proxy-dead-'))
  const journalPath = path.join(dir, 'misses.log')
  const silent = http.createServer(() => { /* never respond — the exact failure mode */ })
  const addr = await new Promise<{ port: number }>((r) => silent.listen(0, '127.0.0.1', () => r(silent.address() as { port: number })))
  const proxy = await startModelProxy({
    mode: 'record', tapeDir: path.join(dir, 'tape'), journalPath,
    upstream: `http://127.0.0.1:${addr.port}`, upstreamTimeoutMs: 400, stallWarnMs: 150,
    // no retry: this row is about the DEADLINE, and a retry loop would mask it behind a backoff
    upstreamRetryMax: 0,
  })
  try {
    const r = await post(proxy.url, 'k')
    assert.equal(r.status, 504, 'a dead upstream must surface as a gateway timeout, not an open socket')
    assert.match(r.body, /no response after 400ms/)
    const log = fs.readFileSync(path.join(path.dirname(journalPath), 'e2e-upstream.log'), 'utf8')
    // the path is whatever the harness asked for plus whatever the upstream base
    // already carries; the row cares that a START was JOURNALED, not the exact prefix
    // (in a real boot E2E_UPSTREAM has no /v1 precisely because req.url carries it).
    assert.match(log, /START path=.*chat\/completions/)
    // attempt=N is in the line because retries exist now; the assertion is unchanged in
    // meaning — a request with no bytes must announce itself BEFORE the deadline.
    assert.match(log, /STALLED attempt=\d+ elapsed=\d+ms bytes=0/, 'a request with no bytes must announce itself BEFORE the deadline')
    assert.match(log, /DEAD .*no-response-headers/)
    assert.equal(fs.readdirSync(path.join(dir, 'tape')).filter((f) => f.endsWith('.json')).length, 0,
      'a timed-out attempt never becomes a tape entry')
  } finally {
    await proxy.close()
    await new Promise<void>((r) => { silent.close(() => r()) })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a streaming upstream is logged as progress, and is not cut off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-proxy-live-'))
  const journalPath = path.join(dir, 'misses.log')
  const upstream = await startGuardedUpstream('k')
  const proxy = await startModelProxy({
    mode: 'record', tapeDir: path.join(dir, 'tape'), journalPath,
    upstream: upstream.url, upstreamKey: 'k', upstreamTimeoutMs: 5000, stallWarnMs: 150,
  })
  try {
    const r = await post(proxy.url, 'dummy')
    assert.equal(r.status, 200)
    const log = fs.readFileSync(path.join(path.dirname(journalPath), 'e2e-upstream.log'), 'utf8')
    assert.match(log, /FIRSTBYTE status=200 elapsed=\d+ms/)
    assert.match(log, /DONE elapsed=\d+ms status=200 attempts=\d+ bytes=[1-9]/)
    assert.doesNotMatch(log, /DEAD/, 'a live stream must never trip the bound')
  } finally {
    await proxy.close(); await upstream.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a throttled upstream is journaled as LIMITED and never becomes a tape entry', async () => {
  // The failure mode this row exists for: a shared hosted endpoint answers 429, the
  // journey hangs on a turn that will never arrive, and the log says nothing about why.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-proxy-429-'))
  const journalPath = path.join(dir, 'misses.log')
  const limited = http.createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Too Many Requests', code: 'throttling' } }))
  })
  const addr = await new Promise<{ port: number }>((r) => limited.listen(0, '127.0.0.1', () => r(limited.address() as { port: number })))
  const proxy = await startModelProxy({
    mode: 'record', tapeDir: path.join(dir, 'tape'), journalPath, upstream: `http://127.0.0.1:${addr.port}`,
    upstreamRetryMax: 0, // this row is about the throttle being surfaced, not the recovery
  })
  try {
    const r = await post(proxy.url, 'k')
    assert.equal(r.status, 429, 'the throttle reaches the caller as itself, not as a hang')
    const log = fs.readFileSync(path.join(path.dirname(journalPath), 'e2e-upstream.log'), 'utf8')
    assert.match(log, /LIMITED status=429/)
    assert.match(log, /NOT recorded/)
    assert.equal(fs.readdirSync(path.join(dir, 'tape')).filter((f) => f.endsWith('.json')).length, 0,
      'a throttle must never be distilled into the corpus as if it were an answer')
  } finally {
    await proxy.close()
    await new Promise<void>((r) => { limited.close(() => r()) })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The recovery the throttle row implies. The harness profile pins `maxRetries: 0` on purpose
 * (a queued generation behind a single-slot local server is worse than a clean failure), so
 * quota survival for a DISTILL has to live in the proxy — and it must not become a way to
 * record a throttle as an answer.
 */
test('a 429 is re-requested with backoff, and the eventual answer is what lands on the tape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-proxy-retry-'))
  const journalPath = path.join(dir, 'misses.log')
  let hits = 0
  const flaky = http.createServer((_req, res) => {
    hits += 1
    if (hits < 3) { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"slow down"}}'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"id":"r1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"recovered"},"finish_reason":null}]}\n\n')
    res.write('data: [DONE]\n\n'); res.end()
  })
  const addr = await new Promise<{ port: number }>((r) => flaky.listen(0, '127.0.0.1', () => r(flaky.address() as { port: number })))
  const proxy = await startModelProxy({
    mode: 'record', tapeDir: path.join(dir, 'tape'), journalPath,
    upstream: `http://127.0.0.1:${addr.port}`, upstreamRetryMax: 3, upstreamRetryMs: 30,
  })
  try {
    const r = await post(proxy.url, 'k')
    assert.equal(r.status, 200, 'the third attempt answers, and the caller sees the answer')
    assert.match(r.body, /recovered/)
    assert.equal(hits, 3)
    const log = fs.readFileSync(path.join(path.dirname(journalPath), 'e2e-upstream.log'), 'utf8')
    assert.match(log, /RETRY attempt=1 status=429/)
    assert.match(log, /RETRY attempt=2 status=429/)
    assert.match(log, /DONE .*attempts=3/)
    const files = fs.readdirSync(path.join(dir, 'tape')).filter((f) => f.endsWith('.json'))
    assert.equal(files.length, 1, 'exactly one entry for the whole retried exchange — the throttles wrote nothing')
    const entry = JSON.parse(fs.readFileSync(path.join(dir, 'tape', files[0]!), 'utf8')) as { status: number; model: string }
    assert.equal(entry.status, 200)
  } finally {
    await proxy.close()
    await new Promise<void>((r) => { flaky.close(() => r()) })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('exhausted retries relay the throttle once, count it, and still record nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-proxy-giveup-'))
  const journalPath = path.join(dir, 'misses.log')
  let hits = 0
  const mean = http.createServer((_req, res) => { hits += 1; res.writeHead(429); res.end('{"error":"nope"}') })
  const addr = await new Promise<{ port: number }>((r) => mean.listen(0, '127.0.0.1', () => r(mean.address() as { port: number })))
  const proxy = await startModelProxy({
    mode: 'record', tapeDir: path.join(dir, 'tape'), journalPath,
    upstream: `http://127.0.0.1:${addr.port}`, upstreamRetryMax: 2, upstreamRetryMs: 20,
  })
  try {
    const r = await post(proxy.url, 'k')
    assert.equal(r.status, 429)
    assert.equal(hits, 3, 'the first try plus two retries, then it stops')
    const log = fs.readFileSync(path.join(path.dirname(journalPath), 'e2e-upstream.log'), 'utf8')
    assert.match(log, /LIMITED status=429/)
    assert.equal(fs.readdirSync(path.join(dir, 'tape')).filter((f) => f.endsWith('.json')).length, 0)
  } finally {
    await proxy.close()
    await new Promise<void>((r) => { mean.close(() => r()) })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
