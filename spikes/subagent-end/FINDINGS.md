# Spike FINDINGS — subagent-end auto-save facts (issue #47)

One boot, zero model tokens. The probe (`lib/index.js`) registers a fake one-shot
`SubagentProvider` on the real `subagents` service, whose child is a REAL session created
through the same `agents.create({parentAgent, meta})` seam the in-process driver uses
([dsh-subagent-in-process-driver/lib/index.js:183](/home/adrian/node_modules/@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js), `childSessionMeta` at
[dsh-subagent/lib/index.js:470-481](/home/adrian/node_modules/@deepseek-ai/dsh-subagent/lib/index.js)),
and whose `run.result` resolves by hand. The SERVICE wraps it in `observeRun`, so
`subagent/start`/`subagent/end` travel through the real lifecycle emitter. Host:
`dsh 0.2.0-rc.2`, session format v4. Raw facts: `results-47.json`.

## Measured

1. **Host-plane subscription works.** `ctx.on('subagent/start'|'subagent/end', fn)` registered
   without refusal; both fired exactly once per run. The ambient `subagents` service is
   injectable and `registerProvider`/`start(name, request)` are reachable from a plugin.
2. **`end` strictly precedes disposal.** Observed ordering: result microtask chain →
   `observeRun` emits → listener runs SYNCHRONOUSLY → only then the run holder's collect/
   dispose continuation resumes (`settleForegroundRun`,
   [dsh-tool-subagent/lib/index.js:316-324](/home/adrian/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js)).
   A synchronous read inside the listener is race-free — **verified**, not assumed:
   `handleResolved: true` at emit.
3. **The live handle gives everything.** `ctx.agents.get(info.id)` at emit →
   `session.snapshotEvents()` returned the COMPLETE child log synchronously (10 events incl.
   the kernel `permission/preset`/`sandbox/mode`/`approval/policy` prefix, our authored
   `turn/start…turn/end`, and the kernel-added `session/title`), plus
   `session.header`: **`parentSession`** (== the spawning parent id), **`origin: 'subagent'`**,
   **`agentPreset: 'chapters'`**, **`delegationDepth`**, `cwd`. All from `childSessionMeta` —
   the real driver writes them; no provider cooperation needed beyond `agents.create`.
4. **Preset gate: read the header/projection, never scan events.** On the synthetic child NO
   `agent-preset/selected` event was appended, yet `sessionProjections.stateOf(session,
   'agentPreset')` returned `'chapters'` AND `header.agentPreset` was present. The gate
   predicate is `header.origin === 'subagent' && header.agentPreset === <preset id>`
   (projection as fallback); an event scan would silently skip every child.
5. **Post-dispose fallback exists and is NOT capability-gated.** After `dispose()`
   (`agents.get(id)` → undefined, verified), `sessionQuery.listEvents(childId)` and
   `sessionQuery.readSession(childId)` each returned the full durable log. The ambient gate
   concern from Phase 0 applies to `sessions.fork`, NOT to these read verbs.
   Caveat found on the way: these calls RE-PARSE the stored v4 log and validate it — our
   first synthetic assistant/message (missing `source.kind`, then missing open turn/step
   context) surfaced as `SESSION_QUERY_CORRUPT_SESSION`, not a permission error. Production
   logs are well-formed by construction; the fallback is sound.
6. **Payload truth matches the published types.** `subagent/end` = `{runId, provider, id,
   local, stopReason, lastAssistantMessage?}`; `info.id` is the child session id; the run's
   `runId` for a local run equals the child session id (verified `runIdEqualsChildId`).

## Design implications (locked by these facts)

- Listener lives on the **host plane** (`src/index.ts apply`): one subscription per process,
  alongside the services it already injects.
- **Sync-snapshot fast path**: inside the listener callback, resolve the handle, copy
  `snapshotEvents()`, read header fields — before any await. Everything the save pipeline
  needs (events, cwd, `parentSession`, preset, watermark inputs) is in hand.
- **Fallback arm**: if the handle is ever gone at emit (provider variance, timing drift),
  read durably via `sessionQuery.listEvents`; only when BOTH fail → skip with the
  `#diagnostic`-class warn, never guess.
- The child's chapters land in its **own tree** (`rootSession = childId`, the registry
  default — no `linkChild`), and the chapter frontmatter carries
  `subagent: true` + `parentSession: <id>` from the header (user decision, issue #47).
- Continuable children re-fire `end` per residency epoch; the save watermark
  (`fromSeq = max(chapter.endSeq) + 1`) makes repeats no-ops by design.

## Reproduce

```bash
cp -a .dshdev-local .dshdev-probe47
# add dep "dsh-chapters-probe-subagent-end": "file:<repo>/spikes/subagent-end" to
# .dshdev-probe47/profiles/web/package.json + dsh.profile.bundles, then
ln -s <repo>/spikes/subagent-end .dshdev-probe47/profiles/web/node_modules/dsh-chapters-probe-subagent-end
DSH_HOME=$PWD/.dshdev-probe47 timeout 180 dsh web --port 0 --no-open   # probe self-exits
cat spikes/subagent-end/results-47.json
```

The probe writes `results-47.json` incrementally and exits the process; the scratch home is
gitignored; nothing touches `~/.dsh`.


## Verification round (47b) — PRODUCTION wiring, same zero-token method

`lib/verify.js` (results in `results-47b.json`) drives the SAME real service
emitter but checks the EFFECT of the shipped plugin mounted in the scratch
profile — not a test double:

| row | claim | result |
|---|---|---|
| V1 | the plugin's `apply()` listener reacts to a real settlement | PASS (observed effect, not a log grep) |
| V2 | chapters written under the CHILD's own tree | PASS |
| V3 | frontmatter carries `subagent: true` + `parentSession: "<parent id>"` | PASS |
| V4 | registry rows committed for the child (search door reads these) | PASS |
| V5 | a second settling child archives cleanly alongside the first | PASS |
| V6 | a `standard`-preset child produces NO store directory | PASS |

Live handles were still resolvable at every `end` (handle-on-child at
re-settle: true), matching the disposal-ordering fact above. The remaining
arm — the real `subagent` TOOL driving a real model through door 5 — is for
the tape chain once the host lock moves to 0.2.x (backlog item 0); its
spawn-path difference from this verification is `childSessionMeta` +
`resolveChildAgentOptions`, both text-pinned by `tests/unit/host-subagent-seam.test.ts`.
