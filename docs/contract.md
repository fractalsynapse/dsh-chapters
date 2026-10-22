# DSH Plugin Contract

Verified against `examples/deepseek-harness` and the reference plugins. Every claim here cites a file
so it can be re-checked after an upgrade. **Nothing in this file is inferred.**

## Three Schema Systems

Conflating these is the top time-waster in this project.

| Declaring | Format | Import |
|---|---|---|
| Plugin `Config` | `Schema.object({...})` | `import Schema from '@deepseek-ai/schemastery'` — **default** |
| Tool `parameters` | plain declarative spec (`ParameterSchemaSpec`) | none; `defineTool` from `@deepseek-ai/dsh-tools` |
| Storage-domain records | zod | `import { z } from 'zod'` |

Plain objects are *required* for tool parameters and *rejected* for plugin config.

`import { z } from '@deepseek-ai/schemastery'` **does not exist** — 0 occurrences upstream versus 128
default imports. Copying the named form fails to build.

## Config

Shape copied from `examples/dsh-compact/src/index.ts:15,26-37`.

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  continuationBudgetRatio: number
  chapterTokenTarget: number
  toolResultDeferFloorTokens: number
  artifactStoreRoot: string
  tocBulletBudgetTokens: number
  pressureSuggestionRatio: number
}

// Per-model, mirroring the host's `modelPolicies[]` — do NOT invent a flat project-wide ratio.
export const Config: Schema<Config> = Schema.object({
  compactAtRatio: Schema.number().default(0.90),               // host thresholdRatio, ours defaults higher
  continuationBudgetRatio: Schema.number().default(0.25),      // of the window REMAINING after the header
  chapterTokenTarget: Schema.number().default(8000),
  toolResultDeferFloorTokens: Schema.number().default(200),    // a floor, not the policy — see below
  artifactStoreRoot: Schema.string().default('.dsh-chapters'),
  tocBulletBudgetTokens: Schema.number().default(2000),
  pressureSuggestionRatio: Schema.number().default(0.75),
})
```

These are **defaults overridable per model**, matching the host's own `modelPolicies: z.array(modelPolicy)`
(`compaction-basic/src/index.ts:113`) — some models have huge windows, some have 32K, and one flat number
serves neither. Resolve the window with `ctx.llm.resolveModelInfo()` and keep our own keys alongside the
host's rather than shadowing them. Three notes on the defaults, so nobody trusts them as settled:

- `continuationBudgetRatio` is a share of **(window − system prompt tokens)**, never of the whole window.
  See `docs/architecture.md § Budgets`. Measure the header once per process generation and cache it.
- `toolResultDeferFloorTokens` is **a floor, not the policy.** The keep/defer decision belongs to the model
  (`toolResultOverrides` below); the floor exists only so trivial results stay inline without being
  itemized, keeping the chapter's narrative readable and the exception list sparse. The number is a guess
  to calibrate in Phase 1 — too high and meaningful short outputs get deferred, too low and chapters bloat.
- **One exception since 2026-09-19:** `toolResultArtifactTokens` IS a policy — a hard band for results too
  large to be reasoning context at all (see architecture.md's arrival-time amendment). It intercepts at
  the tail node before the next request composes (the pruner's mid-history rewrite is NOT this); the
  model still judges everything below the floor, at archive time, exactly as before. Queries go through
  `chapters_artifact` (toc | search | read), which is read-only and store-contained by construction.
- There is deliberately **no maximum.** Deferral is a judgement with a size floor; over-sized output is
  caught by the continuation budget and by the chapter split signal, both of which refuse or report rather
  than silently clip.

Note `forkThresholdRatio` from earlier drafts is renamed to `pressureSuggestionRatio`: with the reordered
plan it gates a *suggestion*, not an action.

## Entry Point

```ts
export const name = 'dsh-chapters'          // must match package.json and cordis.patch.yml
export const inject = [/* service names */]
export const Config: Schema<Config> = …
export function apply(ctx: Context, config: Config) { … }
```

## Services (`inject`)

`dsh-session-fork/src/index.ts:161` shows the full menu: `commands`, `storageDomain`, `sessions`,
`sessionPersistence`, `sessionQuery`, `agents`, `tokenMeter`, `llm`, `sessionController`, `connection`,
`tools`, `systemPrompt`.

Ours, minimal and honest:

```ts
export const inject = [
  'sessions', 'sessionPersistence', 'sessionQuery', 'storageDomain',
  'agents', 'tokenMeter', 'llm', 'tools',
]
```

- `agents` — `ctx.agents.create`, the continuation primitive. **The load-bearing one.**
- `storageDomain` — chain registry.
- `sessionQuery` — `observeSession` for the calling agent's own log and preset projection, plus the
  durable reads for **other** sessions (see § Durable reads — the verbs are not interchangeable).
- `tokenMeter` — pressure math and the continuation budget preflight.
- **`systemPrompt` is excluded on purpose** (invariant 3).
- Add `commands` at the UI/CLI trigger phase; `connection` / `sessionController` only if a create path
  turns out to need the client RPC round-trip.

Declare only what you use — `dsh-compact` gets by on `inject = ["commands"]`.

## Durable reads — `sessionQuery` verbs are NOT interchangeable

Measured 2026-10-22 against host `0.2.0-rc.2` while root-causing #58. The rule this section exists to
enforce: **measure a host verb's payload *shape*, not its presence.** `spikes/subagent-end/FINDINGS.md`
finding 5 recorded `{count, types}` from `listEvents`, saw 10 plausible event types, wrote "returned the
full durable log", and the whole of door 5 was built on that. The types were real; the payloads were not
there at all.

| verb | returns | safe as an archive input? |
|---|---|---|
| `listEvents(sessionId)` | `SessionEventRecord[]` = `{sessionId, seq, type, time, surface}` — **no `data`** | **No.** Types and seqs only: a metadata index. |
| `readSession(sessionId)` | `{session: structuredClone(header), inheritedEventCount, events: snapshotSessionEvent(e)[]}` | **Yes**, and it carries the header too — one call, so no `listSessions()` scan. |
| `readSurface(sessionId)` | cloned header + `currentSurfaceEvents` (folded surface, snapshot-detached) | Yes for surface work; it is *folded*, so it is not the whole log. |
| `filterEvents(sessionId, filters)` | semantic event documents | No — search documents, not events. |

File:line (host install, `/home/adrian/node_modules/@deepseek-ai/dsh-session-query/`):
`lib/index.js:1141` `async listEvents(sessionId) { return eventRecords(sessionId, (await this._corpus.load(sessionId)).events) }`
→ `:845-847` `eventRecords` → `analyzeEventLog(sessionId, events).records`, built at `:966-973` as
`records: events.map((event) => ({ sessionId, seq: event.seq, type: event.type, time: event.time, surface: … }))`.
Published type: `lib/types/types.d.ts:43-54` (`interface SessionEventRecord` — the doc comment says
*"Lightweight metadata for one event"*, which is the sentence the spike skipped).
`lib/index.js:1079-1087` `readSession` → `events: loaded.events.map(snapshotSessionEvent)`;
`snapshotSessionEvent = adoptSessionEvent(structuredClone(event))` at
`@deepseek-ai/dsh-session/lib/index.js:1106-1108`, i.e. a **validated, payload-bearing** clone.

Read the header, never infer it: `readSession().session` is the kernel's own `SessionHeader` clone, so
`origin` / `parentSession` / `agentPreset` / `cwd` come from the same observation as the bytes being
archived — which is what door 5's gate and its `linkChild` lineage need (#58).

And the host's own teardown ordering, which decides **which** arm runs:
`@deepseek-ai/dsh-subagent/lib/index.js:1240-1250` (continuable) — `flushFinalState` →
`await activation.handle.dispose()` → `resident.delete(childId)` → `observer.settle(failure)`, and
`settle` is what emits `subagent/end` (`:317-324`). `observeRun` (one-shot, `:296-306`) emits earlier,
before disposal. So a continuable child's live handle is **always** gone at settlement: the durable arm
is the only arm for it, and the fast path is the only arm for one-shot children. Both must be tested;
one measurement of one mode is what #58 is.

`SessionEventLike.data` is therefore **required** in `src/types.ts` (was optional). Optionality is the
reason a `listEvents` record passed as `SessionEventLike[]` type-checked, and the renderer's
`ev.data ?? {}` then made a hollow chapter legal instead of failing to compile.

## Tools

`defineTool` at `packages/core/tools/src/schema.ts:545`:
`defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(...)`.

**`output` is mandatory** on every `ToolDefinition` — the `O` — and needs `{ schema, render }`. Idiom
from `dsh-session-fork/src/tools.ts:110-121`:

```ts
function jsonOutput<T>(schema: ValueSchemaSpec) {
  return { schema, render: (_args: unknown, value: T) => [{ type: 'text', text: JSON.stringify(value) }] }
}
```

Definitions (names pending the rename decision — see `docs/architecture.md § Naming`):

```ts
const chaptersContinue = defineTool({
  name: 'chapters_continue',
  description:
    'Archive this conversation as Markdown chapters and open a new session that starts from their '
    + 'table of contents. This session is left untouched. Supply event ranges, not text.',
  parameters: {
    title:       { type: 'string', required: true, description: 'Name for the continued session.' },
    handoffNote: { type: 'string', required: true, description: 'State of play: what was in progress, decisions held, next step. As long as it needs to be — it is budget-checked, not truncated.' },
    chapters: {
      type: 'array', required: true,
      description: 'Ranges ascending by startSeq, non-overlapping, all <= archiveCeiling, covering every event below the ceiling.',
    },
  },
  output: jsonOutput(CHAPTERS_CONTINUE_RESULT),
  async execute(args, exec) {
    // caller agent from `exec`; refuse cleanly when absent
  },
})
```

Register host-side: `ctx.tools.register(tool)`. Call-site precedent:
`dsh-session-fork/src/index.ts:786`.

## LLM Calls

Segmentation and summaries go through **`ctx.llm.stream()`** — the concrete method, not `ctx.llm`
generically. Window sizes via `ctx.llm.resolveModelInfo(provider, model, signal)`.

The cache-friendly pattern — a stream call reusing the conversation's own system prompt as its prefix —
is at `packages/compaction/compaction-basic/src/index.ts:225,290`. Copy that for segmentation so the
pass is served from cache.

## Session Creation

**Never** `ctx.sessions.fork(...)`. *(Corrected by Phase 0 measurement — an earlier draft of this file
claimed the method was client-only. It is not.)* `ctx.sessions` does expose `fork`, `_forkSeed` and
`_resolveForkSource` host-side; calling `fork` from a plugin is refused:

> `session fork is owned by session-controller; ambient plugin access is denied`

So the prohibition holds for a better reason than we stated: the copy-the-log path is capability-gated
away from plugins, and the kernel handler seeds with
`commands.ts:260` → `seed: source.events.slice(0, cut)` (invariant 2). Do not go looking for a way
through the gate — `agents.create` is the sanctioned seam.

Ours — `seed` is optional per `packages/core/agent/src/index.ts:95`
(`readonly seed?: readonly SessionEvent[]`); the multi-event and one-event seed contracts are measured
in [spikes/probe/FINDINGS.md](../spikes/probe/FINDINGS.md). **Phase 0b rewrote this call**: `agents.create`
composes NO preset — `meta.agentPreset` is a durable label only (r15: child first request 974 tokens,
`tools: 0`, a tool-less agent that cannot `read` its own chapters). Composition goes through the `setup`
callback exactly as session-controller's `composeAgent` does it
(`api/session-controller/src/agent.ts:377-390`; the service itself says so at
`preset/agent-presets/src/index.ts:221`):

```ts
ctx.agents.create({
  sessionId: newId,
  seed: [tocNoticeEvent],                      // exactly one event at seq 0 (invariant 2)
  inheritedEventCount: 0,
  meta: { cwd: parentCwd, agentPreset: presetId },
  agentOptions: ctx.get('agentDefaultModel').currentSelection(),
  setup: async (agentCtx) => { await ctx.get('agentPresets').mount(agentCtx, presetId) },
})
// then attach to the parent's workspace (r6 lesson: unattached sessions list nowhere)
```

Without `agentOptions` every turn dies pre-provider (`{{model}}` no value, r10); without `setup` the
child has no tools (r15); with both, r16 measured the real composed head: 13,315 tokens / 27 tools.
Carry over from `dsh-session-fork`: `src/vendor/fork.ts` (`forkWorkspace`, `composeAgent`,
`readSessionState`) already follows this shape. `branch.ts:10-14` warns that kernel `SessionStore.fork`
yields fiber-scoped sessions evicted from the sidebar — `agents.create` is the only durable, listed,
resumable route. *(Phase 0 confirmed: durable, listed, resumable, byte-identical across a kill.)*

Keep `anchoredBoundaryOf` (`vendor/fork.ts:213`) with its role changed: it yields the **archive ceiling**
(`boundarySeq`, `cut`) for *what to render*, never for seeding.

Notice event shape — built and vocabulary-pinned by `src/notice.ts` (+ `test/notice.test.ts`, + the
v4 admission rows in `tests/unit/host-seed-contract.test.ts`): one `user/message`, `surfaceOp: 'append'`,
at `seq = 0`, `source { kind: 'plugin:dsh-chapters', form: 'snapshot', sections: [{ name: 'chapters:toc', text }] }`
— **producer-owned kind, no `plugin` field**. Session format v4 (host 0.2.x, measured 2026-10-18 on
`0.2.0-rc.2`) retired the bare `kind: 'plugin'` wrapper: persistence-row admission refuses it with
`format v4 message requires a producer-owned source kind`
(`@deepseek-ai/dsh-session-format-v3-to-v4` `lib/index.js:126`; also
`dsh-session-persistence-jsonl/lib/worker.cjs:10902`). The v3→v4 migration's own
`rewritePluginSource` does exactly what we now emit: "kind is the producer's own kind and whose
`plugin` field is dropped". Continuity validation in `Session.create`
requires the seq to be the next contiguous seed position (rejection message measured in r5).

## Compaction Engine Integration (Phase 0b)

The subclass seam, with everything measured by rounds 12-17 (sources: the installed
`@deepseek-ai/dsh-compaction-basic@0.1.5-rc.2`; same tree in `examples/deepseek-harness`):

- `class X extends BasicCompactionEngine` (`export default` it; the loader mounts class plugins directly)
  and override `protected summarize(input, agent, signal?)` — the **sole** customization hook; `compactRegion`,
  `compactIfNeeded`, `compactNow` stay inherited. Subclassing inherits `static inject
  = ['llm','tokenMeter','sessions']` — extend it or `ctx.agents` throws *cannot get property "agents" without
  inject* (r12 crash).
- Deterministic summaries use the unmarked `SummaryResult` branch: `{ summary, provider, model }` with
  **no `llmStreamCall`** — the union explicitly admits "template, remote, or other summarizer"
  (`compaction-basic/src/summarizer.ts:100-106`); the durable `compaction/summary` schema matches
  (`compaction/src/types.ts`). Omit `usage` — its absence is the zero-token record (r12 verified).
- `summarize()` gets content, not seqs: `SummarizationInput = { tools?, messages }` where messages are the
  system head (when present) + the region's derived messages (`region.ts:545`). Correlate chapter files
  to ranges **post-commit** from `CompactionResult.shadowedSeqs` / the `compaction/summary` event — and
  remember the manual path calls `compactSurfaceRegion` directly (`index.ts:382`), so overriding
  `compactRegion` sees only the automatic paths.
- The kernel enforces the transaction: `compaction/start` lock, `SurfaceChangedError` → `changed`,
  shrink floor `framed ≥ priced` → refuse (`code='summary'`, r12), replacement `user/message` carries
  `source { kind: 'plugin', plugin: 'compact', compactionId }` — a NEW vocabulary member to pin against
  (our notices use `plugin: 'dsh-chapters'`; the checkpoint's is the host's own).
- Config: `retainRatio ∈ (0, 1]` (rc.2 validates; boot dies), `retainTokens ≥ 0`, `retainRatio <
  thresholdRatio`, `modelPolicies[]` per exact target, `auto` default true. Mounting shape per
  `docs/host-compaction-seam.md`: OUR row goes inside a preset's `cordis:group` realm
  (`isolate: { compaction: true }`), where `ctx.get('toolResultPruner')` also resolves in-realm —
  the standard preset deliberately mounts basic + command-compact + pruner as one group.
- Cross-copy identity rules (we ship our own `0.1.5-rc.2` deps; the host runs its copies):
  `ctx.get('compaction')` returns the host's receiver proxy — property reads work, `=== this` never
  (r12); duplicate provision of `compaction` on one plane fails boot loudly (r14); a host-plane
  `command-compact` does not classify OUR `ManualCompactionError` (different class objects) — put the
  command in our own realm rows or ship our command (r12 §J).

### Mounting shape, measured (stages 0-3)

- Realm rows resolve **subpath exports**: `name: dsh-chapters/engine` →
  `exports["./engine"]` (r18). Host-plane mounting is the wrong shape (double-fire
  with preset realms; the kernel's duplicate guard is same-plane only).
- The loader passes row config to constructors **unstripped**, and the base's
  `resolveConfig` **rejects unknown keys at runtime** (`BasicCompactionConfig:
  unknown key "artifactStoreRoot"`, r18) — peel engine-specific keys in the
  subclass constructor before `super(ctx, baseConfig)`.
- Preset delivery: the plugin registers the `chapters` declaration row at activation
  (`src/preset.ts` -> `ctx.get('agentPresets').register(...)`). The old copy of
  `presets/chapters/` into `$DSH_HOME/.agent-presets/` is GONE with the 0.2.0 support
  floor; the section "Presets are declaration rows" records why the row is not a shipped
  patch layer (`!!js` evaluates `disabled` before services mount, and an array
  `dsh.bundle.patch` throws on a pre-0.1.7 host). Related: profile `!!js` reaches
  `dshHomePath`/`process` but NOT `require` (r20 boot-killer).
- `ctx.logger` output is invisible to headless `dsh web` (r19); engine failures
  mirror to `$DSH_CHAPTERS_ENGINE_ERRORS` when set. Engine finalization runs on
  BOTH the success and rejection paths of `compactIfNeeded`/`compactNow` — the
  retry loop can commit then throw, and success-path-only finalization strands
  committed records (measured: 3 plans / 1 finalized / no errors).
- `@deepseek-ai/dsh-home-paths` exports `dshHomePath(...segments)` — the sanctioned
  way to reach `$DSH_HOME` from plugin code (host rc.2 line).

## Lineage: Kernel Fields We Must Not Lean On

`SessionHeader` (`packages/core/session/src/types.ts:93-122`) carries `version`, `id`, `createdAt`,
`cwd`, `parentSession`, `isSeeded`, `origin`, `delegationDepth` — and **no system prompt or tool
schemas**.

- `isSeeded` means "contains a fork-inherited event prefix"; our one-event synthetic seed is not that.
- `parentSession` is documented as *seed lineage*. Setting it to fake a relationship would be a misuse.
- Therefore **our storage-domain registry is the sole authority on ancestry**, and the web UI's branch
  graph will show our child as an unrelated root. A chain/manifest view is this plugin's job.
- The header being composed per request from the preset plus plugin contributions is *why* invariant 3
  holds, and why cache validity is per-process-generation: a restart or config edit recomposes it for
  everyone.

## Storage Domain Registry

Precedent verbatim: `examples/dsh-session-fork/src/store.ts:36-43`.

```ts
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const chapterRecord = z.object({
  id: z.string(),                     // `${authorSession}/${n}`
  authorSession: z.string(),          // keying by creator, not by a linear chain
  path: z.string(),
  startSeq: z.number().int().nonnegative(),
  endSeq: z.number().int().nonnegative(),
  sha256: z.string(),                 // integrity: verified before citing
  tokens: z.number().int().nonnegative(),
  summary: z.string(),
  createdAt: z.string(),
})

const sessionState = z.object({
  parentSession: z.string().nullable(),
  rootSession: z.string(),
  nextChapterNumber: z.number().int().nonnegative(),
  chapters: z.array(chapterRecord),
})

export const chapterDomainSpec = defineDomain({
  name: 'dsh_chapters',
  version: 0,
  tables: { sessions: domainTable<string, SessionState>(sessionState) },
})
```

Open with `ctx.storageDomain.open(spec)` → `table(name).get/put/entries/size`. `put` reaches backend
durability before resolving, so a resolved save survives restart. Backend is JSON under
`~/.dsh/storages`.

## Chapter File Format: Markdown + Frontmatter, Not XML

Decision with reasoning in `docs/architecture.md § File Format`. Short form: `.md` with YAML frontmatter.

```markdown
---
chapter: "003-database-schema"
title: "Database Schema"
session: 01HTZ6Q8K3
root: 01HTAB12CD7
seqRange: [184, 231]
sha256: 6d59…
tokens: 7420
generatedAt: 2026-09-15T17:22:04Z
artifacts: 2
---

# Database Schema

**User:** Let's design the user table…
```

Frontmatter carries every machine-queriable fact a parser would want. The body stays token-dense prose.
The `read` tool returns both; the harness's own skill loader uses this same frontmatter-plus-body idiom,
so it is an established convention here. **Do not convert chapters to XML** — see
`docs/architecture.md § File Format` for the full rationale and the one case that would reopen it.

## Packaging

`cordis.patch.yml` is required for the bundle to mount — a one-entry list that `insert`s the package by
name (compare `examples/dsh-session-fork/cordis.patch.yml`). Its `name` must match `package.json`. In
`package.json` the patch appears in **three** places:

```jsonc
"main": "lib/index.js",
"exports": { ".": {…}, "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
"files": ["lib", "cordis.patch.yml"],
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

Entry `apply(ctx, config)`. Build with `tsc -p tsconfig.json` and **build before installing**. A client
UI (later phase) additionally needs `dsh.client` and a `tsdown.client.config.ts` — see
`dsh-session-fork/package.json` for the shape.

### Presets are declaration rows now (host ≥ 0.1.7-alpha.1) — measured, with the incident

A user preset used to be a directory `$DSH_HOME/.agent-presets/<id>/` holding `preset.yml` +
`agent.cordis.yml`. The host's own migration note is blunt: *"Nothing reads that directory any more."*
(`@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md`). A preset is now an
`@deepseek-ai/dsh-agent-preset` **declaration row** (`config: {id, name?, description?, order, plugins}`;
`dsh-agent-preset/lib/index.js:13-20`) carried by a patch layer, and `AgentPresetRegistry.register()` is
fed only by such rows (`dsh-agent-preset-registry/lib/index.js:470`, installed 0.2.0-rc.2). Nothing
crashes when a plugin misses this: the bundle boots, its tools register, Settings says "enabled and
running", the preset is simply absent — and a session's preset id is **durable state** (`resumeObserved()`
→ `presets.resolve(id)`, `dsh-api-session-controller/lib/index.js:404`, `:364`; `resolve()` throws
`agent-preset/not-found`, `dsh-agent-preset-registry/lib/index.js:596`), so every chapters session refuses
to OPEN while its log sits there intact.

**This bundle DOES ship the row — in its one existing patch layer, with our own row module.**
`cordis.patch.yml` ends with `- insert: [{id: preset-chapters, name: '@treeseed/dsh-chapters/preset',
config: <the preset definition>}]`, so the preset is an ordinary Loader entry: visible in the plugin
list and `dsh --dump-default-config`, overridable or disable-able from a profile patch, positioned by
`config.order`. The row module (`src/preset.ts`) mirrors `@deepseek-ai/dsh-agent-preset`'s plugin line
for line and adds the pruning described below. Why not the host package directly, measured on the
0.1.5-rc.1 closure and on 0.2.0-rc.2:

- `dsh.bundle.patch` as an **array** (what a second layer requires) dies at profile load on a pre-0.1.7
  host: `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received an
  instance of Array` (`dsh-app-boot/lib/index.js:853`, `join(packageDir, declared)`). Array support and
  declaration rows arrive in the SAME release, 0.1.7-alpha.1 — so one layer, still a string, is both
  enough and the only boot-safe shape.
- a row naming `@deepseek-ai/dsh-agent-preset` in ANY layer a legacy host reads aborts its plugin tree:
  `plugin tree failed to load: … failed to import loader entry … Cannot find package` (the package is
  first published at 0.1.7-alpha.1). A row naming our own module resolves wherever our package runs.
- **`disabled: !!js` cannot capability-gate a root row**: the Loader evaluates `disabled` before services
  are mounted (`cordis-plugin-loader/lib/index.js:348` → `with (ctx) { eval(expr) }`), so
  `get('agentPresets')?.register === undefined` is true on the MODERN host too and the row never
  registers — measured (`preset-v2 … failed to import`, roster without it, while the same row with
  `disabled: !!js false` registered normally). Bare `get(...)` also throws there; only `ctx` is bound.
- and the row must be *ours* anyway for the reason below: it is the one place that can drop a child the
  host cannot load before the mount is attempted.

Three consequences of reading the registry rather than the filesystem:

- **A row that does not resolve is dropped, never mounted.** `mountPreset` throws if ANY enabled row failed
  (`dsh-agent-preset-registry/lib/index.js:272`), the registry stores it as `record.broken` (`:541`), and
  `retain()` then refuses with `agent-preset/invalid` (`:651`) — so one stale row makes the whole preset
  unusable, which is the same user-visible failure as a missing preset. Measured on 0.2.0-rc.2 with a row
  for `@deepseek-ai/dsh-tool-schedule` (published only from 0.2.1-alpha.1):
  `preset "chapters" is DECLARED BUT BROKEN — tool-schedule …: never started`. `pruneResolvableRows`
  (`src/preset.ts`) drops such rows and NAMES them in the mount line; `resolvableFromThisPackage` is the
  probe, asked with the row's full specifier so a lost subpath export is caught too.
- **A held disposer, not an effect.** `register()` returns an unregister disposer, and wiring it through
  `ctx.effect` un-registers the preset the moment our activation finishes — measured: `register()`
  succeeded while the roster came back WITHOUT `chapters`. The same apply-fiber trap bit the storage
  domain in r35. The disposer is held in a module array instead.
- **The roster is the health check, and it must be asked after activation.** The registry re-audits a mount
  by awaiting the settled loader tree (`:562`), and its doc says callers "must not run inside a Host row's
  own activation, which the settlement would wait on". So `reportPresetRoster()` runs deferred, and
  `compositionInventory()` rows say which mounted rows are actually `active` — `broken` alone hides a row
  that resolved but never started.

Rows are renamed and dropped between host versions, so re-anchor `src/preset.ts` against the installed
host's own `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` after an upgrade. Measured drift across
the five published versions (rc.1, rc.2, alpha.1, alpha.2, alpha.4): alpha.1 ADDS `dsh-time-context` +
`dsh-tool-schedule` + `toolFilter.deny[schedule_*]`; alpha.2 DROPS the persona `suffix` (with its
`{{cwd}}`), `backgroundMode`, and the codex/claude-code/ralph rows; alpha.4 rewrites the plan-mode
sentence, drops `toolFilter`, adds `dsh-plugin-market`. rc.1 and rc.2 are byte-identical.
`tests/unit/preset-declaration.test.ts` is what turns the next rename into a red row instead of a broken
user session — and it pins that `dsh.bundle.patch` is still a string.

- **Prompt variables are a closed set, and violating them throws per turn, not at boot.** `dsh-agent-loop`
  registers `provider`/`model`/`cwd` through 0.2.0-rc.2 (`lib/index.js:1564-1566`) and only `provider` and
  `model` from 0.2.1-alpha.2 (`:1591-1592`); `interpolate()` rejects any other reference with `prompt
  variable "{{x}}" has no value for this assembly` (`dsh-system-prompt/lib/index.js:171`). There is no
  `{{cwd}}` worth writing: `dsh-working-directory` (host plane) already prints `Current working directory:
  "…"` into the runtime context. This is what broke every new chapters session immediately AFTER the
  delivery fix above — the preset composed fine, the legacy `persona.suffix` interpolated `{{cwd}}`, and
  assembly threw on every turn. Pinned by the `{{variable}}` row of the test.
- **Some host plugins reject unknown config keys**, so a preset row's config is not free-form:
  `dsh-compaction-tool-result-pruner`, `dsh-compaction-basic` and `dsh-plan-mode` throw on any key they do
  not know (`PlanModeConfig has unknown key(s) …`); `dsh-tool-subagent` and `dsh-tool-ralph` are plain zod
  objects that strip them. Keep exactly `{thresholdChars, headChars, tailChars}` on the pruner and exactly
  `{section}` on plan mode.
- **Persona wording is load-bearing for the engine.** `src/engine-core.ts`'s `PLOT_TEMPLATE_ECHO` suppresses
  a "plot" that is really our own instruction quoted back (the 2026-09-25 audit: eight checkpoints of a
  real run inherited boilerplate, and because the result was non-null the bounded elicited fallback never
  ran). It matches phrases inside the suffix, so reword the suffix and the guard in the same change — the
  gate asserts that coupling by behaviour, not by copying the regex.

## Trigger Constraints

Two different actions, two different timings — Phase 0b measured the seam so this split is now factual,
not stylistic:

- **In-place compaction** (the engine's job) fires at the base's own timings, which we inherit:
  `agent/pre-step` pressure and `agent/request-error` overflow recovery
  (`compaction-basic/src/index.ts:144,176`). Pre-step is BETWEEN steps, never mid-request; the pressure
  loop is retry-bounded and its failures are caught, warned, and the turn continues (r13 watched it).
  An earlier draft called `agent/pre-step` "mid-turn, breaks the in-flight request" — the shipped design
  contradicts that reading; the harness itself compacts there, replay-safely. One structural limit worth
  remembering: `compactIfNeeded` needs a durable routed request, so the FIRST step of a fresh session can
  never compact (index.ts:260, measured r13).
- **Session creation** (`chapters_continue`, `chapters_fork`) fires at `turn/end` boundaries only — an
  archive ceiling is a completed `turn/end` by construction, and an in-flight exchange belongs to the
  handoff note, never a mid-turn cut.
- Manual is MVP. The button path cannot supply model-authored titles or ranges, so segmentation must be
  a plain function callable **without an agent turn** — build that seam in Phase 1, not Phase 5, or the
  UI and automatic paths both force a rewrite.
