/**
 * SDK gateway connector gate (#31).
 *
 * The connector is the consumer-facing half of the hosted DSH service: a
 * HarnessClient-shaped API over ONE WebSocket (the relay our gateway already
 * speaks), so an internal TypeScript framework gets `connectToGateway(...)` +
 * `.run(prompt)` with no stdio bridging and no version-matching manifest check.
 *
 * Rows, outside-in — all offline over a fake gateway socket (zero model, zero
 * container; the live leg is the smoke client on the GPU box):
 *   1. acceptance — full happy path: connect → initialize handshake carries
 *      the profile's provider route → run() resolves with the last committed
 *      assistant text folded from the FLAT event envelope;
 *   2. regression — the four measured wire rules CONNECTOR.md names: flat
 *      params IS the event (no params.event nesting); reasoning-first content
 *      folds across blocks; prompts before a successful initialize reject;
 *      close is idempotent and shutdowns exactly once;
 *   3. contract — auth mode selection: token → dsh-auth.<token> subprotocol,
 *      bearerKey → Authorization header (#32), both refused cleanly when the
 *      server drops the socket;
 *   4. unit — request/subscribe/wait/resume surfaces over scripted frames.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

const mod = await import('../../dev/install/sdk-gateway/connector.ts')
const { connectToGateway } = mod as { connectToGateway: (opts: Record<string, unknown>) => Promise<any> }

// ── fake gateway socket: same shape ws.WebSocket uses (send/on/close) ────────

class FakeSocket {
  readonly sent: string[] = []
  private readonly handlers = new Map<string, ((arg?: unknown) => void)[]>()
  closed = false
  private responder?: (frame: Record<string, unknown>, emit: (obj: Record<string, unknown>) => void) => void
  /** server-side: decide how to answer each request frame */
  constructor(responder?: (frame: Record<string, unknown>, emit: (obj: Record<string, unknown>) => void) => void) { this.responder = responder }
  on(event: string, handler: (arg?: unknown) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    // a fresh WS reaches OPEN asynchronously; mirror that contract so the
    // connector's send-gating is exercised, not bypassed
    if (event === 'open') queueMicrotask(() => handler())
    return this
  }
  off(event: string, handler: (arg?: unknown) => void): this {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== handler))
    return this
  }
  send(data: string): void {
    this.sent.push(data)
    const frame = JSON.parse(data) as Record<string, unknown>
    if (this.responder === undefined) return
    this.responder(frame, (obj) => { this.dispatch('message', JSON.stringify(obj)) })
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.dispatch('close')
  }
  dispatch(event: string, arg?: unknown): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) h(arg)
  }
}

/** standard scripted gateway: init ok, prompt receipt, one assistant event, idle */
const scripted = (opts: { assistantTexts?: string[] } = {}) => (
  frame: Record<string, unknown>, emit: (obj: Record<string, unknown>) => void,
): void => {
  const method = frame.method as string
  const id = frame.id as number
  if (method === 'initialize') { emit({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } }); return }
  if (method === 'session/prompt') {
    emit({ jsonrpc: '2.0', id, result: { messageId: 'msg-1' } })
    // measured shape: params IS the flat event envelope {seq,type,data}
    for (const [i, text] of (opts.assistantTexts ?? ['the answer']).entries()) {
      emit({ jsonrpc: '2.0', method: 'session.event', params: { seq: 10 + i, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } } })
    }
    emit({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'task-1', status: 'idle' } })
    return
  }
  if (method === 'shutdown') { emit({ jsonrpc: '2.0', id, result: {} }); return }
  emit({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })
}

const connectWith = async (socket: FakeSocket, opts: Record<string, unknown> = {}) =>
  connectToGateway({ url: 'ws://fake', createSocket: () => socket as never, ...opts })

// ── 1. acceptance ─────────────────────────────────────────────────────────────

test('acceptance: connectToGateway handshakes then run() returns the committed assistant text', async () => {
  const socket = new FakeSocket(scripted())
  const gw = await connectWith(socket, { token: 't0ken' })
  assert.deepEqual(JSON.parse(socket.sent[0]!).params, {
    cwd: '/workspace', provider: 'local', model: 'qwen3-4b-instruct',
  }, 'initialize defaults carry the profile routes (never deepseek-official) and /workspace cwd')
  const result = await gw.run('summarize README.md', { sessionId: 'task-1' })
  assert.equal(result.finalResponse, 'the answer')
  assert.equal(result.sessionId, 'task-1')
  assert.ok(result.events.length >= 1, 'collected events are returned')
  gw.close()
})

test('acceptance: custom provider/model/reasoning options pass through to initialize', async () => {
  const socket = new FakeSocket(scripted())
  const gw = await connectWith(socket, { token: 't', provider: 'qwen-token-plan', model: 'qwen3.8-flash', reasoningEffort: 'low', maxTokens: 2048 })
  const init = JSON.parse(socket.sent[0]!)
  assert.equal(init.params.provider, 'qwen-token-plan')
  assert.equal(init.params.model, 'qwen3.8-flash')
  assert.equal(init.params.reasoningEffort, 'low')
  assert.equal(init.params.maxTokens, 2048)
  gw.close()
})

// ── 2. regression: the four measured wire rules ───────────────────────────────

test('regression: flat event envelope — params IS the event, no params.event nesting (#25 wire finding)', async () => {
  const socket = new FakeSocket(scripted({ assistantTexts: ['final text'] }))
  const gw = await connectWith(socket, { token: 't' })
  const seen: string[] = []
  const sub = gw.subscribe((n: { method: string }) => n.method === 'session.event')
  await gw.run('x', { sessionId: 'task-1' })
  let next = sub.tryNext()
  while (next !== undefined) { seen.push(String(next.params?.type)); next = sub.tryNext() }
  assert.deepEqual(seen, ['assistant/message'], 'event type readable at params.type directly')
  gw.close()
})

test('regression: host 0.2.1+ nests the event under params.event — unwrap reads BOTH shapes (#31 live finding)', async () => {
  // measured live against 0.2.1-rc.2: session.event params are {sessionId, event:{type,data}};
  // ≤0.2.0-rc.2 was flat. The connector must not hard-assume either.
  const responder = (frame: Record<string, unknown>, emit: (o: Record<string, unknown>) => void): void => {
    const id = frame.id as number
    if (frame.method === 'initialize') { emit({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'x', version: 'y' } } }); return }
    if (frame.method === 'session/prompt') {
      emit({ jsonrpc: '2.0', id, result: { messageId: 'm' } })
      emit({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 's', event: { seq: 4, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'nested answer' }] } } } } })
      emit({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 's', status: 'idle' } })
    }
  }
  const socket = new FakeSocket(responder)
  const gw = await connectWith(socket, { token: 't' })
  const r = await gw.run('x', { sessionId: 's' })
  assert.equal(r.finalResponse, 'nested answer', 'nested envelope unwrapped identically to flat')
  gw.close()
})

test('regression: reasoning-first small-model output folds across content blocks', async () => {
  const blocks = [
    { type: 'text', text: 'Okay, the user asked...' },   // 
    { type: 'text', text: 'THE REAL ANSWER' },
  ]
  const responder = (frame: Record<string, unknown>, emit: (o: Record<string, unknown>) => void): void => {
    if (frame.method === 'initialize') { emit({ jsonrpc: '2.0', id: frame.id as number, result: { serverInfo: { name: 'x', version: 'y' } } }); return }
    if (frame.method === 'session/prompt') {
      emit({ jsonrpc: '2.0', id: frame.id as number, result: { messageId: 'm' } })
      emit({ jsonrpc: '2.0', method: 'session.event', params: { seq: 9, type: 'assistant/message', data: { message: { role: 'assistant', content: blocks } } } })
      emit({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 's', status: 'idle' } })
    }
  }
  const socket = new FakeSocket(responder)
  const gw = await connectWith(socket, { token: 't' })
  const r = await gw.run('x', { sessionId: 's' })
  assert.equal(r.finalResponse, 'Okay, the user asked...THE REAL ANSWER', 'all text blocks fold in order')
  gw.close()
})

test('regression: prompts before a successful initialize reject — the server refuses them anyway', async () => {
  let resolvedInit = false
  const socket = new FakeSocket((frame, emit) => {
    if (frame.method === 'initialize') {
      // never answers until the test says so
      if (resolvedInit) emit({ jsonrpc: '2.0', id: frame.id as number, result: { serverInfo: { name: 'x', version: 'y' } } })
      return
    }
    emit({ jsonrpc: '2.0', id: frame.id as number, error: { code: -32603, message: 'SDK server is not initialized' } })
  })
  // connect must wait for initialize too — drive it manually with a stub that hangs init
  const hung = connectToGateway({ url: 'ws://fake', createSocket: () => socket as never, token: 't', initializeTimeoutMs: 150 })
  await assert.rejects(hung, /initialize/i, 'connect resolves only after the handshake succeeds')
  resolvedInit = true
})

test('regression: close() is idempotent and sends shutdown exactly once', async () => {
  const socket = new FakeSocket(scripted())
  const gw = await connectWith(socket, { token: 't' })
  gw.close(); gw.close(); gw.close()
  const shutdowns = socket.sent.filter((s) => JSON.parse(s).method === 'shutdown')
  assert.equal(shutdowns.length, 1, 'one shutdown per connection')
  assert.equal(socket.closed, true, 'the socket itself is closed')
})

test('regression: a dropped socket fails pending requests instead of hanging forever', async () => {
  const socket = new FakeSocket((frame, emit) => {
    if (frame.method === 'initialize') { emit({ jsonrpc: '2.0', id: frame.id as number, result: { serverInfo: { name: 'x', version: 'y' } } }); return }
    // session/prompt: never answers — then the socket dies
  })
  const gw = await connectWith(socket, { token: 't' })
  const p = gw.request('session/prompt', { sessionId: 'z', contentBlocks: [] })
  setTimeout(() => socket.dispatch('close'), 20)
  await assert.rejects(p, /closed|gone|transport/i, 'pending request rejects on transport loss')
})

// ── 3. contract: auth modes ──────────────────────────────────────────────────

test('contract: token mode offers the dsh-auth.<token> subprotocol', async () => {
  const protocols: unknown[] = []
  const socket = new FakeSocket(scripted())
  const gw = await connectToGateway({
    url: 'ws://fake', token: 'sekret',
    createSocket: (url: string, opts: { protocols?: string[] }) => { protocols.push(opts.protocols); return socket as never },
  })
  assert.deepEqual(protocols, [['dsh-auth.sekret']], 'subprotocol carries the shared token')
  gw.close()
})

test('contract: bearer mode (#32) sends Authorization and no dsh-auth subprotocol', async () => {
  const captured: { headers?: Record<string, string>; protocols?: unknown } = {}
  const socket = new FakeSocket(scripted())
  const gw = await connectToGateway({
    url: 'ws://fake', bearerKey: 'api-key-1',
    createSocket: (_url: string, opts: { protocols?: string[]; headers?: Record<string, string> }) => {
      captured.headers = opts.headers; captured.protocols = opts.protocols
      return socket as never
    },
  })
  assert.equal(captured.headers?.Authorization, 'Bearer api-key-1')
  assert.ok(captured.protocols === undefined || (captured.protocols as string[]).length === 0, 'bearer mode does not offer dsh-auth')
  gw.close()
})

test('contract: neither credential refuses at connect time', async () => {
  await assert.rejects(
    connectToGateway({ url: 'ws://fake', createSocket: () => new FakeSocket(scripted()) as never }),
    /token|credential|auth/i,
  )
})

// ── 4. unit: remaining surfaces ──────────────────────────────────────────────

test('unit: resumeSession routes session/resume and waits for its receipt', async () => {
  const answered: string[] = []
  const responder = (frame: Record<string, unknown>, emit: (o: Record<string, unknown>) => void): void => {
    const id = frame.id as number
    if (frame.method === 'initialize') { emit({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'x', version: 'y' } } }); return }
    if (frame.method === 'session/resume') { answered.push(String(frame.params?.sessionId)); setTimeout(() => emit({ jsonrpc: '2.0', id, result: {} }), 10); return }
  }
  const socket = new FakeSocket(responder)
  const gw = await connectWith(socket, { token: 't' })
  await gw.resumeSession('old-task')
  assert.deepEqual(answered, ['old-task'])
  gw.close()
})

test('unit: wait(sessionId) resolves on the session/wait response', async () => {
  const responder = (frame: Record<string, unknown>, emit: (o: Record<string, unknown>) => void): void => {
    const id = frame.id as number
    if (frame.method === 'initialize') { emit({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'x', version: 'y' } } }); return }
    if (frame.method === 'session/wait') { emit({ jsonrpc: '2.0', id, result: {} }); return }
  }
  const socket = new FakeSocket(responder)
  const gw = await connectWith(socket, { token: 't' })
  await gw.wait('task-1')   // must resolve, not hang
  gw.close()
})

test('unit: request() preserves wire errors as typed failures', async () => {
  const socket = new FakeSocket(scripted())
  const gw = await connectWith(socket, { token: 't' })
  await assert.rejects(gw.request('nonexistent/method'), (err: Error) => /nonexistent|not found|-32601/.test(err.message), 'JsonRpcResponseError-shaped rejection keeps the code/detail')
  gw.close()
})

test('unit: run() collects notifications and resolves at idle even with queued events', async () => {
  const responder = (frame: Record<string, unknown>, emit: (o: Record<string, unknown>) => void): void => {
    const id = frame.id as number
    if (frame.method === 'initialize') { emit({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'x', version: 'y' } } }); return }
    if (frame.method === 'session/prompt') {
      emit({ jsonrpc: '2.0', id, result: { messageId: 'm1' } })
      emit({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 's', status: 'running' } })
      emit({ jsonrpc: '2.0', method: 'session.event', params: { seq: 1, type: 'turn/start', data: { turn: 1 } } })
      emit({ jsonrpc: '2.0', method: 'session.event', params: { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first' }] } } } })
      emit({ jsonrpc: '2.0', method: 'session.event', params: { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'LAST wins' }] } } } })
      emit({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 's', status: 'idle' } })
    }
  }
  const socket = new FakeSocket(responder)
  const gw = await connectWith(socket, { token: 't' })
  const notes: string[] = []
  const r = await gw.run('go', { sessionId: 's', onNotification: (n: { method: string }) => notes.push(n.method) })
  assert.equal(r.finalResponse, 'LAST wins', 'finalResponse is the LAST committed assistant message')
  assert.ok(notes.includes('session.status'), 'onNotification observes the stream')
  gw.close()
})

test('unit: module exports the documented surface', () => {
  assert.equal(typeof mod.connectToGateway, 'function')
})
