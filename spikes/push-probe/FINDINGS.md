# Push-transport probe — findings (2026-10-31, host 0.2.1-rc.5, real boot)

Probe: `spikes/push-probe/` — a self-driving plugin (projection + session + append strategies +
readbacks), booted under a real `dsh web` on `@deepseek-ai/dsh@0.2.1-rc.5` via
`DSH_HOME=<probe-home>`; runs: `node run.mjs host/probe-home 4199`. Four runs, findings stable
across the last two.

## Proven (green)

1. **`ctx.sessionProjections.register`** accepts a plugin's projection definition from apply() —
   duck-typed `{parse}` schemas included. key `pushProbe`, fold over `plugin:push-probe/note` records.
2. **`appendPluginRecord` works from a plugin** — via the HOST-ANCHORED resolution below — committing
   `ignorable: true` records with intact data (seqs 3/4/5, read back through `snapshotEvents`).
3. **The projection folds them**: `ctx.sessionProjections.stateOf(session, 'pushProbe')` →
   `{"notes":["via-B","via-C","via-D"],"count":3}`.
4. **Mount mechanics, measured the hard way** (three dead ends, all recorded): a profile plugin needs
   (a) `dsh.plugin add`-style provisioning — `link:` dependency in the profile package.json + a
   `dsh.profile.bundles` entry + **pnpm materialization** (a raw copy into node_modules loads
   nothing: no lockfile, no mount); (b) `dsh: { bundle: { patch: "./cordis.patch.yml" } }` in the
   plugin's package.json (without it: "declares no dsh.bundle" and the bundle is skipped); (c) an
   **`- insert:` row** (`id` + `name`) in that patch — a bare `- id:` row is a config override for a
   nonexistent entry and mounts nothing. `dsh plugin --profile web add "link:<dir>"` does (a) for you.
5. **Boot timing**: `ctx.agents.create` at apply() time races the agent factory ("no agent factory
   registered (load an agent-loop plugin)") — the base mounts `agent-loop` with `agents: []` and the
   web composition creates sessions on client request; a retry loop (10s spacing) succeeded on
   attempt 2. Any production append site rides turn/end or commands, never apply() — but the fact
   is recorded because a startup-time writer would hit it.
6. **Provider config for a headless probe**: rows `llm-pi-ai` (providers.<id> with
   `displayName/api/baseURL/models/apiKeyEnv` — `baseURL` capital URL) + `agent-default-model`;
   a dead route (port 9) is fine — session creation does not dial.

## The module-identity trap — measured, both directions

- **The plugin's OWN copy cannot be used, even at the identical version**: with
  `@deepseek-ai/dsh-session@0.2.1-rc.5` installed as the plugin's dependency, `appendPluginRecord`
  from it throws **"Receiver must be an instance of class Session"** against the host's live
  Session. Class identity is per module instance; a second copy in one process is a foreign class.
- **A bare `import('@deepseek-ai/dsh-session')` from a `link:`-installed plugin resolves by
  REALPATH** — it walks up from the plugin's SOURCE tree (here: the repo's stale dev copy →
  export ABSENT; on the maintainer's machine: `/home/adrian/node_modules`, a dev host tree, while
  the live server runs from `/usr/local` — cross-instance even in production). Bare imports are
  never the answer.
- **The recipe that works, with NO plugin dependency at all**:
  ```js
  const req = createRequire(process.argv[1] ?? process.execPath)   // anchor: the host binary
  const mod = await import(req.resolve('@deepseek-ai/dsh-session')) // hits the host's loaded instance
  typeof mod.appendPluginRecord === 'function'                      // feature detection
  ```
  Appended successfully in two consecutive runs (seqs 3–5). Production shape: try once behind
  try/catch; any failure marks push unavailable for the process and the pull schedule (#203/#208)
  stands — the fallback is the floor, never a crash.

## Not yet probed (implementation-phase work)

- The CLIENT half: `useProjection('<key>')` as a SessionStandardProp in the dock (source-verified
  in `ui-session` + `ui-goal`; empirical proof rides the live-class spec and the maintainer's browser).
- History-rendering absence: records are `ignorable: true` with an unknown `plugin:` type (both
  documented as skipped by readers); the empirical check is a browser session with appends.
- One transient: in the run where the plugin carried its own dep, an earlier no-dep run's bare-import
  crash (`null.Session`) did not reproduce; the recipe runs clean in the final configuration. The
  production code never bare-imports, so the anomaly is quarantined by design, not by luck.

## Addendum (2026-10-31, push-proof runs 1-15): what the live client proof can and cannot reach

- **Server push on the PRODUCTION plugin, real 0.2.1-rc.5 boot: LIVE.** `[chapters-push] transport LIVE`
  witness (stderr, same discipline as the door-armed line) on every boot; records of type
  `plugin:dsh-chapters/prompt` land in the durable log (`recordsInLog` 2→5 across boots).
- **Zero pulls observed in every configuration** (`runsBefore/runsAfter: 0` over 25s+ windows with the
  dock mounted elsewhere): where push is live and the bar has a pushed value or no session, nothing polls.
- **The last rendering hop is unreachable from a scripted browser, and the reason is host architecture,
  not our code:** sessions created through `ctx.agents.create` never appear in the GUI sidebar (the
  client session-controller does not list plugin-created sessions), and seeding the app's identity key
  (`dsh.sessions.current`) before load does not bind a session the client never catalogued. A GUI-known
  session requires a composer send, which on 0.2.1 in this harness remains unsolved (dialog focus traps
  ported and closed; `insertText` verified into the editor; the send itself never reached the durable log
  in the probe home — the rig's own helper succeeds on 0.2.0 and was not re-ported further).
  Therefore: `useProjection('chaptersPrompt') → pushEventsOf → the shared reducer` is verified by unit
  rows against the real reducer, and the seat itself is the host's standard SessionStandardProp (the
  goal bar's own). The maintainer's upgraded host is the acceptance check for the render hop; the
  staleness-confirm bounds any surprise to one pull per turn.
- **0.2.1 compat findings for the eventual rig pin bump:** (1) `agent-preset-registry` with
  `selectedDefault: chapters` fails activation when the chapters preset row is still pending on
  `agentPresets` — a validation circle absent on 0.2.0; the rig realm's row must change shape or order.
  (2) `llm-pi-ai` now validates `contextWindow >= 1` (a realm row carrying 0 aborts boot).
  (3) Duplicate `- id:` rows in one patch file invalidate the rows after them — the rig's replace-don't-
  append discipline is load-bearing, now also recorded in live-proof.mjs.
