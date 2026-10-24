# dsh-chapters — agent core

Working spec for an agent with a 32K–128K context. This file holds only what you must not get wrong.
Detail lives in `docs/` and is linked at the point of use — read those on demand, not first.
**User-facing documentation lives ONLY on the site: https://treeseed-ai.github.io/dsh-chapters/**
(numbered §1–§28; `site/src/content/docs/` holds its sources) — never duplicate a how-to into this
repo; link the site. README = doorway for humans, AGENTS.md = load-bearing spec for agents.

**Find-fast table (query → where).** What is this / install / commands / config → site §§1–4, 15–17.
Why not summaries, budgets, RLM theory, invariants → site §§5–8 (+ this file's sections below).
Knowledge pool, providers, search, rules, enrichment mechanics → `docs/knowledge-repo.md` (record) +
site Part III. Host API facts incl. exact file:line → `docs/contract.md`. Compaction seam →
`docs/host-compaction-seam.md`. Build/test loop + tape system → `docs/development.md` + site §24.
Claims & verification procedures → `docs/verify.md`. Transport truth table → `docs/provider.md`.
Prompt recommendations / composer ghost layer / `/chapters-prompt` → site §28 +
`docs/contract.md` § Composer Ghost Layer (measured host facts; pull transport, push on 0.2.x).
Session plans in chapters / the ACTIVE PLAN line / `kind: plan` documents / seeded plan mode / findability → `docs/plans-carriage.md` (+ the corpus amendments in `docs/knowledge-repo.md`).
Project history — what was built, measured, proven by which round → `docs/project-state.md` (reference, not a rule surface)
Open items / what a fresh session should pick up next → `docs/backlog.md` (NOTE: `tsconfig.json` excludes `src/client/` — the client plane is checked by `npm run typecheck:client` (`tsconfig.client.strict.json`), which CI runs beside `typecheck` (#71); keep both green) (scoped, with the traps already fixed on main).
Numbers from real runs (compaction, cache, retrievals) → site Part V (field study §20, cache §21).
Releases/incidents → site §26 + git log. Benchmarks → `benchmarks/README.md` + site §19.
Dev/install platform (compose, containerized web) → `dev/install/README.md` + site §24. **SDK service /
hosted headless API / gateway** → `dev/install/sdk-service-analysis.md` (measured host facts: SDK server
is stdio-only; profile-dir `settings.yaml` is read by NOTHING on 0.2.x — config must ride
`cordis.patch.yml`; provider routes at `initialize` are the profile's names, never
`deepseek-official`). **Embedding DSH in-process (Hono/Cordis as libraries)** →
`dev/install/sdk-embedding-analysis.md` (no network API ships but `ctx.agents.create/resume` IS the
in-process seam the SDK server itself uses; `boot()` from app-boot is the documented embedder entry;
npm `latest` dist-tags of the bundle packages are STALE — pin every `@deepseek-ai/*` to one exact
version).

**Scope: development only.** This file guides agents developing THIS repository. Nothing shipped —
runtime behavior, the knowledge corpus, or any test — may depend on it or its contents: every real
target project carries its own instruction files, unpredictable and private to that project. The
archive-time screen that enforces this is `src/injections.ts` (host-injected context is marked, never
archived); the test-time rule keeping it out of tape matching is AGENTS-BLIND masking in
`tests/e2e/model-proxy.ts`.

- `docs/contract.md` — DSH API facts: schemastery vs zod vs tool param specs, `defineTool`, `inject`,
  `Config`, packaging, `ctx.llm`, file:line references
- `docs/architecture.md` — how a continuation is created, chapter rendering and the artifact store,
  budgets, ancestry, atomicity, integrity, phases
- `docs/development.md` — the build/test loop that does not restart the harness you are editing from
- `docs/plans-carriage.md` — **read before writing code in that area**: how a session plan
  (`exit_plan_mode`) reaches the chapters, the TOC and the artifact store; the verdict classes; and why
  the token meter is never exempted
- `docs/host-compaction-seam.md` — **read before writing code**: the harness already ships pressure
  compaction, overflow recovery, and a `summarize()` subclass hook. This is our real integration surface and
  it deletes most of what an earlier plan assumed we would build.
- `docs/verify.md` — verification checklist and manual test procedures
- `docs/knowledge-repo.md` — **the governing design record for the shared knowledge layer**
  (git repo, two-layer index, topic-sequential composition, rules, search, sync loop, P1–P3
  phasing). Read before planning or implementing anything in that layer; amendments are human
  decisions, recorded in git.
- `docs/provider.md` — the knowledge-transport seam (Amendment 2026-09-21): the six verbs a
  provider implements, git vs TreeDX truth table, failure classes, state file, and the rules
  every backend must honor

## The Four Invariants

**1. Never rewrite the durable session log.** Append-only, always. Surface-span *shadowing* is permitted —
and is in fact the shipped mechanism (`compaction/*` events are log-only and a replacement `user/message`
carries the summary; `shadowedSeqs` names the hidden nodes). What is forbidden is mutating or deleting
recorded events, and replacing anything in the **header**: that is the cache cost that matters, measured at
~12K tokens on a 32K model.

**2. Never seed a continuation from its parent's events.** DSH's native fork does exactly that —
`commands.ts:260`: `seed: source.events.slice(0, cut)`. A child seeded that way carries all of the
parent's history plus the TOC, so context *grows* every link and nothing is compacted. Ours is
`agents.create({ sessionId, seed: [tocNoticeEvent] })` — one synthetic event at `seq = 0`. This is the
trap in the original design; do not "helpfully" reuse the fork handler's seed step.

  Measured in Phase 0, and it strengthens rather than weakens this rule: `ctx.sessions.fork` does exist
  host-side but is capability-gated — *"session fork is owned by session-controller; ambient plugin access
  is denied"*. So `agents.create` is not a workaround around a missing API; it is the sanctioned seam, and
  the copy-the-log path is closed to plugins by design. The seed contract, verified by rejection messages:
  contiguous from **seq 0** (the kernel's own `permission/preset`/`sandbox/mode`/`approval/policy` events
  are appended *after* the seed, not before it), and the notice must be
  `{ id, role: 'user', source: { kind: 'plugin:dsh-chapters', form: 'snapshot', sections: […] }, content: […] }`
  — producer-owned kind, NO `plugin` field: session format v4 (host 0.2.x) RETIRED the bare
  `kind: 'plugin'` wrapper and refuses it at row admission with "format v4 message requires a
  producer-owned source kind" (measured 2026-10-18 on 0.2.0-rc.2, issue #43, when every
  continuation started refusing). `source` is an object; a string is rejected as `invalid source`. See
  [spikes/probe/FINDINGS.md](spikes/probe/FINDINGS.md).

  **Amendment 2026-10-10, measured before built:** the seed is *one synthetic message* plus, when it
  applies, **one synthetic STATE event** the plugin authors itself — `plan/mode {active:true}` for a
  CONTINUATION whose archived span was still in plan mode (`planSeedMode`). This is still not "seeding
  from the parent's events": nothing is copied from the parent's log, and the kernel's own setup events
  still append after the seed. Probed against the installed `Session` (0.1.5-rc.1) in the production
  header shape: `[notice@0, plan/mode@1]` is accepted, log-only (surface stays `[0]`), and the host's own
  plan projection folds the child to `active: true` — the one-event control does not. Details and the
  refusal cases (never seeded for a branch; never seeded after an approval, because approving EXITS plan
  mode) are in `docs/plans-carriage.md` § 10.

  **A created session composes NOTHING by itself.** Round 10 proved it for the model: no `agentOptions`
  ⇒ every turn dies with `prompt variable "{{model}}" has no value for this assembly`. Phase 0b proved
  the deeper half: **`agents.create` never mounts a preset** — `meta.agentPreset` is a durable label only
  — so a setup-less child is a tool-less agent (r15: first request 974 tokens, `tools: 0`; no `read`,
  so no chapter reload). The sanctioned fix, which session-controller itself uses
  (`api/session-controller/src/agent.ts:377-390`), is
  `setup: async (agentCtx) => ctx.get('agentPresets').mount(agentCtx, presetId)`. So `chapters_continue`
  must pass `agentOptions` (from `ctx.get('agentDefaultModel').currentSelection()`), the caller's preset
  id resolved from the calling agent's own session observation, AND the setup-mount — same shape as
  `dsh-session-fork/src/index.ts:368-381`. A continuation that cannot resolve its model or tools is a
  broken session the user inherits. **Resume is the same trap**: raw `agents.resume` composes nothing
  either; anything resuming a child programmatically must pass `agentOptions` + `setup` too (r22 — the
  web UI path already does, via session-controller; a plugin-driven resume does not).

**3. Never contribute a system-prompt section.** The header is process-global, not per-session, so a
contribution changes what *every* session in the profile sees — which is the opposite of this plugin's
one-continuation-one-notice discipline. `dsh-session-fork/src/prompt.ts` does it; copying that here is a
bug. The TOC notice is how the model learns about chapters: per-continuation and append-only.

  **Caveat, from Phase 0:** the usual *reason* given for this rule — "it invalidates every session's
  cache" — is now doubtful. Real logs show system-prompt sections arriving as **appended** `user/message`
  events, and appending preserves the prefix. So treat the rule as about global versus per-continuation
  scope, not as a proven cache claim, until re-measured. See
  [spikes/probe/FINDINGS.md](spikes/probe/FINDINGS.md).

**4. Never let the model author chapter bodies.** The model supplies `startSeq`/`endSeq`, titles, and
summaries; the plugin renders text from the session log. Model-typed "lossless" archives are
reconstructed from recall, which is the failure mode we are avoiding. It also cannot fit: archiving 100K
tokens would require emitting 100K tokens in one tool call.

## What This Is

Relieve context pressure **without rewriting history**: archive a conversation into Markdown chapters in
a shared store — verbatim text, with oversized tool results deferred to reference files — then open a new
session whose entire content is a cumulative Table of Contents of that archive. The model reloads
chapters with `read`. The original session is untouched.

Say **"every byte remains retrievable"**, not "the chapter contains the full history". The deferral below
makes the second phrasing false, and a TOC preamble that overprompts the model into trusting it is a
real bug, not a wording nit.

**This is not a fork.** Native forking copies history; we create an unseeded session that cites an
archive. The mechanism is a *citation-linked continuation*, and the package name says so — `dsh-chapters`,
tools `chapters_segment` / `chapters_continue`. Why "fork" and "compact" both failed review is in
[docs/architecture.md § Naming](docs/architecture.md#naming).

## The Point — and the Cost

**The win is zero-inference indexing, not cheaper compaction.** Producing a summary requires prefilling the
whole history into one auxiliary call: ~17 minutes for 100K tokens at 100 tok/s, ~55 at 30 tok/s, and it
repeats every time the window fills. Our chapters are written from the log (a file copy) and our index is
generated deterministically — **zero model tokens, zero summarization latency**. Measured: ~102 tokens of
index versus ~2,476 for the equivalent transcript, on a 32K-capped model. The mission is retrievable memory
that lets a small model keep going until the objective is done.

**This is not cheaper than in-place compaction** in the cache sense. The new session pays one cold prefill of system
prompt + TOC + handoff note, the same cost class a post-compaction request pays. What we buy instead:

- **verbatim** archive, so a reload returns real text rather than a paraphrase
- **untouched parent**, keeping its cache and remaining usable as an ancestor
- **reversible** — abandon the child and keep working in the parent
- **branchable** — history can fork, not just truncate

Never market or document this as a prefill saving.

## Data Flow

```
agent turn ──► chapters_segment ──► {archiveCeiling, chapters:[{title, summary, startSeq, endSeq}]}
                                          │ agent reviews/edits ranges (never text)
                                          ▼
              chapters_continue(title, handoffNote, chapters[])
                                          │
        ┌─────────────────────────────────┼──────────────────────────────┐
        ▼                                 ▼                              ▼
 render bodies from log          defer oversized blobs            preflight the budget
 (verbatim, per range)           to content-addressed             TOC + note vs remainder
 artifacts/ files                       │                                 │
        └─────────────► chapter .md files ◄───────────────────────────────┘
                                          │ refuse loudly if over budget
                                          ▼
      agents.create({ seed:[TOC notice], agentOptions, setup: mount(presetId) }) ──► new session
                                          │   (all three or the child is broken — invariant 2)
```

The two things the model never does: produce archived text, and traverse the ancestry graph. Both are
the plugin's job. See [docs/architecture.md](docs/architecture.md).

**The archive moments are exactly seven** (docs/architecture.md § The archive moments): continue, fork,
save, compaction finalize, **subagent settlement** (#47: a host-plane listener on the host's
`subagent/end` event runs the *same* save pipeline for chapters-preset children — save-only, so it
creates no session and engages no mid-step rule; watermark-idempotent across repeated settlements of a
continuable child; chapters land in the child's OWN tree with `subagent`/`parentSession` frontmatter from
the durable header the host stamps — deliberately NOT `linkChild`-ed, because `rootSession` *is* the store
directory and `buildIndex` walks ancestors only, so a link re-homes files for no reach (#58, measured)),
**forced child archive** (#61: a `ch-*` continuation child is `origin: user`, so door 5 does not cover it —
`ch-dc3be3ab` was 2,363 events / 414 tool calls / 2 completed turns with `chapters: []` and
`reservations: {}`: not a failed archive, one **no moment was watching**. A `turn/end` listener archives
through the SAME save core when the session is `agentPreset: chapters`, is ROOTED by any of the three
lineage homes — registry row (`linkChild`, continue-core.ts:520), header, or the `ch-` id prefix
continue-core.ts:501 mints (measured: the field case's header had NO `parentSession`), and
`origin !== 'subagent'` — and the row never archived or the lag passed `childAutoArchiveMinTurns`.
Save-only; thresholds are config), and **operator repair** (#60: `/chapters-repair` re-derives a span from
the durable log through the SAME save core, supersedes the bad chapter under a new number, and edits no
chapter body and no log byte).
**Settlement has two arms and they are not symmetric** (#58): a *one-shot* child is still live when
`end` fires, so the synchronous `snapshotEvents()` read works; a *continuable* child is disposed
**first**, so the durable arm is the only arm — and it must be a payload-bearing read
(`sessionQuery.readSession`), never `listEvents`, whose records have no `data` and produce a structurally
valid, semantically **empty** chapter. No door commits an archive that rendered nothing:
`stats.messages === 0` over `stats.events > 0` is a `payloadless` refusal **before any number is
reserved** — a committed husk poisons the watermark (`max(endSeq)`) so the child can never be re-archived
without repair. Knowledge that trips none of the seven never enters the index — when adding another door,
extend the list, never copy the pipeline.

## Continuation Budget, Not a Handoff Cap

There is **no cap on the handoff note.** The real invariant is a ceiling on the *newly added* context of a
continuation, expressed as a share of the space **left over after the header**:

```
tocTokens + handoffNoteTokens ≤ continuationBudgetRatio × (window − systemPromptTokens)
```

Measured **before** creating the session. Over budget → **refuse with the numbers**; never silently
truncate. A dropped or clipped handoff note is precisely the lossy behaviour this plugin rejects. A model
that dumps a whole conversation into the note is caught by this same check, so no separate cap is needed.

**Do not re-express this as a fraction of the whole window.** A 32K model with a ~9K system prompt and
tool schemas would have an 8K total budget, making *every* continuation unmeetable — the plugin would
refuse to function on exactly the small-context hardware it exists for. The header is a fixed cost, not a
competitor for the index.

This reserve margin is the same machinery automatic triggering needs, which is why pressure detection
moves **earlier** in the plan rather than later. See [docs/architecture.md § Phases](docs/architecture.md#phases).

## Oversized Tool Results

Long dumps (`read` on a big file, `bash` output) are the bulk of most conversations and rarely the part
worth re-reading. So they leave the chapter body — but **the model decides which ones, not a size rule**,
because "this diff matters, this npm log does not" is a semantic judgement only the agent holding the
conversation can make.

The split of responsibility:

- **Plugin computes** the facts: it has the log, so it knows every tool result's size and can enumerate
  candidates. The model never guesses at byte counts.
- **Default is defer.** Results above a fallback size go to `artifacts/` and are referenced, not inlined.
  Small glue stays inline so the narrative reads naturally.
- **The model submits only exceptions** — `toolResultOverrides: [{seq, inline: true}]` for a large result
  that genuinely matters, or `inline: false` to trim a small one. Sparse by construction, so the judgment
  costs almost no output tokens.
- **Invocations and arguments are always inline.** That is a plugin rule, not a model choice; it is the
  "what was attempted" half of the record.
- **The artifact is written either way.** Inlining is a convenience copy alongside its reference, so a bad
  keep/drop call is a context-economy miss, never a data loss. That is what makes handing this judgment to
  the model safe.

```
**Assistant:** Reading the runner to trace the migration order.
  ↳ tool: bash `npm run migrate -- --dry-run`
    result: 41.2 KB, sha256 8f3a1c… → .dsh-chapters/artifacts/8f/8f3a1c….txt   (store root: shared & content-addressed)
```

Content-addressed, so identical results across the whole subtree are stored once. The guarantee becomes
*every byte remains retrievable*, not "every byte is in the chapter" — honest, and a better fit for the 8K
chapter target. Attachments and images take the same reference path, since Markdown cannot carry them.

Full rules in [docs/architecture.md § Chapter Rendering and the Artifact Store](docs/architecture.md#chapter-rendering-and-the-artifact-store).

## Ancestry: A DAG We Flatten For The Model

Branching an ancestor twice makes the history a tree, and asking an agent to traverse a tree is how
agents get lost. So the model never traverses:

- **The plugin walks the ancestor path and emits a flat, chronological, numbered list.** Reading order
  *is* causal order. No graph-walking required, at any depth or in any branch.
- **Explicit back-links are printed** — root session, parent session — so the trace is visible without
  being inferred.
- **The TOC is the only index.** It lists every chapter on the ancestor path, with summaries, in one flat
  numbered block. There is deliberately **no separate `MANIFEST.md`**: the chapter list is already in the
  TOC and the registry already holds the machine-readable version, so a third index would be a regenerated
  duplicate that can drift — and, being read whole, its own growth would reintroduce the context cost this
  plugin removes. Cross-branch (sibling) browsing is a possible future read-only command, not a per-fork
  artifact.
- Chapters are keyed by **creating session**, not a linear chain id, so siblings cannot collide.

Details in [docs/architecture.md § Ancestry](docs/architecture.md#ancestry-a-dag-we-flatten-for-the-model).

## Storage

| What | Where | Why |
|---|---|---|
| Chapter bodies + artifacts | workspace (`<store-root>/<root>/…`) | the `read` tool must reach them; `$HOME` may be unreachable while still writable |
| Ancestry, numbering, hashes, bullet lists | storage domain `ctx.storageDomain` | sanctioned durability, survives restart, atomic-ish allocation |

`ctx.fs` is **optional** — absence must be a clean refusal, never a crash. Chapter files are
**Markdown with YAML frontmatter**, not XML: structure that machines need lives in frontmatter, the
session log, and the registry; the readable surface stays token-dense. See
[docs/contract.md](docs/contract.md) and [docs/architecture.md § Storage](docs/architecture.md#storage).

**"Survives restart" is not "survives the workspace".** The store root is gitignored *inside a
re-clonable directory*, so deleting or re-cloning a project destroys chapter bodies, artifacts, rules
and the local pool mirror in one motion — and a host reinstall can hand back a fresh registry
(`ctx.storageDomain` is per-home) in the same stroke, leaving every TOC citation pointing at nothing.
Measured 2026-10-11 on this exact pair of causes: 29 of 40 surviving session logs cited
`.dsh-chapters/` paths that no longer existed anywhere on the filesystem. What survives is the durable
log (invariant 1 — the reason re-rendering the archive is possible at all) and, if the project was ever
linked, the pool: `rehydrateStoreFromMirror` (`src/sync.ts:476`) copies **absent** files back only and
counts them into the sync steps, because rehydration fills gaps and never arbitrates drift. So the
correct description of such an event is "the archive was lost and rebuilt", never "the sessions were
corrupted" — and a store with no pool remote and no logs is unrecoverable, which is a backup question,
not a plugin bug.

## Hard Rules

- **Never renumber, rewrite, or copy a chapter, and never add a second index.** The store is append-only
  with no exceptions. Damage is therefore **superseded, not repaired in place** (#60): a new number with
  `repairs: <n>`, the old record marked `status: 'superseded'` and excluded from TOC/index/enrichment, the
  bad file **copied** (never moved-away-from-truth or deleted) into `.repair-quarantine/`, and the whole run
  journalled so it is reversible. A dead citation is made true by writing the file it names, not by editing
  the text that names it.
- **Stored paths are workspace-relative, and comparisons are never `===`.** `ChapterRecord.path` is one
  dialect: minted through `toStoredPath(cwd, p)` and compared through `sameStoredPath(a, b, cwd)` (#69).
  Absolute from one door and relative-from-disk looked like two files, so the auditor reported a chapter
  as its own unregistered twin and offered to re-register knowledge it had just written. An absolute path
  outside the workspace stays absolute — a per-port absolute `artifactStoreRoot` is supported config.
- **Never reorganize chapters mid-session.** Continuation boundaries only.
- **Never trust agent-supplied ranges.** Validate ascending, non-overlapping, coverage ≤ archive
  ceiling, **and contiguous** — `validateRanges` refuses a gap, not only an overlap. An overlap
  duplicates archived text; a gap silently drops it. The same bidirectional guard binds the
  deterministic composer: nothing unfinished is archived, and **nothing finished is dropped**
  (docs/knowledge-repo.md §4.3 amendment 2026-10-22 — a completed turn that lost its signature
  vanished from the archive with a note claiming it was unfinished).
- **Never commit an archive that rendered nothing.** A chapter whose `stats.events > 0` but
  `stats.messages === 0` is a **payload read that went wrong**, not a short conversation — a tool call
  always follows an assistant message. Every door refuses it, before reserving a number, and says so with
  numbers. The reason is permanent: the watermark is `max(chapter.endSeq) + 1`, so a committed husk blocks
  that child from ever being re-archived. (#58: this exact pair — a hollow chapter plus a poisoned
  watermark — turned 12 recoverable archives into permanent ones, and the renderer already *knew*:
  `writeArchive` warns "N event(s) rendered no output" and door 5 discarded the warning.)
- **Mutate the registry row through `store.mutate(sessionId, fn)`, never a snapshot.** The row is one whole
  value and five doors plus the turn/end listener write it; the wide sites hold a read across a model call or
  hundreds of fs writes. A stale `put` does not merely lose its own work — it **erases other doors' committed
  state**, invisibly (files on disk, records gone). Measured in the field: an enrichment put at 04:53:52.841
  rewound a compaction commit from 04:53:50.915, deleting its manifest, reservation, `finalized` entry and
  chapter record while its 960 KB file survived, and re-spent chapter number 15 (two `015-*.md` in one tree).
  Related identities in the same family: a chapter's identity is `(number, sha256)` — never `number` alone,
  which is what made that collision look like a retry; a reservation whose files never landed is released,
  not burned; one poison item in the finalize queue may not block the rest. See
  docs/architecture.md § The row is shared.

- **Measure a host verb's payload SHAPE, not its presence.** `listEvents` exists, is ambient-readable
  after disposal, and returned 10 correctly-typed events — and had **no `data`** field, because it
  returns `SessionEventRecord` metadata, not events. The spike recorded `{count, types}`, wrote "returned
  the full durable log", and door 5 was built on it. So: assert the *fields you read* in a drift row that
  reads the kernel's own published types; never widen an input type's optionality to make a lie compile
  (`SessionEventLike.data` is **required** now, which is what should have failed first); and when a test
  stubs a host verb, stub it the host's shape, not yours. The same trap has a precedent in this repo —
  `spikes/probe/FINDINGS.md` r28: "the L0 test had stubbed the fictional shape and passed a dead
  listener".
- **Never truncate to fit.** Refuse with measured numbers instead.
- **A detected failure is a delivered failure** (#61). If code already knows — a warning string, a
  counted oversize chapter, a diagnostic it built and dropped — it must reach a human or a file. The
  diagnostics sink defaults ON (`<store-root>/diagnostics.log`; `off` is the only silence), `/chapters-status`
  prints its whole block in every state including unlinked, doors print warning TEXT with a withheld
  count instead of a bare number, and a tool caps and names its own output rather than emitting 50 KB
  into a 32K window. Every P0 in #58/#59/#60 was detected first and thrown away; adding more checks
  without delivery is the same bug.
- **One predicate per semantic decision.** The body screen (`injections.ts`) and the title chooser must
  not hold two lists of what counts as injected context — the second one lagged and a
  `time-context` snapshot became a chapter title, slug, filename and TOC citation (#59). Same rule
  already holds for the save core, `renderRulesBlock`, `search.rankEntries` and `deterministicCommand`,
  and a source-shape row now fails if a second title predicate reappears.
- **Never create a session automatically mid-step.** Continuation-creating actions fire at `turn/end`
  boundaries only. (In-place *surface* compaction is different and is the harness's own design: the base
  engine compacts at `agent/pre-step` — between steps, never mid-request, bounded retries — measured
  r13/r17 and durable-correct there. Do not add a second automatic engine timing of our own.)
- **Schemastery for `Config`** (default import, `Schema<Config>`); **plain specs** for tool
  `parameters`; **zod** for domain records. Three systems, never mixed.
- **Always give a tool an `output` schema** — mandatory on every `ToolDefinition`.
- **Call `next()` in waterfall listeners** unless deliberately short-circuiting, and document why.
- **No hardcoded tunables.** If `cordis.yml` can change it, it belongs in config.
- **Back up a file before a throwaway mutation, then restore from that copy.** Proving a row
  fails on its mutation is standard practice here, but `git checkout <file>` / `git restore <file>`
  reverts to HEAD and DESTROYS every uncommitted change in it. Measured against myself 2026-10-20:
  twice in one session, each costing a full re-application of ~14 edits to `src/rules.ts`. `cp f f.bak`
  first; restore from `f.bak`. Never reach for `git` to undo a mutation you made by hand.
- **Commit, PR, and issue bodies go through a FILE (`git commit -F`, `gh ... --body-file`), never a quoted argument.** Measured four times on one branch (2026-10-22/23): backticks inside a double-quoted `-m "…"` are command substitutions, so the shell RAN the quoted identifiers and deleted them from the message — shipping text like "enforces: , its profile patch, and the installed  tree". Nothing failed; the record was just quietly wrong, which is the class of bug this repo exists to end. Single-quoted `-m '…'` is safe; `--body "…"` is not.
- **Never repeat an identical tool call after its result is known.** A finished search, read, or probe
  with the same arguments returns the same bytes; re-running it adds nothing and buries the answer.
  When a question stalls, change something real: different arguments, a different tool, or state what is
  established and act on it. Measured against myself 2026-10-17: dozens of byte-identical greps during one
  debug loop, each justified as "one more check" — the fact that would have ended it (`api/health` 404s even
  authenticated on host 0.2.x) was already proven several rounds earlier. If you catch a near-verbatim
  repeat in your own history, STOP the loop and proceed from what is already measured.

## Where we are — state lives in docs, not here

**Shipped and CI-green on the real model:** the engine, tools, preset, all seven archive moments, the
knowledge layer (P1–P3c), the repair engine (#60), the prompt-ghost surface (#71). **Still unverified:
the browser plane** — the tape corpus is not re-anchored to the pinned host, so replay refuses by name
and no e2e claim is current (issues #56/#57). Do not quote an e2e result as fresh until that lands.

Full chronology, measurements and which round proved what: **`docs/project-state.md`**.
Next things to pick up: **`docs/backlog.md`**. Verification checklist: **`docs/verify.md`**.

## Rig and metering rules (measured; these are load-bearing)

- **The dev home is SHARED with live agents — it must never be the test ledger.** e2e boots run against
  port-keyed throwaway homes `var/e2e-home-<port>`; a run pointed at the shared home asserts against an
  agent transcript. (Since #61 each boot also pins `artifactStoreRoot` per port, so the rig no longer
  writes chapters into the project's own store root — and CI asserts it, see `docs/development.md`.)
- **One journey, one boot.** Sharing a boot makes a later spec restore an earlier spec's child session and
  the failure looks like the product. Also: re-record WHOLE projects, never one spec of a shared boot, and
  never run two GPU suites at once.
- **A token meter is never exempted**, and never cross the numbers: a modest `chapterTokenTarget` warn is
  config, an unmeasured cache number from one machine is nothing on another (llama.cpp and the cloud
  provider disagree by design — `docs/project-state.md` § Cache).
- **Re-record when PRODUCT prompt bytes change** (persona, tool descriptions, thresholds) — but NOT for a
  doc edit: the AGENTS-BLIND masking in `tests/e2e/model-proxy.ts` keeps workspace docs out of tape
  matching, so editing this file or any doc must never couple a tape to this repo. If a prompt byte is
  unchanged, the tape is unchanged.
- **The arrival floor is a behavior switch, not a knob**: a `toolResultDeferFloorTokens` below the chunk
  size arrival-stubs the surface and silently makes compaction unnecessary — a "passing" heavy test then
  proves nothing. Artifacts are never indexed (they answer to `chapters_artifact`; a second index is
  forbidden).
- **Proving a failure predates your diff is a step, not an answer.** Two flaky rows were blamed on the
  environment and diagnosed as pre-existing; pre-existing was true and irrelevant — the flake was real
  (an unhandled async EPIPE). Reproduce, then fix.
- **Node ≥ 24 runs the deterministic suites** (`engines`); on an older node EVERY test file fails in a way
  that looks like your change. Check `node --version` before believing a red suite.


## Workflow Gate (MANDATORY)

**At the START of every new project or statement of work:** load the `release-workflow` skill,
create or adopt a GitHub Issue, and create a feature branch from the latest `staging`. Never begin
work without an issue and a branch. Never work directly on `staging` or `main`.

**Before COMPLETING any project:** reload the `release-workflow` skill to verify branch naming,
commit messages, PR template, and cross-linking are correct before opening the PR. Agents may merge
PRs to `staging` after acceptance tests pass. Agents may NOT approve or merge to `main`.

This gate is non-negotiable. If you find uncommitted work on the wrong branch, stop and fix it now.

## Documentation-First Development Cycle (MANDATORY)

Every change follows this cycle, **in this order**:

```
Plan/Issue → Documentation → Tests → Implementation → Release
```

1. **Documentation FIRST.** Write or update docs BEFORE writing any code. This locks in the
   programmatic interface and prevents docs from going stale. Update all affected pages (site
   docs, repo docs, README, skills, AGENTS.md). Commit the docs.
2. **Tests outside-in.** Acceptance/smoke → regression → integration → unit. The interface must
   be stable before internals are built.
3. **Implementation.** Write code that makes the tests pass. Commit incrementally with issue refs.
4. **Release.** PR → CI green → merge to staging.

Why: docs written after code describe what was built, not what should be built. Tests written
after code verify the implementation, not the specification. This cycle forces spec-driven
development. See the `release-workflow` skill for full details.

## Efficiency Rules

1. Do not read all four `examples/` repos. Read the one file that answers the current question
   (`docs/architecture.md § References` has the table).
2. Do not reach for `ctx.sessions.fork`, host-side or otherwise. It exists on `ctx.sessions` but is
   capability-gated ("owned by session-controller; ambient plugin access is denied"), and its handler
   copies the parent's log anyway. `agents.create` with a seed is the only sanctioned path. Measure the
   contract from `spikes/probe/FINDINGS.md` rather than re-deriving it from greps.
3. Prefer `deepseek-harness` over any community plugin when they disagree.
4. Re-check the pinned kernel references after any DSH upgrade — this design leans on host internals. The
   live anchors are `docs/contract.md` (file:line facts) and the drift gates:
   `tests/unit/host-seed-contract.test.ts` (seed contract) and
   `tests/unit/preset-declaration.test.ts` (preset delivery + config keys + prompt variables).
   (`vendor/fork.ts` named here before no longer exists in this repo — never tracked; that pointer was
   itself the drift this rule warns about.)
5. Build before installing (`tsc -p tsconfig.json`), and remember a restart recomposes every session's
   header, so cache measurements only mean something within one process generation.
6. Attempt the solution yourself first. Run the build, the test, the command — do not describe what
   *should* happen and wait for confirmation. Iterate on failures until you hit a genuine blocker
   (missing credentials, hardware unavailable, a decision that requires human judgment, or a system
   error beyond your control). The user learns what the limits are by watching you push against them;
   stopping early to ask "should I try?" wastes everyone's time. Report completion, blockers, or
   errors — not plans to attempt.
