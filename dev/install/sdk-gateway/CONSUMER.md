# Connecting another TypeScript project to the DSH SDK service

The one-page recipe for a project that lives **outside this repository**. It takes you from empty
directory to full streaming message-passing with a hosted DeepSeek Harness agent. The API reference
lives beside it in [CONNECTOR.md](CONNECTOR.md) — this file is the path, not the manual.

## 0. Prerequisites (the service side, once per host)

```bash
cd dev/install
docker compose -f compose.vllm.yml up -d                    # only if no model server runs yet
GATEWAY_TOKEN=$(openssl rand -hex 16) \
GATEWAY_API_KEYS=consumer-a,consumer-b \
  docker compose -f compose.sdk.yml up -d                   # gateway published on host :8765
curl -fsS http://localhost:8765/healthz                     # {"ok":true}
```

You need from whoever operates the stack: the **URL** (`ws://host:8765`) and one credential — a
bearer key from `GATEWAY_API_KEYS` (preferred, per-consumer) or the shared `GATEWAY_TOKEN`.

**Where can the port be reached from?** The listener binds loopback *inside* the container; Docker's
published-port forwarder answers on the **host machine** (`localhost:8765`), including from other
containers that reach the host. It is deliberately NOT reachable at the container's bridge IP
(measured: ECONNREFUSED on `192.168.x.x:8765`) — the RCE-safety rule the Web UI follows ("bind one
concrete address, never a wildcard") applies here too. Consumers therefore connect via:
same machine → `ws://localhost:8765`; another machine → `ws://<host-lan-ip>:8765` through a TLS
reverse proxy you control (never expose the raw port); same docker network as the HOST daemon is not
a thing — containers of co-located stacks use `host.docker.internal` (compose already maps it).

## 1. Your project: two files, zero build steps

The connector is dependency-free except a WebSocket implementation:

```bash
npm i ws                      # the only runtime dep
cp <this repo>/dev/install/sdk-gateway/connector.ts src/dsh/connector.ts
#   — or pull the pre-compiled single file out of the running image:
docker cp dsh-chapters-sdk-dsh-agent-api-1:/gateway/connector.mjs src/dsh/connector.mjs
```

`connector.mjs` is plain ESM JavaScript (no types to strip), so it works in Node ≥ 18 with no
toolchain; `connector.ts` is the same code with types if your project compiles TS. Either exports:
`connectToGateway`, `unwrapEvent`, `foldAssistantText`, `GatewayRequestError`.

## 2. Hello, agent

```ts
import { connectToGateway } from './dsh/connector.mjs'

const gw = await connectToGateway({
  url: 'ws://localhost:8765',
  bearerKey: process.env.DSH_KEY!,            // or token: process.env.DSH_TOKEN
  provider: 'local',                          // profile routes: 'local' | 'qwen-token-plan'
  model: 'qwen3-4b-instruct',
})
const { finalResponse } = await gw.run('Summarize this project in two sentences.', {
  sessionId: 'my-first-task',                 // YOUR identity — any stable string
})
console.log(finalResponse)
gw.close()                                    // reaps the runtime child; sessions survive
```

That's the whole basic contract. Everything below is getting the *full* architecture.

## 3. Full streaming: watch it think, call tools, change files

`run()` already collects everything; pass a sink and options to see it live:

```ts
const result = await gw.run('Create config.json with {port: 8080}, then read it back.', {
  sessionId: 'task-2',
  includeReasoning: true,                     // result.thinking = reasoning blocks (#37)
  onNotification: (n) => {
    if (n.method === 'session.status') return void status(n.params.status)        // running|idle
    const ev = n.params.event ?? n.params                                         // version-tolerant
    switch (ev.type) {
      case 'assistant/message':  streamText(ev.data.message.content); break        // text + reasoning blocks
      case 'tool/call':           console.log('using tool:', ev.data.name, ev.data.arguments)
      case 'tool/result':         console.log('tool said:', JSON.stringify(ev.data).slice(0, 120))
      case 'workspace/changes':   console.log('turn', ev.data.turn, 'changed the workspace')  // #37 announcement
      case 'turn/end':            console.log('outcome:', JSON.stringify(ev.data.reason))     // completed|error|maxTokens
    }
  },
})
```

Or subscribe independently of any run (a second UI over someone else's session):

```ts
for await (const n of gw.subscribe((n) => n.method === 'session.event')) { /* ... */ }
```

The complete event vocabulary and payload table is CONNECTOR.md's
[Event capture reference](CONNECTOR.md#event-capture-reference--what-the-stream-actually-carries).

## 4. Long-lived conversations: the lifecycle rules that matter

| Rule | What it means for your code |
|---|---|
| One connection = one runtime process | Keep ONE open connection per active conversation; do not ping-pong sockets per message |
| Idle TTL (~30 min default) closes quiet sockets | Reconnect + `await gw.resumeSession(id)` restores history (interrupted turn repaired, nothing sent); treat socket loss as normal |
| No mid-turn cancel on the wire | To abort: `gw.close()` (reaps the child), reconnect, resume, steer with the next prompt |
| Sessions are durable server-side | Your `sessionId` strings are the join key across restarts, days included — archive them |
| Prompts queue, results attribute loosely | `finalResponse` is the last committed assistant text before idle — steering/queued work can contribute; correlate by events when you need exact attribution |

```ts
// crash/redeploy recovery pattern
let gw = await connect()
try { await work(gw) } catch (err) {
  gw.close()
  gw = await connect()
  await gw.resumeSession(SID)                 // history intact
  await work(gw, { continue: true })
}
```

## 5. Raw protocol escape hatch

Anything the connector doesn't wrap is one call away — future host methods need no connector update:

```ts
await gw.request('session/wait', { sessionId })                       // incl. managed subagent descendants
await gw.setWorkingDirectory(sessionId, '/workspace/sub/project')    // where the agent's tools operate
await gw.getWorkingDirectory(sessionId)
```

Errors come back as `GatewayRequestError` carrying the wire `{code, message}` — branch on it.

## 6. Multi-session fan-out

One runtime serves many logical sessions over one connection; scope subscriptions per tree:

```ts
const a = await gw.run(promptA, { sessionId: 'agent-a' })   // concurrent-safe: requests multiplex
const b = await gw.run(promptB, { sessionId: 'agent-b' })   // same container, same model route
```

RAM scales with CONCURRENTLY RUNNING turns, not session count; finished sessions cost disk only.

## 7. Gotchas measured so you don't rediscover them

- `provider: 'deepseek-official'` → fails at first call (no credential here). Profile names only.
- cwd must exist in the container (default `/workspace`; mount real code there for the agent to touch it).
- Small local models emit thinking INSIDE text blocks (`<think>…`) rather than as separate reasoning
  content — filter text yourself if it offends downstream parsing; capable models use `reasoning` blocks.
- Approvals stream OUT (`approval/asked`) but cannot be answered over the wire — hosted profiles
  auto-grant; `permission/preset` at turn start is the effective policy.
- A refused auth never hangs: the socket is destroyed pre-spawn → your connect promise rejects.

## 8. Test doubles

Your CI shouldn't need a GPU. The connector's fake-socket pattern in
[`tests/unit/sdk-connector.test.ts`](https://github.com/treeseed-ai/dsh-chapters/blob/main/tests/unit/sdk-connector.test.ts)
(scripted JSON-RPC responder over an in-memory socket) is ~60 lines to copy — it drives the same
public API offline, including the flat/nested envelope shapes.
