/**
 * SDK gateway connector — HarnessClient-shaped API over one WebSocket (#31).
 *
 * The hosted DSH service (compose.sdk.yml) relays the stdio JSON-RPC of
 * `dsh --profile sdk` verbatim over a token-authenticated WebSocket. This
 * module is what consumers should use instead of hand-rolling that wire: same
 * method names, same notification shapes, and the SAME run()-semantics as
 * @deepseek-ai/dsh-sdk-client's DeepSeekHarness (receipt → collect → idle),
 * but with no child process on this side and no exact-version manifest check
 * to satisfy. Usage guide + the four measured caller rules: CONNECTOR.md.
 *
 * Wire facts encoded here (all measured against host 0.2.1-rc.2; see
 * dev/install/sdk-service-analysis.md):
 *   - frames are newline-delimited JSON-RPC carried ONE PER WS MESSAGE;
 *   - notifications arrive with params AS the flat envelope — session.event
 *     params are {seq,type,data}, there is no params.event nesting;
 *   - assistant text lives at params.data.message.content (block array);
 *     small local models lead with  reasoning — fold every block;
 *   - prompts before a successful initialize are refused server-side, so
 *     connect() performs the handshake and resolves only after it succeeds;
 *   - one connection owns one runtime child: close() sends shutdown then
 *     drops the socket (the gateway reaps the child either way).
 *
 * Zero hard dependencies: `ws` (or any WebSocket-compatible factory) is
 * injected via createSocket for tests; production defaults to importing 'ws'
 * dynamically. Type-stripped by Node 24 native TS — keep syntax erasure-safe.
 *
 * @module dev/install/sdk-gateway/connector
 */

// ── types (local structural mirrors of the protocol shapes; the published
// @deepseek-ai/dsh-sdk-protocol dist-tags are stale — do NOT import it) ──────

export interface ConnectorOptions {
  /** Gateway WebSocket URL, e.g. ws://localhost:8765 */
  url: string
  /** Shared secret, offered as the dsh-auth.<token> subprotocol (#25). */
  token?: string
  /** Bearer API key, sent as Authorization: Bearer <key> (#32). Wins over token when set. */
  bearerKey?: string
  /** Session working directory recorded on the runtime side. Default /workspace — the dir the image guarantees exists. */
  cwd?: string
  /** Provider route — MUST be a route the profile configures ('local', 'qwen-token-plan'). Never deepseek-official. */
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
  /** Bound on the initialize handshake (default 15s — vLLM cold GPU boot counts against the child spawn). */
  initializeTimeoutMs?: number
  /** Default bound on individual requests (session/wait/run legs are exempt; undefined waits indefinitely). */
  requestTimeoutMs?: number
  /** Socket factory seam for tests; production imports 'ws'. */
  createSocket?: (url: string, opts: { protocols?: string[]; headers?: Record<string, string> }) => SocketLike
}

/** Minimal surface we need from a WebSocket implementation. */
export interface SocketLike {
  send(data: string): void
  close(): void
  on(event: string, handler: (arg?: unknown) => void): unknown
  off?(event: string, handler: (arg?: unknown) => void): unknown
}

export interface GatewayNotification {
  method: string
  params: Record<string, unknown>
}

export interface RunResult {
  sessionId: string
  finalResponse: string
  events: GatewayNotification[]
  notifications: GatewayNotification[]
}

export class GatewayRequestError extends Error {
  readonly code: number | undefined
  readonly data: unknown
  constructor(code: number | undefined, message: string, data?: unknown) {
    super(message)
    this.name = 'GatewayRequestError'
    this.code = code
    this.data = data
  }
}

export interface GatewayConnection extends AsyncDisposable {
  run(prompt: string, options?: { sessionId?: string; onNotification?: (n: GatewayNotification) => void }): Promise<RunResult>
  resumeSession(sessionId: string): Promise<void>
  wait(sessionId: string): Promise<void>
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  subscribe(filter?: (n: GatewayNotification) => boolean): NotificationQueue
  getWorkingDirectory(sessionId: string): Promise<{ cwd: string }>
  setWorkingDirectory(sessionId: string, path: string): Promise<{ cwd: string }>
  close(): void
}

/** Awaitable queue with async iteration, mirroring HarnessClient.subscribe(). */
export interface NotificationQueue {
  next(): Promise<GatewayNotification>
  tryNext(): GatewayNotification | undefined
  [Symbol.asyncIterator](): AsyncIterator<GatewayNotification>
  return(): void
}

// ── implementation ────────────────────────────────────────────────────────────

const defaultCreateSocket = async (url: string, opts: { protocols?: string[]; headers?: Record<string, string> }): Promise<SocketLike> => {
  const wsMod = await import('ws')
  const WS = (wsMod as { default?: unknown; WebSocket?: unknown }).WebSocket
    ?? (wsMod as { default?: { WebSocket?: unknown } }).default
  if (typeof WS !== 'function') throw new Error('connector: could not load a WebSocket implementation (install `ws` or inject createSocket)')
  // node ws accepts protocols+headers positionally/options — build like its docs show
  return new (WS as new (u: string, o: Record<string, unknown>) => SocketLike)(url, {
    ...(opts.protocols === undefined || opts.protocols.length === 0 ? {} : { protocols: opts.protocols }),
    ...(opts.headers === undefined || Object.keys(opts.headers).length === 0 ? {} : { headers: opts.headers }),
  })
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }

/** Fold one assistant/message event into plain text (measured shape: data.message.content blocks). */
export function foldAssistantText(params: Record<string, unknown>): string {
  const data = (params.data ?? {}) as Record<string, unknown>
  const message = (data.message ?? data) as Record<string, unknown>
  const content = Array.isArray(message.content) ? message.content as { type?: string; text?: string }[] : []
  return content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text!).join('')
}

/**
 * Unwrap the session.event envelope across host versions (measured both ways):
 *   ≤0.2.0-rc.2: params IS the flat event — {seq, type, data}
 *   ≥0.2.1-rc.x: params wraps it — {sessionId, event:{type, seq, data}}
 * Read nested-first with flat fallback; never assume one shape on live bytes.
 */
export function unwrapEvent(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const nested = params.event
  if (nested !== undefined && typeof nested === 'object' && nested !== null) return nested as Record<string, unknown>
  return typeof params.type === 'string' ? params : undefined
}

/** True when a notification carries a committed assistant message. */
function isAssistantMessage(n: GatewayNotification): boolean {
  return n.method === 'session.event' && unwrapEvent(n.params)?.type === 'assistant/message'
}

function isIdleStatus(n: GatewayNotification, sessionId: string): boolean {
  return n.method === 'session.status' && n.params.sessionId === sessionId && n.params.status === 'idle'
}

class Queue implements NotificationQueue {
  private items: GatewayNotification[] = []
  private waiter: ((v: IteratorResult<GatewayNotification>) => void) | undefined
  private failer: ((e: unknown) => void) | undefined
  private closedState = false
  private readonly filter: ((n: GatewayNotification) => boolean) | undefined
  /** optional post-delivery hook (run() uses it to collect promptly) */
  onPush: ((n: GatewayNotification) => void) | undefined
  constructor(filter: ((n: GatewayNotification) => boolean) | undefined) { this.filter = filter }
  push(n: GatewayNotification): void {
    if (this.closedState) return
    if (this.filter !== undefined && !this.filter(n)) return
    if (this.waiter !== undefined) {
      const w = this.waiter; this.waiter = undefined; this.failer = undefined
      w({ value: n, done: false })
    } else this.items.push(n)
    this.onPush?.(n)
  }
  fail(err: Error): void {
    this.closedState = true
    const f = this.failer; this.failer = undefined; this.waiter = undefined
    f?.(err)
  }
  return(): void { this.closedState = true }
  tryNext(): GatewayNotification | undefined {
    return this.items.shift()
  }
  next(): Promise<GatewayNotification> {
    const head = this.items.shift()
    if (head !== undefined) return Promise.resolve(head)
    if (this.closedState) return Promise.reject(new Error('subscription closed'))
    return new Promise((resolve, reject) => { this.waiter = (r) => resolve(r.value); this.failer = reject })
  }
  async *[Symbol.asyncIterator](): AsyncIterator<GatewayNotification> {
    for (;;) {
      try { yield await this.next() } catch { return }
    }
  }
}

async function openSocket(options: ConnectorOptions): Promise<{ socket: SocketLike; opened: () => void }> {
  const protocols: string[] = []
  const headers: Record<string, string> = {}
  if (options.bearerKey !== undefined && options.bearerKey !== '') {
    headers.Authorization = `Bearer ${options.bearerKey}`
  } else if (options.token !== undefined && options.token !== '') {
    protocols.push(`dsh-auth.${options.token}`)
  } else {
    throw new Error('connector: authentication required — pass token (dsh-auth subprotocol) or bearerKey (Authorization header); refusing to connect anonymously')
  }
  const factory = options.createSocket ?? ((url: string, opts: { protocols?: string[]; headers?: Record<string, string> }) => defaultCreateSocket(url, opts))
  const socket = factory(options.url, { protocols: protocols.length > 0 ? protocols : undefined, headers })
  // ws-style sockets start connecting immediately; tests dispatch manually.
  return { socket, opened: () => { /* seam kept simple: handshake success marks ready */ } }
}

/** Connect, perform the initialize handshake, and resolve with a live connection. */
export async function connectToGateway(options: ConnectorOptions): Promise<GatewayConnection> {
  const { socket } = await openSocket(options)
  // Real sockets (and the test fakes) emit 'open' once connected; NOTHING may
  // send before that or ws throws "WebSocket is not open" (measured live).
  let markOpen!: () => void
  const opened = new Promise<void>((res) => { markOpen = res })
  let openSettled = false
  const settleOpen = (): void => { if (!openSettled) { openSettled = true; markOpen() } }
  socket.on('open', () => settleOpen())
  const pending = new Map<number, Pending>()
  const queues = new Set<Queue>()
  let nextId = 1
  let closed = false
  let shutdownSent = false

  const sendRaw = (obj: Record<string, unknown>): void => { socket.send(JSON.stringify(obj)) }

  const requestOnce = <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> =>
    opened.then(() => new Promise<T>((resolve, reject) => {
      if (closed) { reject(new Error('connector: transport closed')); return }
      const id = nextId++
      const entry: Pending = {
        resolve: (v) => resolve(v as T),
        reject,
        ...(timeoutMs === undefined ? {} : { timer: setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`connector: request timed out: ${method}`))
        }, timeoutMs) }),
      }
      pending.set(id, entry)
      sendRaw({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    }))

  const failAll = (err: Error): void => {
    for (const [, p] of pending) { if (p.timer !== undefined) clearTimeout(p.timer); p.reject(err) }
    pending.clear()
    for (const q of queues) q.fail(err)
  }

  // attach listeners BEFORE anything can send; message/close/error drive the machine
  let onMessage: (data: unknown) => void = () => {}
  socket.on('message', (d: unknown) => onMessage(d))
  socket.on('close', () => { if (!closed) { closed = true; settleOpen(); failAll(new Error('connector: gateway connection closed (runtime child reaped — reconnect and resumeSession to continue)')) } })
  socket.on('error', (e: unknown) => { if (!closed) { settleOpen(); failAll(new Error(`connector: transport error: ${String(e instanceof Error ? e.message : e)}`)) } })

  onMessage = (data: unknown): void => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)) as Record<string, unknown> } catch { return }
    if (typeof msg.id === 'number' && msg.method === undefined) {
      const p = pending.get(msg.id)
      if (p === undefined) return
      if (p.timer !== undefined) clearTimeout(p.timer)
      pending.delete(msg.id)
      if (msg.error !== undefined) {
        const err = msg.error as { code?: number; message?: string; data?: unknown }
        p.reject(new GatewayRequestError(err.code, err.message ?? 'gateway error', err.data))
      } else p.resolve(msg.result)
      return
    }
    if (typeof msg.method === 'string') {
      const note: GatewayNotification = { method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> }
      for (const q of queues) q.push(note)
    }
  }

  const conn: GatewayConnection = {
    async run(prompt, runOptions = {}) {
      const sessionId = runOptions.sessionId ?? `connector-${Date.now()}`
      const notifications: GatewayNotification[] = []
      const events: GatewayNotification[] = []
      let lastAssistant = ''
      // subscribe first, then queue the prompt (client README task-owning order)
      let settleIdle: (() => void) | undefined
      let settled = false
      const queue = new Queue(undefined)
      const collect = (): void => {
        for (;;) {
          const n = queue.tryNext()
          if (n === undefined) break
          notifications.push(n)
          runOptions.onNotification?.(n)
          if (n.method === 'session.event') events.push(n)
          if (isAssistantMessage(n)) { const ev = unwrapEvent(n.params); lastAssistant = foldAssistantText(ev ?? {}) }
          if (isIdleStatus(n, sessionId) && !settled) { settled = true; queue.return(); queues.delete(queue); settleIdle?.() }
        }
      }
      queue.onPush = () => { collect() }
      queues.add(queue)
      const idle = new Promise<void>((res) => { settleIdle = res })
      try {
        await requestOnce('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: prompt }] }, options.requestTimeoutMs)
        collect()
        await idle
      } finally { queues.delete(queue) }
      return { sessionId, finalResponse: lastAssistant, events, notifications }
    },
    async resumeSession(sessionId) {
      await requestOnce('session/resume', { sessionId }, Math.max(options.initializeTimeoutMs ?? 15_000, 30_000))
    },
    async wait(sessionId) {
      // session/wait legitimately spans whole agent activity: no timeout unless asked
      await requestOnce('session/wait', { sessionId })
    },
    async request(method, params) {
      return requestOnce(method, params, options.requestTimeoutMs)
    },
    subscribe(filter) {
      const q = new Queue(filter)
      queues.add(q)
      return q
    },
    async getWorkingDirectory(sessionId) {
      return requestOnce('session/working-directory/get', { sessionId }, options.requestTimeoutMs)
    },
    async setWorkingDirectory(sessionId, path) {
      return requestOnce('session/working-directory/set', { sessionId, path }, options.requestTimeoutMs)
    },
    close() {
      if (closed) return
      if (!shutdownSent) {
        shutdownSent = true
        // best-effort graceful shutdown (bounded: never blocks close)
        const id = nextId++
        sendRaw({ jsonrpc: '2.0', id, method: 'shutdown' })
      }
      closed = true
      socket.close()
      failAll(new Error('connector: closed'))
    },
    async [Symbol.asyncDispose]() { conn.close() },
  }

  // handshake: resolve only after initialize succeeds (rule 4 in CONNECTOR.md)
  try {
    await requestOnce('initialize', {
      cwd: options.cwd ?? '/workspace',
      provider: options.provider ?? 'local',
      model: options.model ?? process.env.LLM_MODEL ?? 'qwen3-4b-instruct',
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    }, options.initializeTimeoutMs ?? 15_000)
  } catch (err) {
    closed = true
    try { socket.close() } catch { /* already down */ }
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`connector: initialize handshake failed: ${detail}`)
  }
  return conn
}
