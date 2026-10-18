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
2. **The event envelope shape depends on the host version — read both.** Measured live:
   ≤ 0.2.0-rc.2 sends `{ method:'session.event', params:{ seq, type, data } }` (params IS the event);
   ≥ 0.2.1-rc.x nests it — `{ params:{ sessionId, event:{ type, seq, data } } }`. The connector's
   `unwrapEvent()` handles both so callers never branch on it. Assistant text lives at
   `…data.message.content` (array of blocks); small local models lead with `` reasoning before
   the answer — fold every block, don't assume index 0.
3. **One connection owns one runtime process.** The gateway spawns `dsh --profile sdk` on your first
   frame and reaps it when the socket closes (also on protocol `shutdown`, also after the server-side
   idle TTL). There is NO mid-turn cancel on the wire: abandoning a turn means closing the connection;
   reconnect + `resumeSession()` to continue. Keep one connection per active conversation.
4. **initialize happens at connect time**, exactly once per connection, and the server refuses prompts
   before it succeeds. The connector does this handshake for you; pass `provider`/`model`/
   `reasoningEffort`/`maxTokens` in the options if the defaults are not what you want.

## Event capture reference — what the stream actually carries

You are never limited to "send a prompt and hope". Every durable fact the runtime commits streams as
`session.event` notifications, and whole-agent lifecycle arrives as `session.status`. Captured live
against host 0.2.1-rc.2 (a write+read turn emitted, in order):

```
permission/preset · sandbox/mode · approval/policy · agent/inbox/spliced · turn/start · step/start
· system/message · user/message · request/header · request/context · session/title · assistant/message
· tool/call · tool/result · step/end · turn/end          statuses: running → idle
```

| You want | Subscribe to | Payload pointer |
|---|---|---|
| The answer text | `assistant/message` | `data.message.content[]` blocks; small models emit reasoning first — fold or filter by `type` |
| **Thinking** | same message's `reasoning` blocks, or `assistant/attempt` (discarded retries) | `content[].type === 'reasoning'`; NOTE: `run().finalResponse` folds TEXT ONLY — read raw events for thinking |
| **Every tool invocation + arguments** | `tool/call` | `{turn, step, callId, name, arguments}` — e.g. `name:"write", arguments:{file_path,…}` is your file-change signal |
| Tool outcomes | `tool/result` | message with `toolCallId` correlation + content blocks (path/status/errors) |
| Turn/step boundaries & failure reasons | `turn/end`, `step/end` | `data.reason` (`{kind:'completed'}` / error / max-tokens) — the run-failure signal |
| Which model/route/cap answered | `request/header` | provider, model, maxTokens, reasoningEffort, adapter defaults |
| Session title (fallback or LLM-named) | `session/title` | `{title, messageSeqs, source}` |
| Context compaction activity | `compaction/start/summary/end/prune` | includes our chapters engine (`provider` tag) |
| Subagent tree | `subagent.started` / `subagent.finished` notifications (separate methods) | child sessionId/lineage; finished carries last assistant text |
| Plan mode, goals, todos, jobs | `plan/mode`, `goal/change`, `todo/write`, `job/registered/settled` | visible when those tools are used |
| Approval flow | `approval/asked` / `approval/decided` | present when policy asks (SDK wire has no client→server reply yet — see limits) |

Filter pattern (everything after just awaits idle inside `run`):

```ts
const sub = gw.subscribe(n => n.method === 'session.event')
for await (const n of sub) {
  const ev = (n.params as any).event ?? n.params          // version-tolerant (rule 2)
  if (ev.type === 'tool/call') console.log('tool:', ev.data.name, ev.data.arguments)
  if (ev.type === 'turn/end') console.log('reason:', JSON.stringify(ev.data.reason))
}
```

### Honest gaps (measured, #36 follow-ups)

- **Per-turn file-diff summaries** (`workspace/changes` event + diff service) exist in the host but are
  mounted by the **web-app bundle only** — the sdk profile does not have them today. Until that mount
  lands, reconstruct changed files from `tool/call` arguments (`write`/`edit` name `file_path`) plus
  `bash` results; it is complete for tool-mediated edits, not for out-of-band writes.
- **No mid-turn cancel** on the wire: observing a runaway turn means closing the connection (child
  reaps; resume later).
- **Approvals are one-way**: `approval/asked` streams out, but client→server notification/reply is
  unimplemented both ends — hosted runs must use auto-approve policies (`permission/preset` you see at
  turn start is the effective grant).
- Full catalog authority: `@deepseek-ai/dsh-session` exports `KNOWN_SESSION_EVENT_TYPES` (~65 types);
  anything outside it carries an `ignorable` marker rather than breaking reads.

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
