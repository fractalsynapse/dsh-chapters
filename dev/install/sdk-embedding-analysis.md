# Embedding the Deepseek Harness in-process — measured feasibility (#28)

**The question:** another TypeScript system (a Hono app) wants to use the DeepSeek Harness as its
agent runtime. Is there an API? Must everything go through process-spawning? Can Cordis + the dsh
plugin tree run *inside* our own Node process, as libraries?

**The short answer:** you were right that no *network* API ships — but wrong that forking is the
only execution path. The harness IS a library-first Cordis application: the SDK server itself is
just a plugin that calls `ctx.agents.create()` on an in-process tree it already lives inside. An
embedded Hono app can mount the same plugins and drive agents **directly, without the stdio hop at
all**. What you cannot do today is boot that tree from published npm packages by name — the bundle
packages' `latest` dist-tags are stale (see §4), which forces either exact-version pinning or a
profile-spawn hybrid. All facts verified against `examples/dsh` @ `dsh-v0.2.1-rc.2` plus live npm
registry queries (2026-10-18).

---

## 1. What actually ships as "the API"

| Surface | Transport | Where it lives |
|---|---|---|
| SDK JSON-RPC (`initialize`, `session/prompt`, `session/resume`, `session/wait`, working-dir get/set, `shutdown`) | **process stdio only** | `@deepseek-ai/dsh-sdk-jsonrpc-server` (plugin `sdk-jsonrpc-server`) |
| ACP (Agent Client Protocol) | process stdio only | `@deepseek-ai/dsh-acp` |
| Web GUI HTTP/WS | loopback HTTP + WS, token-exchange auth | `@deepseek-ai/dsh-web-app` — bound to serving *its own* browser, refuses wildcard binds; not a general agent API |
| CLI one-shot | argv in, stdout out | `dsh --profile headless` |

There is **no REST/HTTP endpoint for agent execution anywhere in the host.** Verified: zero port or
route in `packages/sdk/server/src/`; the `input`/`output` transport overrides in its Config are
documented as runtime-only test hooks. The sanctioned way to reach the protocol from another process
is what our gateway does: spawn `dsh --profile sdk` and speak over its pipes
(`@deepseek-ai/dsh-sdk-client` → `resolveDshLaunch` → `spawn`).

## 2. The fact that changes the picture: the SDK server is a thin wrapper over in-process services

`packages/sdk/server/src/server.ts` owns no magic. Its whole session machinery is ordinary Cordis:

```ts
// server.ts:412 — exactly what any embedded caller can do:
const handle = await (resume ? this.ctx.agents.resume({ resumeSessionId, agentOptions })
                             : this.ctx.agents.create({ sessionId, meta: { cwd }, agentOptions }))
```

and its notification fan-out is plain event listeners (`server.ts:103-129`):

```ts
ctx.on('session/event', (session, event) => transport.notify('session.event', payload))
ctx.on('agent/status',  ({ agent, status }) => transport.notify('session.status', …))
ctx.on('session/created', …); ctx.on('subagent/end', …)
```

So the "API" is really: **boot a plugin tree, call `ctx.agents`, subscribe to `ctx.on`.** The stdio
JSON-RPC layer is one optional projection of that. A Hono app that embeds the tree replaces the
projection with its own routes — no child processes, no relay, full multiplexing of sessions over
one runtime, mid-turn control available (dispose a handle — something the wire explicitly lacks).

The Agent factory contract is documented and stable (`packages/core/agent/src/index.ts:171-205`:
`createAgent(ownerCtx, options)` / `resume(ownerCtx, options)`, rollback-covered creation,
owner-scoped disposal). Our own AGENTS.md invariant-2 notes apply verbatim here: a created session
needs `agentOptions` AND the preset `setup` mount or the child is broken — the SDK server hits the
same requirement (`server.ts:400-407` comments point at the preset registry's "Composing a child
agent" section).

## 3. How a host tree gets booted programmatically

`@deepseek-ai/dsh-app-boot` exports the exact entry the launcher uses:

```ts
installFailLoud('my-app')
const ctx = await boot('my-app', resolveConfigPath(argv[2], …))   // app-boot README, "Starting the app"
```

`boot(binName, absoluteConfigPath, patches?, prepare?)` (`app-boot/src/index.ts:1200`) mounts a root
Include over ordered patch layers and returns the live `Context`. Every shipped profile composes from
bundle patch layers (`dsh.bundle.patch` declarations stacked in `dsh.profile.bundles` order); the
launcher adds `profileContext`, `cmdline`, etc. via its `prepare` hook — an embedder supplies its own
(`hostCtx.provide('profileContext', …)` pattern, see `apps/cli/src/profile-boot.ts:314-325` and the
worker-host carrier `packages/experimental/webworker-runtime/src/worker-host.ts:241`, which boots a
profile tree inside another process with NO dsh CLI involved — proof-shape that embedding is a
supported carrier pattern, not a hack).

Two audit rules constrain custom compositions (`app-boot/src/index.ts:951-960`):
`requiredStartupEntryIds` = {agent-loop, webserver, web-runtime, modules, connection,
headless-runner, acp, sdk-jsonrpc-server} — **"missing or disabled ids do not affect startup; an
enabled listed entry must activate."** So an embedded composition may simply NOT mount web/headless/
acp rows; whatever it does mount must come up clean.

## 4. The real blocker: published-package drift (measured 2026-10-18)

An external repo cannot write `import { … } from '@deepseek-ai/dsh-base'` and get a coherent tree:

| Package | npm `latest` dist-tag | Coherent line |
|---|---|---|
| `@deepseek-ai/dsh` (CLI) | **0.2.0-rc.2** | 0.2.1-rc.2 exists but is NOT latest |
| `@deepseek-ai/dsh-base` | **0.0.1-rc.1** | 0.2.1-rc.2 exists |
| `@deepseek-ai/dsh-sdk-app` | 0.1.2-alpha.2 | 0.2.1-rc.2 exists |
| `@deepseek-ai/dsh-agent-preset-registry` | 0.1.7-alpha.1 | newer exists |
| `@deepseek-ai/dsh-persona` | 0.0.1-rc.1 | newer exists |

The maintainer publishes every release commit under its exact version but leaves `latest` pointing
at old lines (the rc/dev cadence in the repo's own release history). Consequences for an embedder:

1. **Pin every package to the SAME exact version** (e.g. all `0.2.1-rc.2`). Ranges will float into
   the stale `latest` lines and produce a Frankenstein tree. `@deepseek-ai/dsh-base@0.2.1-rc.2`'s own
   dependencies are exact-pinned (`"0.2.1-rc.2"` across the board — verified), so one exact base pin
   pulls a consistent closure.
2. **Admission gates cut both ways.** Profile/bundle loading enforces `engines.dsh` /
   `@deepseek-ai/dsh*` peer ranges against `getDshRuntimeVersion()` (app-boot README §Profiles).
   Our own `@treeseed/dsh-chapters` declares `*` peers → admits anything; host packages at the same
   version admit themselves. Keep the pin uniform and nothing is refused.
3. The SDK client's same-version manifest check (`sdk/client/src/launch.ts:57-63`) is the *spawn*
   path's guard — irrelevant once you embed (no client, no spawn), which quietly removes one
   coupling we carry in the gateway design.

## 5. Integration shapes, ranked for the Hono ambition

### Shape A — keep the gateway (shipped, #25/#26/#27): spawn per connection
Zero host-API risk (pure public surfaces), one process per active conversation, no mid-turn cancel,
protocol bounded by the 7-method wire. Effort: done. Good default when N conversations ≤ RAM budget.

### Shape B — Hono app mounting the stock `sdk-jsonrpc-server` over injected streams
`@deepseek-ai/dsh-sdk-jsonrpc-server` accepts `input: Readable` / `output: Writable` / `exit`
(`server/src/index.ts:27-33`). Create one pair per HTTP request (or WS socket), hand the client side
to your route, and you have the *exact* SDK wire served over the network with zero protocol code of
yours — Hono just moves bytes. Caveats: the hooks are labeled test-only (they are plain `Readable`/
`Writable` params; low drift risk, but undocumented contract); `shutdown` disposes the ROOT context
and calls `process.exit(0)` unless you override `exit` — so per-connection shutdown means overriding
it and disposing selectively; stdout purity still applies (never compose a stdout logger).
Effort: ~1 day on top of an embedded boot (§6). Multiplexes many sessions per process.

### Shape C — first-class in-process agent API (the deep integration asked about)
Boot the tree yourself and expose Hono routes over the native services:

```ts
import { boot } from '@deepseek-ai/dsh-app-boot'
// config = a cordis.yml whose Include lists YOUR patch layers:
//   [dsh-base rows] + [your api rows] + [@treeseed/dsh-chapters] + [preset rows]
const ctx = await boot('cordis-api', cfgPath, patches, (host) => { host.provide('profileContext', pc); … })

app.post('/sessions/:id/prompt', async (c) => {
  const handle = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions })   // like server.ts:412
  // events: ctx.on('session/event', …) → SSE stream back to the caller
})
```

You gain: one runtime for all sessions, mid-turn dispose/steering, direct typed access to
`ctx.llm`, `ctx.sessionQuery`, storage domains, presets — everything. You take on: owning lifecycle
(the worker-host carrier is the precedent, but the launcher provides several services your `prepare`
must replicate: `profileContext`, `appReady`/`appExit`, `cmdline`, credentials seeding, DSH_HOME env),
version pinning discipline (§4), and re-validating after every host bump (drift-gate culture applies
×10 — `docs/host-compaction-seam.md` lessons generalize).
Effort: ~3–5 days to parity with what the sdk profile gives us today (presets, chapters, tinyfish,
credentials, model routing), then permanent maintenance of a bespoke boot path.

### Shape D — a new shipped profile ("hono-app") — REJECTED as a goal
A profile is bundles + YAML patches; it cannot execute custom route code. Custom HTTP belongs in the
consuming app (B/C), not in a profile. Naming correction for anyone tempted by "API profile": the
right artifact is an npm package owned by the other system, installing dsh packages as dependencies.

## 6. Recommendation

1. **Now:** keep Shape A running (merged, verified) — it answers the immediate need while the other
   system integrates.
2. **Next step toward the deep integration: Shape B as the bridge.** It is one file of glue over the
   STOCK server plugin, proves the embedded boot works inside a Hono process, and preserves wire
   compatibility with official SDK clients. Budget: ~1–2 days including the pin work below.
3. **Evolve to Shape C** only where you need what the wire cannot express (shared runtime across
   sessions, mid-turn cancel, direct service access). By then B has already forced the hard parts:
   the exact-version pin set, the minimal required-entry composition, stdout/logger hygiene, and
   credential/home management.
4. Regardless of shape: **pin every `@deepseek-ai/*` dependency to one exact version** and treat a
   host upgrade as a scheduled re-validation (our preset-declaration/host-seed drift gates are the
   template; the other system should copy the pattern, not assume `latest`).

Open decision for the user: whether the chapters plugin rides in the embedded tree too (Shape C
mounts `@treeseed/dsh-chapters` directly — it is a normal Cordis plugin; its web client plane simply
does not load without a web surface). Nothing blocks it; it is a scope choice.
