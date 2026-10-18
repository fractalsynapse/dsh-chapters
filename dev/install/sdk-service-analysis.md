# Hosted DSH SDK Service — Integration Analysis

**Question:** add a Docker Compose definition that hosts the Deepseek Harness as an API (no Web UI),
so another system drives it with the DSH SDK client — and optionally lets a local `dsh web` UI point
at the same runtime. What's the effort?

**Answer in one line:** the *service* is ~1–2 days of work because the host ships every piece needed;
the *local Web UI against the same container* is either +0.5 day (separate web service) or a hard "no"
(one process serving both) — the SDK server is stdio-only by design. All file:line facts verified
against `examples/dsh` @ `dsh-v0.2.1-rc.2`.

---

## 1. What the host actually ships (verified)

| Surface | Package | Transport | Notes |
|---|---|---|---|
| SDK JSON-RPC server plugin | `@deepseek-ai/dsh-sdk-jsonrpc-server` (`packages/sdk/server`) | **stdio only** | `input`/`output` are documented as *"runtime-only test hooks; production uses process stdio"* (server README). The `JsonRpcLineTransport(input, output)` seam exists (`src/index.ts:58`) but is not config-reachable from YAML. |
| SDK profile bundle | `@deepseek-ai/dsh-sdk-app` (`packages/bundle/sdk-app`) | stdio | `dsh --profile sdk` = base tree + jsonrpc server + startup provider; HMR disabled; stdout reserved for frames. |
| Standalone minimal tree | `sdk-minimal` (`packages/bundle/sdk-minimal`) | stdio | Complete Cordis tree in one patch — no base, no Web rows. |
| ACP automation server | `@deepseek-ai/dsh-acp` (`packages/acp`) | stdio | Standard Agent Client Protocol: create/list/resume/close sessions, MCP attach, model select, prompts, permission answers, **cancel**. Same stdin/stdout constraint. |
| TS SDK client | `@deepseek-ai/dsh-sdk-client` (`packages/sdk/client`) | spawns subprocess | `HarnessClient` spawns `node <dshBin> --profile sdk [--patch …]` and speaks JSON-RPC over the child's pipes (`src/launch.ts:128-157`, `src/client.ts:214`). |
| Python SDK | `python/sdk` | spawns subprocess | Same protocol, bundled runtime. |
| Web app | `@deepseek-ai/dsh-web-app` | HTTP + WS | Token-exchange auth; **refuses wildcard binds** (`startup.ts:96`); supports `--host <concrete IP>`, `--trusted-host`, `--public-url` behind a prefix-stripping proxy. |

### Key architectural fact

The "SDK API" is **not a network service**. It is newline-delimited JSON-RPC over a process's
stdin/stdout. Every official consumer reaches it by *spawning* `dsh --profile sdk` as a child
(`resolveDshLaunch` → `spawn(command, args)`). There is no `listen`, no port, no HTTP route anywhere
in `packages/sdk/server/src/`. This decides the whole integration shape (§3).

### Protocol surface (7 requests / 4 notifications)

`initialize` · `session/prompt` → `{messageId}` · `session/resume` · `session/wait` ·
`session/working-directory/get|set` · `shutdown`
→ streamed back: `session.event` (every durable session fact), `session.status`,
`subagent.started`, `subagent.finished`.

Known limits (protocol README): no mid-turn cancel (abandoning a turn = close the runtime), no
per-prompt result attribution (`run()` collects receipt→idle), client→server notifications and
server→client requests unimplemented (approval flows would need these), version negotiation absent
(`serverInfo.version` = `0.0.1`, pre-release stance).

---

## 2. The dev/install configuration ports cleanly to headless

The current stack (`compose.yml`, `Dockerfile`, `docker-entrypoint.sh`) bakes everything into
`$DSH_HOME/profiles/web/`: generated `settings.yaml` (vLLM `local` provider + qwen token-plan
marketplace, `agent-default-model`, `agent-presets.default: chapters`), `profile-cordis.patch.yml`,
profile `package.json` bundles (`@treeseed/dsh-chapters`, codegraph, tinyfish), credentials seed at
mode 600, peer-symlink resolution fix.

**Correction (measured live, issue #25):** on host 0.2.x a profile-dir `settings.yaml` is read by
NOTHING. The only reader is `importLegacyDocument` (`packages/settings/settings/src/index.ts:243`)
at `$DSH_HOME/settings.yaml` — home level, one-time, renamed to `.imported` after import. The running
container proves it: `profiles/web/settings.yaml` sits there un-renamed, and `--dump-config` shows no
`baseURL` anywhere — the vLLM `local` provider the entrypoint generates has never taken effect; the UI
works because the qwen marketplace rows ride `cordis.patch.yml`. So config delivery for BOTH profiles
must be **patch rows, env-interpolated by the entrypoint into each profile's `cordis.patch.yml`** —
which is also what makes the sdk profile carry the identical configuration.

For an SDK profile this is **copy-and-retarget**, not redesign:

- `$DSH_HOME/profiles/sdk/package.json` declaring the bundles:
  `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app", "dsh-tinyfish-search", "@treeseed/dsh-chapters", "@jiangzhenguo/dsh-codegraph"]`
  — plus the same generated `cordis.patch.yml` content (minus web-only rows). Profiles are directories;
  the entrypoint just writes two of them.
- Patch semantics that make this safe: `- id:` rows REPLACE whole config blocks (restating required —
  base README §"Overrides replace whole settings blocks"), so the generated patch must carry the full
  `llm-pi-ai.providers` map (qwen marketplace + local vLLM) in one row; `!!js` interpolates at boot
  (proven: the shipped `sdk-app` patch uses it); a patch naming a nonexistent entry is a stderr warning,
  not a boot failure (app-boot README) — so web-only rows degrade honestly in the sdk profile.
- Admission check: plugins are version-gated against the runtime by `engines.dsh` or `@deepseek-ai/dsh*`
  peer ranges (app-boot README §Profiles). Our package declares `*` peers → admits any 0.2.x; pinning
  `DSH_HOST_VERSION` keeps client/server versions matched anyway (§3.A, exact-version rule).
- Another trap inherited from #19: never put env-var interpolation inside exec-form JSON arrays
  (`dev-install-compose.test.ts` pins exactly this class of failure).

## 3. Three viable integration shapes

### Option A — sidecar spawner (recommended first milestone)

```
┌───────────────────── compose service: dsh-agent-api ─────────────────────┐
│ thin Node wrapper (≈150–250 lines)                                      │
│   HTTP/WS front  ──auth──▶  per-connection pool of                      │
│                             HarnessClient({ dshBin: '/usr/local/bin/dsh',│
│                             profile: 'sdk', patches: [...] })           │
│                             → spawns `dsh --profile sdk` children       │
│                             → relays initialize/prompt/wait/resume/…    │
│                             → forwards session.event/status streams     │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Why it works:** `dshBin` is a public launch option; the child inherits the container env
  (`DSH_HOME=/dsh-home`, API keys) so the baked profile/settings apply verbatim. Session persistence
  lives under `$DSH_HOME/sessions`, so a killed child can come back with `session/resume`.
- **Version lock:** the client enforces *exact* same-version `@deepseek-ai/dsh` (`launch.ts:57-63`
  throws on mismatch) — pin `DSH_HOST_VERSION` in `.env` and install the matching client; trivial in
  one image, worth knowing across images.
- **Effort: ~1–2 days.** The wrapper must own: auth (reuse the `LOCAL_API_KEY` convention),
  connection↔runtime lifecycle mapping (one child per tenant/session-tree; `close()` walks
  EOF→SIGTERM→SIGKILL), fan-out of `session.event` to multiple watchers, restart-on-death, idle
  reaping, and a healthcheck. Everything else is plumbing.
- **Consequences:** each active conversation holds one full runtime process (~150–300 MB RSS, cold
  boot 2–10 s counted against `initializeTimeoutMs`, default 10 s — raise it on slow GPUs). No
  mid-turn cancel means a stuck turn costs you the whole child.

### Option B — WebSocket socket relay (zero custom product code)

`socat TCP-LISTEN:8765,fork,reuseaddr EXEC:"dsh --profile sdk"` inside the container, published to
the host; the consuming system runs its own small connector that spawns a local dummy process piped
to a `WebSocket` and hands those streams to `HarnessClient`'s internal transport — or you vendor the
~200-line `JsonRpcLineTransport` + `HarnessClient` request/subscription logic onto WS sockets
(the framing is line-delimited JSON, so the port is mechanical).

- **Effort: ~0.5 day demo, ~1–1.5 days hardened** (TLS/auth at a front proxy, per-socket lifetime =
  per-runtime lifetime, origin fence).
- **Caveats:** one socket per runtime (fine for "each agent connection owns a harness"); `shutdown`
  kills the child, socket loss kills the run (no resume until a new socket + `session/resume`);
  socat adds no auth — bind loopback-in-container and publish through whatever gateway you have.

### Option C — single process serving BOTH SDK and Web (what "potentially a local Web UI" hints at)

Add the `sdk-jsonrpc-server` row to the existing `dsh-web` profile composition — technically one
insert in `cordis.patch.yml`, the pieces coexist in one Cordis tree. But:

- the SDK server reads/writes **process.stdin/stdout**; a containerized long-running `dsh web` has
  nobody holding those pipes, so there is nothing for an external client to connect to;
- making it network-transported requires **forking** `dsh-sdk-jsonrpc-server` (replace stdio with a
  WS/socket accept loop, drop the exit-on-shutdown path) ≈ 200–400 lines, then maintaining that fork
  against a fast-moving rc-lineage host (the drift-gate discipline in AGENTS.md applies ×10 here).

**Verdict: don't.** If the local Web UI matters, run a second compose service `dsh-web` (the existing
image, unchanged) and let humans use it while machines use the SDK API. They share vLLM, not state.
(Sharing *session state* between them would mean pointing both at one `$DSH_HOME` volume — possible
for read/browse, but two live surfaces driving one session log is untested territory; keep the UI as
a viewer or give it its own home.)

## 4. What the consuming "other system" needs

- `npm i @deepseek-ai/dsh-sdk-client @deepseek-ai/dsh-sdk-protocol` (+ exact-match `@deepseek-ai/dsh`
  if it spawns locally; if it goes through Option A/B's network shim it only needs the protocol
  shapes). High-level `DeepSeekHarness.run()` for fire-and-collect; low-level `HarnessClient` +
  `subscribeSessionTree` for streaming supervisors; `session/wait` for task-owning orchestration.
- Model routing arrives at `initialize` (`provider`/`model`/`reasoningEffort`/`maxTokens`) and is
  validated against adapters mounted by the profile — so the vLLM `local` provider in the generated
  `settings.yaml` must name the exact model ids your agents request.

## 5. Effort summary

| Milestone | Scope | Estimate |
|---|---|---|
| M1 — hosted SDK service | `sdk.Dockerfile` (or extend `Dockerfile` to write both profiles), `compose.sdk.yml` (vllm + dsh-agent-api, no web), sidecar wrapper or socat, entrypoint profile-gen, boot smoke (`initialize` handshake against vLLM) | **1–2 days** |
| M2 — hardening | auth on the shim, multi-session fan-out, restart/idle-reap, healthcheck, `dev-install-compose.test.ts`-style gate rows for the new files, docs | **+1–2 days** |
| M3 — local Web UI | separate `dsh-web` compose service (already built today) | **+0.5 day** wiring |
| Not recommended | forked network-transport SDK server inside one web+sdk process | +3–5 days **and** permanent fork maintenance |

## 6. Open questions before building

1. Concurrency model of the other system: N simultaneous conversations ⇒ N runtime children (A/B) —
   acceptable? Or is true multiplexing required, which pushes toward the fork (C)?
2. Is `dsh-chapters` (this plugin) meant to ride in the hosted profile? Its tools/preset mount fine
   in any profile, but its storage-domain and TOC-notice machinery assume interactive continuation
   doors — decide whether the hosted agents get chapters or a leaner tool roster (`sdk-minimal` style).
3. Cancel semantics: SDK has no mid-turn cancel. If the other system needs stop-now, ACP
   (`packages/acp`) provides cancel + permission prompts over stdio — same socat/shim story, more
   standard wire, worth comparing before committing to the SDK profile.
