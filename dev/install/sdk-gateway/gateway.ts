/**
 * SDK API gateway — WebSocket↔stdio relay for `dsh --profile sdk` (#25).
 *
 * The host's SDK server (`@deepseek-ai/dsh-sdk-jsonrpc-server`) speaks
 * newline-delimited JSON-RPC over process stdio ONLY — there is no port or
 * HTTP route to reach it through (verified against examples/dsh @ 0.2.1-rc.2;
 * see dev/install/sdk-service-analysis.md). This gateway is the sanctioned
 * shape for hosting it: one WebSocket listener; per connection, spawn a
 * `dsh --profile sdk` child via the official `HarnessClient({ dshBin })` and
 * relay frames VERBATIM. The gateway never parses or mutates protocol content
 * beyond line framing — protocol semantics stay entirely host-side.
 *
 * Lifecycle contract (mirrors the stdio contract exactly):
 *   - one socket owns one runtime child; child death closes the socket;
 *   - socket close/shutdown reaps the child (EOF → SIGTERM → SIGKILL ladder
 *     inside HarnessClient.close());
 *   - idle past GATEWAY_IDLE_MS reaps the connection;
 *   - auth BEFORE spawn: Sec-WebSocket-Protocol must carry `dsh-auth.<token>`
 *     matching GATEWAY_TOKEN (fail closed when unset — this surface executes
 *     code; an unauthenticated open listener is never acceptable).
 *
 * Runs INSIDE the container only (compose publishes the port; the listener
 * itself binds loopback in-container like every other DSH surface here).
 *
 * Two planes in one file, deliberately: `createRuntimeLink` and friends are
 * pure (no node imports at module top) so tests/unit/dev-install-sdk-service
 * .test.ts can drive them over a fake child; the WS server below is the thin
 * impure shell. Type-stripped by Node 24 native TS (the repo's test runner);
 * keep syntax erasure-compatible (no enums/namespaces/parameter properties).
 *
 * @module dev/install/sdk-gateway/gateway
 */

import { createServer as createHttpServer } from 'node:http'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

// ── pure relay core (unit-tested) ─────────────────────────────────────────────

/** One line off either stream: blank lines are not frames. */
export function relayLine(line: string): string | null {
  return line.trim() === '' ? null : line
}

/** A raw stdout chunk of the child becomes ONE socket message per complete
 * line; an unterminated tail returns whole (the child closing mid-line must
 * still deliver its last frame if it is valid JSON without the newline). */
export function childLineToSocket(chunk: string): string | null {
  if (chunk === '') return null
  const trimmed = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk
  return trimmed === '' ? null : trimmed
}

/** Constant-time string equality over UTF-8 bytes (timing side channels are a
 * real concern on an RCE surface; lengths differ fast, then byte-wise OR). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!
  return diff === 0
}

/** Auth: accept `dsh-auth.<token>` anywhere in the offered protocol list.
 * Fail closed on an empty configured token — refusing service beats serving
 * an RCE surface to the network. */
export function authorizeProtocol(headerValue: string | undefined, expectedToken: string): boolean {
  if (expectedToken === '' || headerValue === undefined) return false
  return headerValue.split(',').map((s) => s.trim()).some((p) => p.startsWith('dsh-auth.') && timingSafeEqual(p.slice('dsh-auth.'.length), expectedToken))
}

/** Parse GATEWAY_API_KEYS: comma-separated, blanks dropped (#32). An empty
 * result means the bearer path is OFF — zero behavior change from #25. */
export function parseApiKeys(raw: string | undefined): string[] {
  if (raw === undefined) return []
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
}

/** Bearer auth (#32): `Authorization: Bearer <key>` or the `dsh-bearer.<key>`
 * subprotocol, matched constant-time against the configured key list. Scheme
 * name is case-insensitive per RFC 7235. Empty key list refuses everything. */
export function authorizeBearer(
  authorizationHeader: string | undefined,
  protocolHeader: string | undefined,
  keys: readonly string[],
): boolean {
  if (keys.length === 0) return false
  if (authorizationHeader !== undefined) {
    const m = /^bearer\s+(\S.*)$/i.exec(authorizationHeader.trim())
    if (m !== null && keys.some((k) => timingSafeEqual(m[1]!, k))) return true
  }
  if (protocolHeader !== undefined) {
    for (const part of protocolHeader.split(',').map((s) => s.trim())) {
      if (part.startsWith('dsh-bearer.') && keys.some((k) => timingSafeEqual(part.slice('dsh-bearer.'.length), k))) return true
    }
  }
  return false
}

/** Index of the bearer credential that matched (for honest logs without secrets). */
export function apiIndexFor(
  authorizationHeader: string | undefined,
  protocolHeader: string | undefined,
  keys: readonly string[],
): number {
  if (authorizationHeader !== undefined) {
    const m = /^bearer\s+(\S.*)$/i.exec(authorizationHeader.trim())
    if (m !== null) { const i = keys.findIndex((k) => timingSafeEqual(m[1]!, k)); if (i >= 0) return i }
  }
  if (protocolHeader !== undefined) {
    for (const part of protocolHeader.split(',').map((s) => s.trim())) {
      if (part.startsWith('dsh-bearer.')) {
        const i = keys.findIndex((k) => timingSafeEqual(part.slice('dsh-bearer.'.length), k))
        if (i >= 0) return i
      }
    }
  }
  return -1
}

/** Minimal view of a spawned runtime child — injectable for tests. */
export interface RuntimeChild {
  writeStdin(line: string): void
  onChildLine(handler: (line: string) => void): void
  onChildDeath?(handler: () => void): void
  close(): void
}

export interface RuntimeLinkOptions {
  /** Spawn the runtime child for this connection (production: HarnessClient). */
  spawnRuntime: () => RuntimeChild
  /** Sink for child stdout lines → the socket. */
  onSocketLine: (line: string) => void
  /** Called once when the child dies (socket side should close). */
  onRuntimeGone?: () => void
}

/** Per-connection bridge: lazy spawn on first inbound line, verbatim relay
 * both directions, single child-death edge, idempotent close. */
export function createRuntimeLink(options: RuntimeLinkOptions): {
  handleSocketLine(line: string): void
  close(): void
  readonly child: RuntimeChild
} {
  let child: RuntimeChild | undefined
  let goneFired = false
  let closed = false
  const fireGone = (): void => {
    if (goneFired) return
    goneFired = true
    options.onRuntimeGone?.()
  }
  const link = {
    get child(): RuntimeChild {
      if (child === undefined) throw new Error('runtime child not yet spawned')
      return child
    },
    handleSocketLine(line: string): void {
      if (closed) return
      const frame = relayLine(line)
      if (frame === null) return
      if (child === undefined) {
        child = options.spawnRuntime()
        child.onChildLine((raw) => {
          const out = childLineToSocket(raw)
          if (out !== null) options.onSocketLine(out)
        })
        child.onChildDeath?.(() => fireGone())
      }
      child.writeStdin(frame)
    },
    close(): void {
      if (closed) return
      closed = true
      child?.close()
      fireGone()
    },
  }
  return link
}

/** Idle TTL: fires `onExpire` once after `idleMs` without a touch(); touch()
 * re-arms; dispose() stops it forever. */
export function createIdleTimer(idleMs: number, onExpire: () => void): {
  touch(): void
  dispose(): void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const arm = (): void => {
    timer = setTimeout(() => {
      if (!disposed) onExpire()
    }, idleMs)
    // the gateway process must not be held open by idle timers alone
    timer.unref?.()
  }
  arm()
  return {
    touch(): void {
      if (disposed || timer === undefined) return
      clearTimeout(timer)
      arm()
    },
    dispose(): void {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

// ── impure shell: the actual server ───────────────────────────────────────────

export interface GatewayConfig {
  port: number
  host: string
  token: string
  /** Per-consumer API keys (#32); empty list = bearer path OFF. */
  apiKeys: string[]
  idleMs: number
  dshBin: string
  profile: string
  initializeTimeoutMs: number
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    port: Number(env.GATEWAY_PORT ?? 8765),
    host: env.DSH_GATEWAY_BIND ?? '127.0.0.1',
    token: env.GATEWAY_TOKEN ?? '',
    apiKeys: parseApiKeys(env.GATEWAY_API_KEYS),
    idleMs: Number(env.GATEWAY_IDLE_MS ?? 1_800_000),
    dshBin: env.DSH_BIN ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    profile: env.DSH_SDK_PROFILE ?? 'sdk',
    initializeTimeoutMs: Number(env.GATEWAY_INIT_TIMEOUT_MS ?? 30_000),
  }
}

/** Production runtime child: spawn `node <dshBin> --profile <profile>` with
 * piped stdio. We speak raw stdio (NOT HarnessClient) because the relay must
 * forward arbitrary request methods verbatim — including ones added by future
 * hosts — and own none of the protocol bookkeeping. Same-version guarantee:
 * the bin lives in this image's installed closure, so client and runtime
 * cannot drift. */
export function spawnDshRuntime(config: GatewayConfig): RuntimeChild {
  const proc = spawn(process.execPath, [config.dshBin, '--profile', config.profile], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })
  const emitter = new EventEmitter()
  let buffer = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    // split complete lines; hand each to listeners (the link relays them on)
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      emitter.emit('line', line)
      nl = buffer.indexOf('\n')
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    process.stderr.write(`[runtime ${proc.pid}] ${chunk}`)
  })
  proc.once('exit', (code) => {
    if (buffer !== '') emitter.emit('line', buffer) // flush an unterminated tail
    buffer = ''
    process.stderr.write(`[runtime ${proc.pid}] exited code=${String(code)}\n`)
    emitter.emit('death')
  })
  return {
    writeStdin(line: string): void {
      proc.stdin.write(line.endsWith('\n') ? line : `${line}\n`)
    },
    onChildLine(handler: (line: string) => void): void {
      emitter.on('line', handler)
    },
    onChildDeath(handler: () => void): void {
      emitter.once('death', handler)
    },
    close(): void {
      // EOF → SIGTERM ladder, mirroring the SDK client's dispose discipline.
      try { proc.stdin.end() } catch { /* already dead */ }
      setTimeout(() => { if (proc.exitCode === null && !proc.killed) proc.kill('SIGTERM') }, 2_000).unref()
      setTimeout(() => { if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL') }, 7_000).unref()
    },
  }
}

/** The real server: auth fence + per-socket runtime link + idle TTL. */
export async function serve(config: GatewayConfig): Promise<{ close(): void }> {
  if (config.token === '') {
    process.stderr.write('gateway: GATEWAY_TOKEN is empty — refusing to serve (fail closed)\n')
    process.exit(1)
  }
  const { WebSocketServer } = await import('ws')
  const http = createHttpServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  // handleProtocols: ws by default REJECTS an upgrade whose offered subprotocol is not
  // echoed back (live finding, #40 — every connector consumer hung at 'socket hang up').
  // Our auth rode the offer; echo the client's first offer and keep authorization in the fence.
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] })
  http.on('upgrade', (req, socket, head) => {
    const offered = req.headers['sec-websocket-protocol']
    const offeredList = Array.isArray(offered) ? offered.join(',') : offered
    const authHeaderRaw = req.headers.authorization
    const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw.join(',') : authHeaderRaw
    // #32 order: bearer keys first when configured (per-consumer identity), then the shared token.
    const bearerOk = authorizeBearer(authHeader, offeredList, config.apiKeys)
    if (!bearerOk && !authorizeProtocol(offeredList, config.token)) {
      socket.destroy()
      process.stderr.write('gateway: refused unauthenticated upgrade\n')
      return
    }
    if (bearerOk) {
      // name WHICH key accepted (index, never the secret) — audit trail without leakage
      process.stderr.write(`gateway: accepted upgrade via api-key #${apiIndexFor(authHeader, offeredList, config.apiKeys)}\n`)
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (ws) => {
    const idle = createIdleTimer(config.idleMs, () => {
      process.stderr.write('gateway: idle reap\n')
      ws.close(1000, 'idle')
    })
    const link = createRuntimeLink({
      spawnRuntime: () => spawnDshRuntime(config),
      onSocketLine: (line) => { if (ws.readyState === 1) ws.send(line) },
      onRuntimeGone: () => { try { ws.close(1011, 'runtime exited') } catch { /* already closed */ } },
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) return // the wire is text frames
      idle.touch()
      link.handleSocketLine(String(data))
    })
    ws.on('close', () => { idle.dispose(); link.close() })
    ws.on('error', () => { idle.dispose(); link.close() })
  })
  await new Promise<void>((resolve) => http.listen(config.port, config.host, resolve))
  process.stderr.write(`gateway: listening on ${config.host}:${config.port} (profile ${config.profile})\n`)
  return { close(): void { wss.close(); http.close() } }
}

if (import.meta.main) {
  void serve(configFromEnv())
}
