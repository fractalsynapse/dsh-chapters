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
