/**
 * End-to-end smoke for the SDK API gateway (#25). Runs INSIDE the container:
 *   docker compose -f compose.sdk.yml exec dsh-agent-api node /gateway/smoke.mjs
 * (the image ships this file to /gateway/smoke.mjs at build.)
 *
 * It is a real WS client of its own server: connects with GATEWAY_TOKEN,
 * initializes on the `local` provider route (the small-model stance), sends one
 * prompt to a throwaway session, and streams until the whole agent reports
 * idle. Exit 0 = one complete agent turn through the chain
 * (gateway → `dsh --profile sdk` child → vLLM). Not a CI gate — it needs the
 * GPU stack up; the deterministic rows live in
 * tests/unit/dev-install-sdk-service.test.ts.
 */
import WebSocket from 'ws'

const PORT = process.env.GATEWAY_PORT ?? '8765'
const TOKEN = process.env.GATEWAY_TOKEN ?? ''
if (TOKEN === '') { console.error('smoke: GATEWAY_TOKEN required'); process.exit(1) }

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, [`dsh-auth.${TOKEN}`])
let nextId = 1
const pending = new Map<number, (value: Record<string, unknown>) => void>()
const failures: string[] = []
let eventCount = 0
let sawAssistant = false
let settled = false

const send = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)) }
    }, 120_000).unref()
  })

ws.on('message', (data) => {
  let msg: Record<string, unknown>
  try { msg = JSON.parse(String(data)) as Record<string, unknown> } catch { return }
  if (typeof msg.id === 'number' && typeof msg.method !== 'string') {
    const resolve = pending.get(msg.id)
    if (msg.error !== undefined) {
      failures.push(`${String(methodOf(msg))}: ${JSON.stringify(msg.error)}`)
    }
    if (resolve !== undefined) { pending.delete(msg.id); resolve(msg) }
    return
  }
  if (msg.method === 'session.event') {
    eventCount += 1
    // measured wire shape: the event envelope is FLAT — {seq, type, data}
    // sits directly in params, NOT under params.event.
    const ev = (msg.params as { event?: { type?: string }; type?: string } | undefined)?.event
      ?? (msg.params as { type?: string; seq?: number } | undefined)
    // measured: assistant/message data wraps the message as {turn, step,
    // message:{role, content:[…]}}, and small local models emit  reasoning
    // first — search the whole committed text for the marker.
    if (ev?.type === 'assistant/message') {
      const data = (msg.params as { event?: Record<string, unknown>; data?: Record<string, unknown> })?.event?.data
        ?? (msg.params as { data?: Record<string, unknown> })?.data
      const text = JSON.stringify(data ?? {})
      if (text.includes('SMOKE_OK')) sawAssistant = true
    }
  } else if (msg.method === 'session.status') {
    const params = msg.params as { status?: string } | undefined
    if (params?.status === 'idle' && !settled) { settled = true; finish() }
  }
})

const methodOf = (_msg: Record<string, unknown>): string => 'request' // errors surface via the awaited send() too

function finish(): void {
  console.log(`smoke: events=${String(eventCount)} assistantMessage=${String(sawAssistant)} failures=${failures.length}`)
  for (const f of failures) console.error('  ' + f)
  if (!sawAssistant) { console.error('smoke: FAIL — no committed assistant message'); ws.close(); process.exit(1) }
  console.log('smoke: PASS — one full agent turn through the gateway')
  send('shutdown').catch(() => undefined).finally(() => { ws.close(); process.exit(0) })
}

ws.on('open', async () => {
  try {
    // 1. handshake: the profile's routes are `local` / `qwen-token-plan` —
    //    deepseek-official would mount an adapter with no credential here.
    await send('initialize', {
      cwd: '/workspace',
      provider: process.env.SMOKE_PROVIDER ?? 'local',
      model: process.env.SMOKE_MODEL ?? process.env.LLM_MODEL ?? 'qwen3-4b-instruct',
    })
    console.log('smoke: initialize OK')
    // 2. one prompt into a fresh session; collect notifications until idle.
    const sessionId = `smoke-${Date.now()}`
    await send('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text: 'Reply with exactly the word: SMOKE_OK' }],
    })
    console.log('smoke: prompt accepted, streaming…')
    setTimeout(() => { if (!settled) { console.error('smoke: FAIL — no idle within 3 min'); process.exit(1) } }, 180_000).unref()
  } catch (error) {
    console.error('smoke: FAIL —', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})

ws.on('error', (error) => { console.error('smoke: socket error', error.message); process.exit(1) })
