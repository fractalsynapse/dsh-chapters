# SDK Gateway Connector — usage guide (#31)

The connector turns the hosted DSH service (compose.sdk.yml, gateway on `:8765`) into a two-line call
for any TypeScript system. It speaks the same newline-delimited JSON-RPC wire as
`@deepseek-ai/dsh-sdk-client`, over **one WebSocket** instead of a spawned child process — no pipes,
no bridging, no version-matching manifest check to satisfy.

## Where it lives

Single source of truth: `dev/install/sdk-gateway/connector.ts`. The container image ships the compiled
file at `/gateway/connector.mjs`; consumers outside the image copy the source (or vendor the compiled
`.mjs`). No npm package exists for it — deliberately: the published `@deepseek-ai/*` dist-tags are
stale and a half-baked private package would be worse than one honest file (see
`sdk-embedding-analysis.md` §4).

## Quickstart

```ts
import { connectToGateway } from './connector.ts'   // or '/gateway/connector.mjs' in-container

await using gw = await connectToGateway({ url: 'ws://localhost:8765', token: process.env.GATEWAY_TOKEN! })

// high-level: one owned activity interval, like DeepSeekHarness.run()
const result = await gw.run('summarize README.md in one line', { sessionId: 'task-42' })
console.log(result.finalResponse)     // last committed assistant text before idle

// low-level: raw protocol, when you want receipts and streaming yourself
const { messageId } = await gw.request('session/prompt', {
  sessionId: 'task-42',
  contentBlocks: [{ type: 'text', text: 'next step please' }],
})
for await (const n of gw.subscribe()) {         // session.event / session.status / subagent.*
  if (n.method === 'session.status' && n.params.status === 'idle') break
}
```

Resume after a drop is part of the contract — sessions are durable under `$DSH_HOME/sessions`:

```ts
const gw2 = await connectToGateway({ url, token })     // fresh connection = fresh runtime child
await gw2.resumeSession('task-42')                     // history restored, interrupted turn repaired
await gw2.run('what did we decide earlier?')           // answers with continuity
```

## The four rules every caller must know (measured against host 0.2.1-rc.2)

1. **Provider routes are the profile's names**: `local` (vLLM) or `qwen-token-plan` (Alibaba). Never
   `deepseek-official` — it mounts an adapter with no credential here and fails at first call. The
   connector defaults to `local`/`qwen3-4b-instruct` and passes whatever you give it through.
2. **The event envelope is FLAT.** A notification arrives as `{ method:'session.event', params:{ seq,
   type, data } }` — `params` IS the event; there is no `params.event`. Assistant text lives at
   `params.data.message.content` (array of blocks). Small local models lead with `` reasoning
   before the answer — fold the whole block list, don't assume index 0.
3. **One connection owns one runtime process.** The gateway spawns `dsh --profile sdk` on your first
   frame and reaps it when the socket closes (also on protocol `shutdown`, also after the server-side
   idle TTL). There is NO mid-turn cancel on the wire: abandoning a turn means closing the connection;
   reconnect + `resumeSession()` to continue. Keep one connection per active conversation.
4. **initialize happens at connect time**, exactly once per connection, and the server refuses prompts
   before it succeeds. The connector does this handshake for you; pass `provider`/`model`/
   `reasoningEffort`/`maxTokens` in the options if the defaults are not what you want.

## API surface

| Member | Wire | Notes |
|---|---|---|
| `connectToGateway(opts)` | `initialize` | resolves after handshake; opts: `url`, `token`, `bearerKey` (#32), `cwd` (default `/workspace`), `provider` (default `local`), `model` (default env `LLM_MODEL` else `qwen3-4b-instruct`), `reasoningEffort?`, `maxTokens?`, `requestTimeoutMs?` |
| `gw.run(text, {sessionId?, onNotification?})` | prompt → events → idle | returns `{sessionId, finalResponse, events, notifications}`; mirrors `DeepSeekHarness.run()` semantics including its caveat: `finalResponse` is the last committed root-assistant text in the interval, not causally attributed to the prompt |
| `gw.resumeSession(id)` | `session/resume` | requires the original persistence home (same volume); rejects missing/occupied without creating a replacement |
| `gw.wait(sessionId)` | `session/wait` | resolves when the root stays idle incl. managed descendants |
| `gw.request(method, params?)` | any | raw escape hatch — future host methods need no connector release |
| `gw.subscribe(filter?)` | notifications | async-iterable queue, same shape as `HarnessClient.subscribe` |
| `gw.getWorkingDirectory(id)` / `setWorkingDirectory(id, path)` | working-directory get/set | |
| `gw.close()` / `await using` | `shutdown` then socket close | idempotent; never leaves the child orphaned |

## Auth

Two modes, both accepted by the gateway (#25 shipped the first, #32 adds the second):
- **token** (default): offered as the `dsh-auth.<token>` WebSocket subprotocol.
- **bearer key**: `Authorization: Bearer <key>` header when the server configured `GATEWAY_API_KEYS`.

The connector picks automatically: `bearerKey` set → header mode; otherwise `token` → subprotocol.
Refusal is silent-by-design (socket destroyed pre-spawn) — a failed connect surfaces as a connect
error, never as a hung promise.

## Testing your integration offline

The connector has zero hard dependencies (`ws` is injected), so unit tests drive it over any
WebSocket-shaped stub. See `tests/unit/sdk-connector.test.ts` for the pattern: a fake gateway that
answers `initialize`, echoes a prompt receipt, streams a flat `session.event` envelope and an `idle`
status. Copy the fixture when testing consumer code against a fake harness.
