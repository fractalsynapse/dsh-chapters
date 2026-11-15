# Architecture and Design Decisions

Decisions with their reasoning, so they can be revisited knowingly rather than rediscovered.
API mechanics and file:line citations live in `docs/contract.md`; this file is the *why*.

## Naming

**Decided: `dsh-chapters`** — package `dsh-chapters`, tools `chapters_segment` and `chapters_continue`,
storage domain `dsh_chapters`, store root `.dsh-chapters/`. Recorded with its reasoning because the
reasoning constrains future renames, not because the question is open.

Why the two most available-sounding words were rejected: DSH's "fork" means *copy the parent's history
into the child*, which is the one thing this plugin must not do. And "compact"/"summarize" implies the
lossy in-place editing this replaces.

| Candidate | Tools | Why taken or left |
|---|---|---|
| **`dsh-chapters`** ✓ | `chapters_segment`, `chapters_continue` | Names the durable artifact, makes no mechanism claim, greppable, and `continue` is exactly what happens: the conversation continues in a new session. Short enough for a plugin list. |
| `dsh-chapter-continue` | `segment_chapters`, `continue_with_chapters` | Verb-forward and self-describing to a model scanning a tool list; clunkier as a package. |
| `dsh-tome` | `tome_index`, `tome_continue` | Memorable and literally apt — a tome is a volume of chapters with a table of contents, which *is* the mechanic. But opaque to anyone who hasn't read the README. |

Also rejected: `dsh-archive` (sounds read-only, and the plugin's job is to keep working).

**One leftover: the repository directory.** The checkout is still `~/Projects/dsh-chapter-fork`. The
folder name is cosmetic — installs use `link:$(pwd)`, and the bundle id comes from `package.json` and
`cordis.patch.yml`, both of which say `dsh-chapters`. Rename it out-of-band with `mv` rather than from
inside a session whose working directory *is* that folder, which would strand the tree. Keeping the
identifiers in sync is what actually matters, and they are in sync.

## File Format: Markdown with Frontmatter, Not XML

Asked and answered: chapters stay **Markdown**, with structure in YAML frontmatter.

The reasoning against XML, strongest first:

1. **The consumer is a model reading text, not a parser.** Every markup token is a context token, in a
   plugin whose entire purpose is bounding context. `<turn role="assistant" seq="184">` costs several
   times what `**Assistant:**` does, repeated across a whole chapter.
2. **Structure already has two better homes.** The session log *is* the lossless machine-readable
   record, keyed by seq, and the registry stores ranges and hashes. Duplicating turn structure into the
   readable artifact creates a third source of truth that can silently drift from the other two.
3. **`.md` gets rendered; `.xml` gets downloaded.** The harness's own markdown component renders `.md`
   inline in the web UI, and the `read` tool, editors, and git diffs are all Markdown-shaped. XML files
   become write-only artifacts nobody looks at.
4. **Markdown is the established convention for exactly this shape.** DSH's skill loader parses
   YAML-frontmatter-plus-Markdown-body files — the same idiom, already understood by the tooling.

What we *do* take from the XML instinct, because it was a real concern:

- **Frontmatter carries the parseable structure** — `chapter`, `session`, `root`, `seqRange`, `sha256`,
  `tokens`, `artifacts`. Queryable with a YAML parser, invisible to the reading experience.
  Chapters authored by a **subagent** carry two more lines — `subagent: true` and
  `parentSession: <id>` — copied from the child's durable session header, which the host itself
  stamps (`childSessionMeta`: `parentSession`, `origin: subagent`, `delegationDepth`, `agentPreset`;
  measured, `spikes/subagent-end/FINDINGS.md`). Emitted ONLY when the header has `parentSession`,
  so existing chapter bytes never change — which is also why no tape needs re-recording.
- **There is one index, not three.** The TOC lists the chapters for reading; the storage domain already
  holds the machine-readable enumeration. A separate `MANIFEST.md` was proposed and **rejected as
  redundant** — a regenerated duplicate that can drift, whose growth becomes a context cost when read
  whole, and the sole exception to append-only. Dropping it removes all three problems at once.
- **Fence collision is a renderer bug, not a format problem.** Conversation text containing ```` ``` ````
  must be escaped by choosing a longer fence per block. This is the actual failure mode an XML format
  would have prevented, and it is solved in ~10 lines of the renderer. Get it wrong and chapters
  silently truncate at an embedded fence.

**The one case that would reopen this:** if a future feature needs to *rewrite* chapter structure
programmatically — re-segmenting an existing chapter by turn boundaries without a session log — then a
losslessly round-trippable format earns its tokens. Rendering is currently one-way from log to file, so
it doesn't. Revisit if chapter *editing* ever enters scope.

## Chapter Rendering and the Artifact Store

The model supplies ranges; the plugin renders. Within a range:

| Event content | Handling |
|---|---|
| user / assistant text | inline, verbatim, attributed |
| tool **invocation** (name + arguments) | inline as a bounded head (400 chars) — the "what was attempted" half of the record; above `callArgArtifactTokens` the full arguments are **artifact-backed** like any deferred blob (0 = off by default) |
| session **plan** (`exit_plan_mode` call + its verdict result) | full text always artifact-backed + a labeled `## Plans in this chapter` block after the transcript (docs/plans-carriage.md) |
| tool **result** judged **not worth keeping** | deferred to `artifacts/`, replaced by a reference line |
| tool **result** judged worth keeping, ≤ floor | inline, verbatim, no model input needed |
| tool **result** judged worth keeping, > floor | inline by model override **and** still written to `artifacts/` |
| images / attachments | deferred to `artifacts/` by path (Markdown cannot carry them) |
| surface ops, projections, lifecycle events | omitted from the body; their seq ranges are recorded in frontmatter |

### Who decides: the model, not a threshold

The keep/defer call is **semantic**, so it belongs to the agent that lived the conversation. "This diff
matters; this npm install log does not" is not inferable from size — a 4-line compiler error is load-bearing
and a 400-line `read` of a config file may be pure noise. A size threshold gets this backwards exactly often
enough to matter. *(Amended 2026-09-19 below: one band — results too large to ever be reasoning context —
is artifacted at arrival without judgment; this section's rule governs everything that can genuinely fit.)*

Division of labour:

- **Plugin enumerates.** It has the log, so `chapters_segment` returns, per chapter, the candidate tool
  results with `seq`, tool name, and size. The model never guesses at byte counts.
- **Default is defer** for anything above `toolResultDeferFloorTokens`; trivial results stay inline without
  being itemized, so the narrative reads naturally and the exception list stays short.
- **A zero-length tool result defers nothing** (#59). `arrival.ts` has always skipped the empty string;
  the renderer did not, so every hollow chapter wrote references to `sha256("")` and reported
  `artifacts: 102` while holding one 0-byte file. An empty result renders `result (seq N, empty)` with
  no `ArtifactRef` at all. `artifacts:` now means **distinct blobs** and `artifactRefs:` the total
  references — the two were conflated, which made both the field diagnostic and the registry bloat
  (90.6 % of chapter-record bytes here were duplicate references) unreadable.
- **Over-target is a warning; far over-target is a refusal** (#59). `chapterTokenTarget` stays the soft
  target (split at the next boundary, never clip). Past `chapterTokenTarget × chapterOversizeFactor`
  a range is refused with its own number, on every door including compaction: the field produced an
  89,982-token chapter, an unrepaired 237,870-token orphan, and eleven chapters over 32K — against a
  8K target and 32K-class hardware. A chapter that cannot be re-read is not an archive.
- **Subdivide before refusing, by size — and report a refusal as one** (#344). That refusal was being
  reached by default in the deterministic doors, because `deriveRanges`/`composeChapters` emit one chapter
  per **turn** and real opening turns are large. Measured with the shipped functions on three real logs:
  eadc refused **2 of 3** turns, platfolio 55 of 153, arcnexus 32 of 308 — and in every log the refused
  range was the session's **opening** turn, the one a later continuation most needs. So `/chapters-save`,
  `/chapters-fork`, subagent settlement and forced-child archive could not archive real sessions; only
  model-driven `chapters_continue` could. Worse, the tool had no `oversize` case, so the run on eadc
  printed **"Saved: 0 chapter(s) archived … Enrichment queued."** — a success line for a refusal.

  1. `splitOversize` now runs on **every** deterministic door (it sat inside the repair-only
     `a.span !== undefined` arm) and packs greedily against `chapterTokenTarget`, cutting only **between
     events**. Equal-*count* chunking — the previous form — left 42 of 121 eadc parts over the ceiling on
     real, unevenly-sized turns while its own note claimed a split had happened. Same three logs after:
     **0 refused** (275 / 3,248 / 3,081 parts). Packing targets the *target*, not the refusal *ceiling*,
     because the splitter measures an event-payload proxy while the gate measures **rendered** markdown and
     the proxy runs low.
  2. The door branches on `skipped !== null && records.length === 0` rather than on an enumerated list of
     reasons — `oversize` and `payloadless` had both fallen through to the success wording, and a per-case
     list is how that recurs. The message names the size, both knobs, whether a chapter number was spent,
     and the alternative that can still work (`chapters_continue`).

  One row in `title-predicate-and-floors.test.ts` changed, and it is a **contract change, not a test fix**:
  its fixture is a single ~120 KB assistant event that no boundary choice can reduce. #117's escape valve
  already decided an indivisible single event is archived whole with a loud warning rather than refused,
  because refusing an atom makes a long session permanently un-compactable (measured there:
  `chapters_continue` refused four times over one 77,903-token event). Before #344 the deterministic doors
  never reached that valve — equal-count splitting kept the giant inside a multi-event chapter, so it
  errored. Now they reach it: the chapter is archived, with a warning naming the size, the knobs and how to
  reload it in slices. The property the old row guarded — an un-readable chapter must not pass silently —
  is carried by the warning instead of by losing the session's whole opening turn.
- **A title is chosen by the same predicate that screens bodies** (#59). Bodies use `injections.ts`
  (`source.kind`); title derivation sees provider messages with no source, so it carried its own
  regex — which drifted behind the host and let an injected `time-context` snapshot become a chapter
  **title, slug and filename** (`020-time-sampled-while-preparing-turn-11-step-24-202.md`, cited in a
  live checkpoint). `isInjectedProse` is now the one predicate, fed by the same list of injected
  shapes; a row pins that both callers use it and that the regex file is gone.

- **The injection screen is chosen by provenance, not applied uniformly** (#347). Screening removes host
  spans of two different kinds, and one regex was doing both. For a host-**injected** event an
  unterminated `<system-reminder>` genuinely means "injected prose to the end of the field", so the
  open-ended arm is right. For text a **human typed**, the same arm silently deletes their own words from
  the first tag quote to the end of the message. Measured on the real event (session `17f7c1d6`, seq 8,
  kept as `tests/fixtures/reminder-tail-seq8.json`): 5,061 characters, one opening tag, no closing tag —
  a person quoting the marker while listing injected strings for an agent to search for. The archive kept
  2,543 characters, discarded the last **2,518**, and labelled the loss
  *"omitted:host-injected … project state, not conversation"* — a human instruction reported as host
  state, contradicting this module's own header ("a human typing the words AGENTS.md in prose is
  conversation and stays verbatim").
  So human-authored text is screened **balanced-only**: a span counts when the host closed it, and a
  quoted marker plus everything after it stays. The decision lives in `screenConversation`, the single
  shared site that already holds the event's `data` — the archive (`render.ts`) and the director's tail
  (`prompt.ts`) both route through it, so no caller can forget a flag. That is #59's rule again: one
  predicate per semantic decision, chosen where the fact is known rather than passed around.
  Not widened to assistant text: a model's own words are verbatim for a different reason, and a runtime
  snapshot has been observed appended under `role: user|system` — the existing behaviour there is left
  alone and scoped deliberately.

- **Model submits exceptions only**: `toolResultOverrides: [{seq, inline}]`. Usually empty or one entry, so
  the judgment costs almost no output tokens — which is why this is affordable where "the model writes the
  chapter bodies" was not.
- **Invocations stay inline as a bounded head.** Plugin rule, not a choice; it is the "what was
  attempted" half of the record and the thing a successor most needs. The head is 400 characters, so
  a large argument (`write` carrying a whole file, a plan carrying a whole design) is *also* written to
  `artifacts/` whenever `callArgArtifactTokens` is above zero — the inline text is then a head with a
  resolution, never the only copy. Session plans get this treatment unconditionally and by name: the
  plan's own bytes are always an artifact, cited with its outline and verdict
  (docs/plans-carriage.md § 2/§ 3).
- **The artifact is written either way.** Inlining is a convenience copy *alongside* its reference. So a
  wrong call is a context-economy miss, never data loss — that asymmetry is what makes delegating this
  judgment to the model safe.

The floor is a formatting device, not the policy, and its value is a Phase 1 calibration guess. Oversized
output is caught by the continuation budget and the chapter split signal, both of which **report or refuse
rather than clip**.

Reference line format — stable, greppable, and `read`-able:

```
↳ tool: bash `npm run migrate -- --dry-run`
  result: 41.2 KB, sha256 8f3a1c… → .dsh-chapters/<root>/artifacts/8f/8f3a1c9d….txt
```

Artifacts are **content-addressed** at `artifacts/<first-2-hex>/<sha256>.txt`, which means identical
results across an entire subtree — the same 200-line file read ten times — are stored once. That
deduplication is a large part of why this design stays cheap over long chains.

### This changes the losslessness claim, and the claim must change with it

Chapters are no longer self-contained. The honest formulation is:

> **Every byte of the conversation remains retrievable** — inline in its chapter, or by an exact path
> from it. Nothing is paraphrased, summarized, or dropped.

Do **not** write "the chapter contains the full history" in a TOC preamble or a README. The distinction
matters operationally too: following a reference costs the model a turn and real tokens, so the default
rendering must keep the 99% case (who said what, and what was attempted) inline. That is precisely the
trade the user's judgment called for: long dumps are the least valuable thing to re-read, and the most
expensive to carry.

If a chapter still exceeds `chapterTokenTarget` after deferral, that is the *split* signal — not a
license to truncate. Truncation is refused by invariant 4 and by "never truncate to fit."

### Amendment (user-directed, 2026-09-19, APPROVED, **landed**): arrival-time artifacting for the impossible band

> Shipped with phases 2-4 of the artifacting plan: `src/arrival.ts` writes the stub, `chapters_artifact`
> is in `src/tools.ts`. Verified by unit rows plus browser journey **E7** in
> [verify.md](verify.md) — one `read` of a 373 KB book yields exactly one arrival stub at the tail, zero
> compaction events at the production 0.9 threshold, the blob fingerprint absent from every `request/*`
> event, and `cacheReadTokens` monotonic across the turn (the prefix was never rewritten).

The section above lets the model decide what to defer **at archive time** — a judgment about material
that fit in the window to begin with. This amendment carves off the band where there is no judgment to
make: a tool result above a hard threshold (config key `toolResultArtifactTokens`, default 8000,
floored at 256) **never enters the surface at all**. A 300-page book does not fit a 32K desk; loading it
to "see what happens" is not deference to the model's semantics, it is an emergency waiting to happen.

Mechanics:

- The result is written to the artifact store (content-addressed, same path scheme as archival
  deferral — dedup applies) and the surface receives a **reference stub** instead: tool, size, sha,
  path, plus the query instruction below. A few hundred tokens, appended at the tail — prefix cache
  untouched. (This is distinct from the pruner's mid-history rewrite, whose re-prefill cliff on
  llama.cpp we measured r28; arrival-time interception never rewrites the past.)
- A new read-only tool, **`chapters_artifact`**, queries artifacts *inside* their file: `search`
  (terms/regex → matching blocks with line numbers, bounded by a maxTokens pack), `read`
  (offset/limit — the model can still pull an exact section when its judgment says so), and `toc`
  (for structured documents: markdown headings parsed to a line-numbered contents list — a 300-page
  paper arrives with its own table of contents in hand).
- Consequence on the failure inventory: the **retention paradox** (a newest node too large to file,
  too new to keep ⇒ bounded refusal) becomes structurally unreachable for tool results — the monster
  is never on the desk to be caught in retention. This is the "handle all abortions" directive
  realized at the gate rather than at the rescue.
- External validation: this is the Recursive Language Model result (Zhang, Kraska & Khattab,
  arXiv:2512.24601) — arbitrarily long material as *external environment* the agent inspects
  programmatically. Their mechanism is a Python REPL over the prompt; ours is a file + query tool
  + parsed TOC, which delivers the same decomposition without code execution or a sandbox. Their
  reported compaction-baseline gap (median 26%) is the quality argument; the SRLM follow-up
  (arXiv:2603.15653) supplies the policy guard: recursion that splits what already fits **hurts** —
  hence the hard band boundary, not a general split-everything stance, and bounded pulls remain the
  model's choice.

The archive-time model-judgment machinery above is unchanged for results below the floor.

**Verification (2026-09-19):** `tests/e2e/artifact-arrival.spec.ts` (green 9.3m and
4.1m runs) — a 373,861-byte book fetched in one read produced exactly the arrival
prune+stub pair, ZERO blob occurrences in any `request/*` event (never prefilled),
5–15 `chapters_artifact` calls recovering facts from inside it, and a cache table
(FINDINGS) showing `cacheReadTokens` monotone across the stub boundary — the tail
rewrite costs the prefix nothing, unlike the pruner's mid-history cliff. Row config
`toolResultArtifactTokens` is pinned per e2e project (500 for arrival, default
8000 elsewhere).

### Amendment (#334, 2026-11-14): a shadowed result's PAYLOAD is what a chapter archives

Arrival-time artifacting has a consumer the design did not account for: **the renderer**. A
shadowing replacement appends a second `tool/result` for the same callId whose text is the stub, and
the chapter renderer's copy rule — "keep the LAST result per callId", written 2026-09-29 against a
host redelivery where the two copies were byte-identical — therefore kept the stub. On current bytes
that premise never fires: measured across three production sessions, 44 callIds carry more than one
result, **0 are identical, and 44 are this exact shadow shape**. The chapter recorded the pointer,
discarded 932,462 characters of payload, named the dropped seq nowhere (not even in
`unrenderedSeqs`), and still counted it in `events:`.

The rule is now stated by **size, over the whole log**, in one predicate
(`resultRenderPlan`, `src/log-shape.ts`), consumed by both the chapter body and `chapters_segment`'s
candidate list:

- **largest copy wins**, ties break to the newest — so a true redelivery keeps the behaviour #61
  documented, and a ~500-byte stub can never out-weigh what it replaced;
- **decided over the full log, not the range.** The old range-local choice made the archived bytes a
  function of where the model put a chapter edge (span the pair → stub; stop before it → payload),
  which is what invariant 4 forbids;
- a chapter containing **only** a stub renders the original's bytes at that position, accepting the
  duplicate across two chapters. Duplication is bounded, visible, and stored once (the artifact store
  is content-addressed); silent loss is none of those;
- the substitution is **written into the chapter** (`seq N is a shadowing stub; the full payload is
  archived at seq M`), because a correction nobody can see is how this class of bug survived a year.

Invariant 1 was never at risk — the durable log keeps every copy, and the compaction finalizer
already resolves through the replacement chain (`resolveOriginalEvent`). The defect was entirely in
what the archive claimed. Note also that integrity checks pass over this: chapter `sha256` and
artifact hashes were verified consistent, **of the stub**. Internal consistency is not fidelity to
the log, and #334 is why the two must be asserted separately.

### Amendment (user-directed, 2026-09-19, APPROVED, **landed**): the plot note across in-place compaction

> Shipped: the forward path is the preset persona suffix (the agent is told to end substantive turns
> with a `PLOT:` line) and the engine copies the latest such note verbatim into the replacement above
> the index cards; the elicited fallback is one bounded call gated by `elicitedPlot` (default `true`) —
> tail-heavy excerpt capped at ~8K chars in, `maxTokens: 220`, note clamped to 900 chars, any failure
> degrading to `null` (no note, never a crash). Both halves pinned in unit; the forward path proven live
> in verify **E8** (a suite-B run carried `PLOT:` blocks through seven compactions). The 60-word figure
> below supersedes the ~120 originally proposed.

Heavy mid-turn tidying measurably erodes *plan* continuity (FINDINGS, oversized-turn runs: model
finished the reading but abandoned the wrap-up). The TOC preserves what was **done**; this adds what
is **going on**, authored while the model still holds the thread:

- **Forward-maintained (preferred):** preset discipline — at each turn's end the agent leaves a
  compact *plot note* (objective, current hypothesis, next step; ~40–80 words, no tools). Compaction
  copies the latest note verbatim into the replacement, above the index cards. Cost: a little output
  per turn; zero extra prefill at compaction, which is when cost bites.
- **Elicited (fallback, bounded):** if no plot note exists at compaction time, one auxiliary
  completion over the **TOC + retained tail only** (tail-heavy excerpt, ~8K chars in, ≤60 words out,
  `maxTokens: 220`; key `elicitedPlot`, default `true`) asks the model to state the plan. This is
  deliberately not a re-read of the archived span — it costs a fraction of what a naive summary call
  would, and only when the free path failed.
- Invariant check: the model authors *state*, never archive text (invariant 4 intact); the note rides
  the replacement event append-only; every byte of the conversation still lives in chapters.

## What a chapter contains: coverage is a decision, never a default (#346)

The audit reported that ~75% of durable events never render into a chapter and asked for that to be
fixed. Measured against three real production logs — **55,334 events across 35 distinct types** — the
percentage was right and the implied conclusion was not: most of that mass is lifecycle bookkeeping an
archive should not contain. What was actually missing was not coverage but **a record of which absences
were chosen**, because "excluded" and "forgotten" were indistinguishable — and a new host event type
would land in the same silent place as the interesting ones.

`EXCLUDED_EVENT_TYPES` in `src/render.ts` is now that record: every type the renderer deliberately does
not write, with the reason. The `default:` branch counts a type as unrendered **unless it is listed**, so
judged silence is possible only where a reason is written down, and an unjudged type still surfaces in the
existing *"N event(s) rendered no output"* warning. The asymmetry is the entire design.

Three types did carry unique content and are now rendered:

- **`command/run`** — a human invoking a slash command, with its arguments. Verified unique against every
  user/assistant message and tool call/result in all three logs. AGENTS already requires "always preserve
  invocations and arguments in the body"; a command invocation was the one invocation being dropped.
- **`command/done`** — its outcome, because an invocation without its result is half a fact.
- **`goal/change`** — the goal **ledger** as one compact fact (operation, revision, id, a 120-char prefix,
  the seq). Not the objective text: that arrives as `<goal_round>` user messages, which render verbatim, so
  a full copy would duplicate them. The ledger points; the round holds the bytes.

And the most valuable finding here is a **negative** one, because it is the fix that must not be made.
`agent/inbox/spliced` is 2.4% of all events with ~2 MB of payload — the single largest "uncovered" type,
and the obvious candidate for a new case. Measured: **658 of 659** spliced messages are byte-identical to a
`user/message` the renderer already writes. Rendering the channel would have duplicated two megabytes of a
person's own words into every chapter that spans them, while making coverage look better. So it is excluded
*by measurement*, and the row that pins the non-render carries the count.

Consequences to keep in mind when extending this: an exclusion list makes the renderer quieter, and quieter
is not the same as correct — so the gate (`tests/unit/render-coverage.test.ts`) checks coverage against the
committed inventory of *observed* types, not against a hand-written list, rejects thin reasons, and asserts
that an unlisted type still warns. Add a type to the table only with a reason that would survive being read
in six months.

## The archive moments

Chapters are written by exactly five doors, and knowledge that trips none of them is knowledge
that never enters the index. Four are session-facing, all idempotent over a per-session watermark
(`fromSeq = max(chapter.endSeq) + 1`) and anchored on the last **completed** turn (`turn/end`):

1. `chapters_continue` (tool) and `/chapters-continue` (deterministic door) — archive + child session.
2. `chapters_fork` (tool) and `/chapters-fork` (door) — archive + branch session (no new bytes).
3. `/chapters-save` — archive only, parent untouched.
4. Compaction finalize — the engine's `summarize()` commits a plan pre-durable, and the post-commit
   finalizer writes the chapter (issue #47 note: the fanout field study shows this is the ONLY one
   of these that subagents historically reached — 20 child compactions, or nothing).
5. **Subagent settlement (issue #47; ordering corrected by #58)** — a host-plane listener on the
   published `subagent/end` lifecycle event runs the SAME save pipeline (one implementation, shared
   with door 3 by extraction — never a second renderer) for children whose header carries
   `origin: subagent` and `agentPreset === chapters`. **The ordering is mode-dependent, and that is
   the whole defect** (#58, measured): a **one-shot** run emits `end` before its dispose
   continuation, so the synchronous fast path — `agents.get(info.id).session.snapshotEvents()` —
   sees the live log; a **continuable** run is disposed *first* (`flushFinalState` →
   `handle.dispose()` → `resident.delete` → `observer.settle` → emit), so the fast path is **always**
   empty for continuable children — the kind a real fanout produces. The durable arm is therefore
   not an edge case; for `mode: "continuable"` it is the only arm, and it must return
   **payload-bearing** events: `sessionQuery.readSession` (cloned header + `snapshotSessionEvent`
   events, one call, so the header scan goes away too). It must **not** be `sessionQuery.listEvents`,
   whose records carry `seq`/`type`/`time`/`surface` and **no `data`**: fed to the renderer they yield
   a structurally valid, semantically empty chapter — every tool name `unknown`, every argument `{}`,
   every result the `sha256("")` blob at 0 B, every message event pushed to `unrenderedSeqs` — which
   is what 12 archives on this machine turned out to be. The file:line facts are in
   `docs/contract.md` § Durable reads. When neither arm yields a payload-bearing read, the child is
   skipped with a loud diagnostic, never guessed.
   **No door commits an archive that rendered nothing** (#58): the shared save core refuses a chapter
   with `stats.messages === 0` over `stats.events > 0` — a tool call always follows an assistant
   message, so that pair is unreachable in real traffic and means "payload read", not "short
   conversation". Refusal is a `payloadless` skip **with numbers**, before any number is reserved or
   any file is written: a committed husk would poison the watermark, which is `max(endSeq)`, and the
   child could then never be re-archived without a repair (#60). Door 5 also stops discarding
   `writeArchive`'s warnings — it already says "N event(s) rendered no output", and dropping that
   string is what let the defect run for days. It does **not** `linkChild` the parent (#58, measured
   after the plan assumed otherwise): `rootSession` *is* the store directory name, so linking re-homes
   every file the child already wrote, while `buildIndex` walks ancestors only — the link buys zero
   reach and costs the tree. A child keeps its OWN tree and is reached through `chapters_search` and
   `linkChild`-free ancestry of the PARENT's own rows. Save-only, so the
   "no continuation-creating actions mid-step" rule is not engaged: no session is created, no surface
   is compacted. Enrichment is **queued** per settlement — a 10-child fanout must not `runNow` ten
   annotator passes — and an empty or refused chapter is never enqueued (#61). A continuable child
   settles repeatedly; the watermark makes every repeat after the first a save of only-new-turns.
   Config: `subagentAutoSave` (default on) — and **that flag gates this moment alone (#341)**. The
suggested-next-step door and the #319 reload self-check are separate doors that merely share the
turn/log boundary; they were nested inside this flag until #341, so disabling archiving also silenced
the prompt bar while `/chapters-prompt` kept reporting ON. The prompt plane's switch stays what it
always was — a configured prompt model, one knob, no second boolean.
`tests/unit/host-plane-door-gating.test.ts` pins the nesting structurally, because `apply()` has no
deterministic harness and an unobserved wiring block is exactly how this drifted.

**Amendment 2026-10-22 (#61, item 5) — the seventh moment: a rooted child that has never archived.**
A `ch-*` continuation child is a real session with a real `parentSession`, and door 5 does NOT cover it
because its header says `origin: user`/`agentPreset: chapters`, not `origin: subagent`. The field case was
`ch-dc3be3ab`: **2,363 events, 414 tool calls, 2 completed turns, `chapters: []`, `reservations: {}`** —
not a failed archive, an archive that was **never even attempted**, because no moment was watching it. Its
work is in the log and invisible to every search on the machine.

So a `turn/end` listener archives through the SAME save core when all of:
1. the session is a `chapters`-preset session AND rooted — lineage read from whichever of its three
   homes has it: the registry row (`chapters_continue` writes it with `linkChild`, continue-core.ts:520),
   the header, or the `ch-` id prefix our own continue door mints (continue-core.ts:501). **Measured
   2026-10-22: asking the header alone missed the field case** — `ch-dc3be3ab` has
   `parentSession: NONE, origin: undefined`. The user's own root sessions stay behind doors 1–3;
2. `origin !== 'subagent'` (door 5 already owns those, and two doors on one child double-writes);
3. either its row has **never** archived (`chapters.length === 0`) and it has ≥1 completed turn, or the
   unarchived completed turns have passed `childAutoArchiveMinTurns`.

It is **save-only**: it creates no session and compacts no surface, so the "no continuation-creating
actions mid-step" rule is not engaged — the same reasoning that let door 5 exist. Thresholds are config
(`childAutoArchive`, `childAutoArchiveMinTurns`), never literals. Knowledge that trips none of the seven
never enters the index: when adding a door, **extend this list, never copy the pipeline**.

### The watermark is one predicate with two arms (#336)

The watermark is `max(endSeq)` over all records, `-1` when there are none, and the door that accepts a
submission holds it to a floor. That floor was **one-sided**: it refused a range starting *above* the
watermark (the seqs in between would be dropped, and a gap is loss) but accepted a range starting
*below* it, which re-archives committed seqs under **fresh chapter numbers** — the same text living in
two active records, against "keep chapter numbers and bodies immutable".

The refusal had no partner either, so nothing could see the result. `coverage()` starts its cursor at
the floor, so an under-floor submission reports `gaps: []` while inflating its own covered count (302
"covered" for 201 real seqs), and the repair auditor keeps coverage in a `Set<number>` and looks only
for seqs *missing* from it — a Set has no cardinality, so "in two chapters" and "in one" are the same
value to it. Live registry when this was measured: **42 of 64 rows self-overlapping, 1,453 duplicate
records, 29,871 seqs archived more than once.**

The rule now, in one place:

- `nextUnarchivedSeq(chapters)` is the ONLY derivation of "first seq not yet archived". The two doors
  previously had different ones — `continue-core` seeded `max()` at `-1`, `save-core` at `0` and then
  wrote `lastArchived > 0 ? lastArchived + 1 : 0`. Both are correct until a chapter legitimately covers
  seq 0, which every real log is positioned to do (a durable log begins with `permission/preset` at
  seq 0), after which save-core's form re-archives seq 0 on every call.
- `validateRanges` refuses on **both** sides of the floor and names which side was crossed.
- `duplicateCoveredSeqs(chapters)` counts owners per seq; `repair.ts` reports a `duplicate-coverage`
  finding per contiguous run sharing one owner set. It is **report-only by decision**: choosing which
  of two records to supersede is a call about which citation was meant to name which bytes, and the
  durable log holds both copies either way. Auto-picking would mutate an immutable record on a
  heuristic — the same posture `duplicate-number` already takes.

One exemption keeps a documented guarantee from being broken by the lower arm: a submission whose range
list is **exactly** what is already committed is a retry, not a duplicate. The attempt key
(`sessionId@ceiling`) makes that call reuse its numbers and write nothing new — `saveSession`'s
idempotence, pinned by `tests/integration/plans-carriage.test.ts` ("a retry of the same archive reuses
numbers and never duplicates the blob"), which the naive two-sided floor turned red. Only a range list
that *differs* from what is committed re-archives under new numbers, and that is what the refusal is
for. `chapters_continue`'s own retry path relies on this, so the exemption is load-bearing, not a
convenience — and it is pinned in both directions (`an exact replay stays idempotent while a differing
range list is refused`) so it cannot widen into a hole.

## Budgets and the Reserve Margin

Two distinct ceilings. Conflating them caused the original design's silent-failure mode.

**Continuation budget** — the *newly added* context of a child must be small and predictable, as a share
of the space left after the fixed header:

```
tocTokens + handoffNoteTokens ≤ continuationBudgetRatio × (window − systemPromptTokens)
```

**Chapter target** — per-file size, governing rendering and splitting. Not a hard error.

Deriving the budget from the **remaining** window rather than the whole window is not a nitpick. On a 32K
model with a ~9K system prompt and tool schemas, a 25%-of-window rule gives an 8K ceiling that the TOC and
note may blow through before any work happens, and the plugin would refuse every continuation on exactly
the small-context hardware it targets. The header is a fixed cost to subtract, not a competitor for the
index. Measure it once per generation and cache it.

The budget is enforced as a **preflight**: measure, then refuse with concrete numbers
(`TOC 4,120 + note 2,800 = 6,920 > budget 5,750 (0.25 × (32,000 − 9,000))`) *before* creating any
session. Never truncate to fit — a clipped handoff note is the lossy behaviour this plugin exists to
avoid, and a silent clip is exactly the bug that takes a month to notice.

There is deliberately **no cap on the handoff note.** The budget check subsumes it: a model that dumps the
whole conversation into the note fails preflight and is told by how much. The note should be state of play
— decisions held, the next step, anything in flight — and the tool description should say so rather than a
numeric limit doing the talking.

This margin is also what automatic triggering needs, which is why the phases were reordered: pressure
measurement, the preflight, and a *suggestion* at `turn/end` all land in Phase 2; only autonomous
action stays late.

### The native branch button: cosmetic hide (user-approved 2026-09-17)

The message-row branch glyph is host chrome, not a slot entry. The chosen lever is
**display:none on its accessible label, scoped to action-row buttons** (en+zh spellings);
the sidebar fork entry stays. If a harness update rewords the label, the native button
reappears beside ours — accepted deliberately: a visible, temporary duplicate beats
behavioral monkey-patching of the client's fork call (the dsh-session-fork route, rejected
for its version-drift surface). Do not "upgrade" the hide into an intercept without asking.

## Ancestry: A DAG We Flatten For The Model

History becomes a tree the moment someone continues an older ancestor twice. The worry that agents
won't traverse a DAG is correct, and the answer is that **they never should have to.**

Three rules:

1. **The plugin walks; the model reads a list.** At continuation time the plugin walks the ancestor path
   in the registry and emits a flat, chronologically ordered, numbered TOC. Reading order *is* causal
   order. Depth 10 or mid-branch, the model sees a numbered index and a `read` path — no graph, no
   inference, no traversal.
2. **Back-links are printed, not implied.** The TOC footer names the root session and the parent session,
   so the trace is visible without being reconstructed.
3. **The TOC is the complete index for the current line of work.** Every chapter on the ancestor path is
   listed with its summary, so ordinary follow-up needs no traversal at all.

Cross-**branch** recall — "what did the other attempt try?" — is the only case the linear TOC cannot serve,
and it is rare. It is answered by the registry (which holds the whole tree) behind a future read-only
command, never by a per-fork index file. Carrying it in every session's prefix to serve an occasional
question would tax all work for one.

Two structural consequences:

- **Chapters are keyed by creating session**, not by a linear chain id. Siblings branching from one
  ancestor get different, correct TOCs and cannot collide on numbering.
- **Append-only has no exceptions.** Nothing derived is written back into the store; the registry is the
  only mutable state, and it is a domain table designed for it.

## The Goal Across a Renewal (#349)

An active goal is the one continuing intention a session has, and a child born at a renewal boundary does
not inherit it: `create_goal` requires a direct-human turn, and the child's first turn is
`plugin:dsh-chapters`. Before this, the objective stopped driving the work exactly where the plugin's own
promise begins, and AGENTS' rule to "carry the authorized outcome" was left to the model's prose.

**The rule now: carry the goal as text, and state aloud that it is not armed.** One selector
(`foldGoalFromLog`) folds the parent's durable `goal/change` events — operations `create`, `edit`, `pause`,
`resume`, `block`, `complete`, `clear`, with `{id, revision, objective, phase, maxGoalRounds, blockedReason}`
— and one renderer (`renderGoalCarriage`) emits the child's `## Goal (carried from the parent session)`
block: objective whole, revision, round cap, phase, the seq it came from, and the sentence that only a human
can re-arm. It sits with the plans block, **above** the fold, because an objective is the fact a child must
not reconstruct from recall.

Invariants this respects:

- **No goal, zero bytes.** Sessions that never used a goal get a byte-identical notice, which is also what
  keeps recorded tapes unmoved. An empty section is treated as absent, not as an empty heading.
- **`clear` ends it; `complete` is reported as finished** and receives no re-arm instruction. A child must
  not pick up a purpose the human closed, and must not be told to resume one that succeeded.
- **Unknown operations are ignored, not guessed.** If the host adds one, the fold keeps the last state it
  understands rather than letting an unrecognized event rewrite the child's sense of its own objective.
- **The budget bounds display, never the instruction.** `goalNoticeChars` (default 600, host-declared and
  defaulted on the plugin config — the #354 discipline) truncates the objective with the length stated;
  the "only the human can re-arm" lines are never cut, because a truncated permission notice is worse than
  none.
- **`phase` is foldable; `activation` is not.** The host keeps armed/disarmed process-local and the plugin
  reads it from the live service for its own driver decisions, so the notice says who CAN change the driver
  and never claims what the driver currently IS. Recovering armedness from history would be a guess in a
  record's clothing.

**Deliberately not done, pending a maintainer decision (#349):** the underlying goal *service* has no
direct-human gate, so the plugin could arm a goal on the child unilaterally. Reaching a seam is not having
authority to use it; silently routing around a gate because the tool wrapper is the only thing enforcing it
is the kind of unexamined authority widening this whole release was a study in. If the answer is yes, it
becomes an explicit, documented, configurable step — not a side effect of the birth path.

## Storage

Two stores because they have opposite requirements.

**Chapters and artifacts: workspace files.** The `read` tool must reach them, and it runs under the
session's file sandbox (`workspace-write` permits only the workspace tree). The original
`~/.dsh/chapters` design fails asymmetrically: writes to `$HOME` may succeed while `read` cannot reach
the path, so every TOC bullet is silently dead and the plugin looks like it worked. `ctx.fs` is also
**optional**, so its absence must be a clean refusal.

Layout:

```
<store-root>/                       # default .dsh-chapters/
  <rootSession>/
    chapters/001-project-setup.md   # append-only, never renumbered
    artifacts/8f/8f3a1c9d….txt      # content-addressed, deduplicated
```

Add `<store-root>/` to `.gitignore` on first write and say so — polluting a user's tree silently is its
own small bug.

**The chapter file name is unique by AUTHOR, not only by number (#337).** The directory above is keyed
by *chain root* — one dir per tree, deliberately, so a lineage shares its artifact store — while chapter
numbers restart at 1 for every `freshSession`. Parent and continuation child therefore both mint
`001-<slug>.md` into the same directory, and with a matching title the two paths are identical.
`writeArchive` used to overwrite unconditionally: the per-call `seenFile` set that "resolves title
collisions" cannot see a write made by another session, and the registry kept two records citing one
file — measured live, 40 paths claimed with different `sha256` and 393 `(tree dir, number)` pairs owned
by more than one session, where at most one citation of each pair can be true.

The rule now, in `writeArchive`: a chapter position is written only when it is free or already holds
**these exact bytes**. Identical bytes are a retry and keep the name, so the attempt-key idempotence
guarantee is untouched. Different bytes get a name carrying the authoring session's id; if even that is
held, the write **throws** rather than appending `-2`, `-3` until something is free — a record must not
cite a path nobody predicted, and a collision the plugin cannot resolve is precisely the fact to hand
the operator, with `/chapters-repair` named as the way out. Every resolution is reported as a warning,
never taken silently.

**Registry: a DSH storage domain.** Ancestry, numbering, hashes, ranges, bullet lists. Sanctioned
durability, survives restart, and gives the append-only counter a real allocation home instead of a
directory scan racing a restart.

Trade-off to keep honest: a workspace-relative root makes a chain **cwd-scoped**. Crossing workspaces
means an absolute configured root, at which point `read` reachability must be re-verified — do not assume
an absolute path inside one workspace stays reachable in another.

### The registry must state which workspace its paths belong to (#348)

The two halves of that trade-off were mixed in a way that made the registry unable to address its own
archive: chapter and artifact paths are stored **relative to the session workspace**, but the storage
domain is **per home** — one `~/.dsh/storages/dsh_chapters.json` holding the sessions of every project on
the machine. A consumer holding only registry bytes therefore had no correct thing to resolve against.

Measured on this machine rather than reasoned about: resolving all 3,623 chapter entries against the
*current* workspace — the only choice available without an owning cwd — reports **1,431 (39%) as
"missing"**. Resolving each against its own session's workspace gives **3,620/3,623 present**. Nothing was
corrupt; the addressing was unattributable. Every path-iterating consumer inherits it: repair, restore,
`/chapters-remove`'s blob GC ("delete shared blobs only when no active record references them"), mirror
rehydration, and the knowledge sync's per-workspace projection.

The contract now:

- **A row carries the workspace its paths are relative to** (`SessionState.cwd`), stamped by
  `appendChapters` — the one predicate every door's row write already passes through, which is why the
  stamp lives there and not in each door. `commitChapters`, the save door, the continue/fork doors and the
  compaction finalizer each supply the cwd they already resolved for `makeArchiveFs`; a door that does not
  know one leaves the field absent rather than guessing, because a wrong workspace is worse than none.
- **Optional, so durable state keeps opening.** Rows written before this field must parse — the registry
  has no shutdown migration hook — so `cwd` is `z.string().min(1).optional()`. Absent means "recovery for
  this row stays the durable log", which is what *Recovery needs a surviving source* has always meant;
  it must never mean "resolve against wherever we happen to be".
- **`''` is not a workspace.** The schema rejects it: an empty path resolves every relative chapter
  against nothing and looks plausible while pointing nowhere.
- **`stampWorkspace` returns the same object** when the cwd is absent or unchanged, because
  `store.mutate` treats object identity as "no change" — an unconditional stamp would turn every
  idempotent retry into a write and a `rev` bump.

### Artifact citations must be paths a reader can follow (#348, third defect)

The audit's third finding was that a citation prints `artifacts/8f/<sha>.txt`, which is relative to
`<storeRoot>/<rootSessionId>/` — neither workspace-relative nor absolute — so the `read` tool cannot open
it, while `chapters_artifact` can. Verified on this machine's real archive: the bytes sit at
`.dsh-chapters/17f7c1d6-…/artifacts/e3/e3b0c442….txt`, and every chapter said
`` `artifacts/e3/e3b0c442….txt` `` without ever naming the tool that could fetch it.

`artifactPath` is store-relative **on purpose** — it is what the writer returns and it stays stable across
workspaces. The defect was printing that internal form as if a reader could follow it. So `RenderConfig`
now carries an optional `citationBase`, computed by `citationBaseOf(storeRoot, rootSessionId, cwd)` —
workspace-relative when the store is inside the workspace, and **no base at all** when it is not:

- with a base, the line reads `` → `.dsh-chapters/<root>/artifacts/8f/<sha>.txt` ``, which `read` opens;
- without one, the line reads `` → `artifacts/8f/<sha>.txt (via chapters_artifact)` ``, naming the tool.

What is deliberately **not** allowed is a bare unopenable path with no hint. A model will retry a path
rather than question it, so an honest pointer to the retrieval tool beats a confident wrong location. Every
door supplies the base from values it already passes to `writeArchive` (save, continue/fork, and the
compaction finalizer, where the base is computed at finalize time because it depends on the session's
`rootSession`, not just the configured store root) — one convention across the archive moments rather than
a per-door dialect, which is the same mistake #69 settled for stored paths.

One existing row in `render.test.ts` asserted the bare store-relative fragment and had to change: it was
pinning the defect as the expected shape. It now requires the annotated fallback, and asserts the old form
is *absent* — so a regression to "confident unopenable path" fails loudly rather than matching the old
expectation.

Separately, the same audit found a second dialect in live rows: `#finalizeOne` passed an **absolute**
`resolveStoreRoot(...)` as `storeRoot` with no `cwd`, so `writeArchive` minted absolute stored paths
while the checkpoint TOC cited the workspace-relative form for the same file — the split #69 had already
settled ("relative is the right winner"). It now passes raw root + `cwd`, exactly as the save door does.
Consumers must still compare with `sameStoredPath`, never `===`, and a row that predates this still holds
the absolute form.

## Atomicity

Writing files, allocating numbers, creating a session, and committing registry state is not
transactional. Order them so the worst failure is an orphan, never a lie:

1. **Reserve** numbering, chapter ids, and slug assignments in the registry *before* writing files.
2. Render and write chapter files and artifacts; verify each path resolves.
3. Create the child session with the TOC notice.
5. **Only then** commit the registry entry linking parent → child — this is the commit point that makes
   the continuation visible.

Retry must be **idempotent**: key the attempt on `sourceSession + archiveCeiling`, so a second call reuses
reserved numbers and existing files rather than duplicating chapters. Failure before step 5 leaves
unreferenced files, which is recoverable garbage; failure after step 4 without step 5 leaves a child
citing chapters that don't exist, which is not. Hence the ordering.

Concurrency is real, not theoretical: parallel branch work is a first-class pattern in this ecosystem, so
two agents can continue from one ancestor at the same time. A directory-scan counter races; registry
allocation does not.

### The row is shared, and a lost update is not an orphan — it is an erasure (#59)

Steps 1-5 order the work *inside* one door. They say nothing about two doors writing the **same session
row**, and the registry row is one whole value: `get → mutate → put`, last writer wins. Five doors plus the
turn/end signature listener write it, and the wide ones hold a stale snapshot across an await — a model
call, or hundreds of filesystem writes:

- `enrich-wire.ts` reads the row, annotates per chapter, then puts the **whole row** back
  (`get:185 → … → put:297`);
- `engine.ts` summarize reads, elicits a plot (a model call), then puts (`:567 → :641`);
- `engine.ts` finalize reads, runs `writeArchive` (render + every artifact), then puts the state read
  **before** those writes (`:857 → :891`);
- `store.ts` allocator and `commitChapters` each read-modify-write (`:240-266`).

Field instance, second-level evidence (`session-aac0254e`): a compaction committed its manifest and wrote
its chapter at **04:53:50.915**; an enrichment put built from a pre-compaction read landed at
**04:53:52.841** and rewound the row. The manifest, the reservation, the `finalized` entry and the chapter
**record** all disappeared — while the 960 KB chapter file stayed on disk, unregistered and uncitable.
`nextChapterNumber` rewound to 15, so a later door spent 15 again: two different `015-*.md` files in one
tree. `appendChapters` deduped the reallocated record by **number alone** (`registry.ts:159-161`), so the
collision presented as a harmless retry.

So an orphan file is the tolerated failure; an **erased commit** is not, and it is invisible — the files look
right and only the registry knows. The rule, therefore:

**Every registry mutation for a session goes through `RegistryStore.mutate(sessionId, fn)`** — a
per-session serialized section that re-reads the row before writing and refuses on a changed `rev`. A door
that holds work across an await passes a **function**, never a snapshot. Refuse with numbers, never
silently clobber: a refused write is visible and retryable, a lost update is neither.

Three invariants in the same family: an identity is `(number, sha256)`, never `number` alone; a reservation
whose files never landed is **released** (or expires) instead of burning a number forever; and one
unresolvable item in the finalize queue may not poison the items behind it.

## Observability — a detected failure is a delivered failure (#61)

Every P0 in #58/#59/#60 was **already detected by the code** before a human ever looked: `writeArchive`
warned "N event(s) rendered no output", `planSummarize` counted the oversize chapters, the finalize
catch built a full diagnostic — and then the value was discarded. So the rule is not "add checks", it is
**deliver what the checks already say**:

- **The diagnostics sink defaults ON.** `DSH_CHAPTERS_ENGINE_ERRORS` unset now means
  `<store-root>/diagnostics.log`, not "nowhere". All three SAIP compaction finalization failures left
  zero trace on disk, and door 5 logged `saved` to a logger nobody reads for three days. The env var
  still wins; the literal `off` is honoured, because an operator must be able to silence it — but
  silence is now a choice, never a default. `diagnosticsLog` in the profile config sets the path
  declaratively; resolution order is env → config → `<store-root>/diagnostics.log`.
- **Every plane writes to it, not just the engine (#352).** The prompt plane was the exception: one
  project's `diagnostics.log` held 21,138 `realm:*` lines, 4 `rules-section`, 4 `auto-save` and **zero**
  prompt lines, so the door's own verdicts — did it see the turn boundary at all, did the model spec
  reach the plane, why was this round skipped, was the registration refused — existed only in a terminal
  and in a `ctx.logger` a rig boot throws away. That absence is why "suggestions are one turn behind"
  (#340) and "the prompt door vanished with `subagentAutoSave`" (#341) each needed a full audit to find.
  The runner's `log`/`warn`, the reload self-check, the boot reclaim and a refused door registration now
  go through the sink under a `prompt:` tag — **keeping the stderr copy**, since the two channels serve
  different readers and #61 added stderr precisely because the logger is not retained. High-frequency
  per-turn witnesses stay on stderr only: the file carries decisions, not a firehose.
  `tests/unit/prompt-diagnostics.test.ts` asserts both halves — the wiring calls the sink, *and* a
  `prompt:`-tagged note really lands in the file — because a structural grep alone passes happily
  against a no-op.
- **Warnings reach humans, with a limit and a withheld count.** `(86 warning(s))` told a user nothing
  about 86 real findings; the ones that mattered named the husk and the unarchived 0–4082 hole. Doors
  print the first `warningsDisplayCap` texts and `…and M more`, through ONE formatter — a per-door copy
  is how one door would show text and another show a count.
- **`/chapters-status` never early-returns.** It prints Identity · Provider · Enrichment · Diagnostics ·
  Auto-save · **Findings** (read-only, from the #60 auditor) in every state, including unlinked. An
  unlinked user used to see one sentence and no health at all. A session with events and **no** chapters
  says so: *"N events, M completed turns, 0 chapters — nothing it does is retrievable."*
- **A tool's own output is bounded and self-reporting.** `chapters_segment` returned 49,932 characters
  while also reporting `(Omitted 275266 bytes …)` — ≈81K est tokens into a 32K-class window, asking a
  small model to judge a candidate list it never received. Candidates are ranked by size, capped by
  `segmentCandidateCapTokens`, and the result always says `showing X of Y by size, Z KB withheld`.
- **Attribution is durable.** `generated:` carries `pluginVersion`, because "which build wrote this row"
  must not be inferred from mtimes after the fact — this audit had to.

## Repair — re-deriving the archive from the log (#60)

Invariant 1 (the durable log is append-only and complete) is what makes every defect in #58/#59
recoverable. Repair is the door that spends that guarantee. It is **not** a compaction, not a rewrite,
and not a second archive implementation: it calls the same save core every door calls
(`composeChapters`/`deriveRanges` → `renderChapter` → `writeArchive` → `commitChapters`), so a repaired
chapter is byte-for-byte a normal chapter.

The three-way disagreement it looks for, and the one rule that keeps it honest:

- **Log vs store vs registry.** `audit()` compares the reserved numbers, the records, and the files on
  disk, and classifies each mismatch. A store can hold a file no record cites (a lost update erased the
  commit), and a registry can hold a record whose file was never written (a poisoned finalize queue).
- **Supersede, never mutate.** Damage is never repaired in place, and the body-hash guard is the only
  sanctioned chapter-file mutation — the one deletion class is operator *Removal of bad data*, below, and
  repair itself never deletes — so a repair writes a NEW number carrying `repairs: <n>`, marks the
  old record `status: 'superseded'`, and **copies** the bad file into `<tree>/.repair-quarantine/`.
  Nothing is deleted. Every superseded record is excluded from the TOC, the index and enrichment — a
  husk left in the corpus is a lie a later reader cannot see past.
- **A dead citation is satisfied, not edited.** A compaction manifest already handed the host TOC text
  citing `…/020-<title>.md`. Repair renders the shadowed span and writes it to **that path, with that
  reserved number**. The session's committed text becomes true; no log byte moves.
- **Numbers stay spent.** A released reservation frees its retry key, never its numbers, and a counter
  is only ever raised to `max(spent)+1`. Re-using a number is how two files end up named `015-` in one
  tree (#59), so allocation additionally skips any number the row already carries.
- **Journalled and reversible.** An applied run writes `<tree>/repairs/<utc-stamp>.json` first: one
  entry per move with before/after hashes. `restore <journal-id>` walks it backwards. If the journal
  cannot be written, the run refuses to start.

Repair runs as one serialized section per session row (#59) — a repair that clobbered a live door's
commit would be the same bug with better intentions.

## Removal — bad bytes leave the archive (#255)

The field case: a prompt meant for another project, typed into a project session. The contaminated turns
archive, and from that boundary on every derived surface — TOC notices, index shards, search, enrichment —
carries the other project's context. Supersede is the wrong remedy for *contamination*; it is for damage.
The operator wants the bytes gone from memory, not merely uncited. Maintainer decision, 2026-11-02:
**bad bytes leave the store; the log is what lets you admit you were wrong.**

What removal deletes, and what it keeps:

- **Deletes**: the chapter file, its orphaned artifacts and plan documents — a content-addressed blob dies
  only when no *active* record in any session tree under the project's store root still names it (shared
  blobs survive; identity through `sameStoredPath`, never `===`) — and the same paths in the pool mirror,
  so `stageAllAndCommit` records the deletion and `buildIndexInClone` regenerates shards from what remains.
  `publishIntoClone` stays copy-only: a deletion is done by the removal door, never by the publisher.
- **Keeps**: a `status: 'removed'` stub record — number, `startSeq`/`endSeq`, `path`, `sha256`, the
  artifact manifest, title, `removedAt`. The watermark is `max(endSeq)` over *all* records: an erased
  record rewinds it, and the next auto-archive moment re-captures the poisoned span — the exact failure
  this door exists to prevent. Numbers stay spent; `nextChapterNumber` never rewinds.
- **Never touches**: the durable log (Invariant 1), an already-seeded child's TOC (a seeded notice is a
  recorded event; its dead citation is *reported*, not rewritten), another project's store, or git history.

Discipline shared with #60: journal-before-unlink (`<tree>/removals/<journalId>.json` — a journal write
that fails stops the run before the first deletion; a partial apply journals exactly what went and says so
with numbers), registry mutation only through `store.mutate`, and undo by **re-derivation**: `restore`
re-renders the journaled span through the same save core repair uses, under a NEW number, and refuses
(never fakes) a span whose render yields zero messages.

The derived layers never each learn the new status: `isActiveChapter` is the ONE predicate, and both
`superseded` and `removed` fail it — TOC (`collectEntries`), index shards, enrichment, plan rows.
`rehydrateStoreFromMirror` will not restore a name owned by a `removed` stub: the copy-back path is
precisely how a deletion resurrects itself between unlink and push. The operator gets a dangling-citation
report at removal time, and dead-citation misses afterward land in `<tree>/removals/missing-access.log`
(#61 — a detected failure is a delivered failure).

Scope, stated rather than hidden: **v1 is single-machine correct**. A second machine holding the same pool
with the file still in its local store can re-publish it; cross-machine tombstones ride the per-session
collections JSONL (already synced, append-only) as a follow-up issue.

## Integrity

Chapter files are plain Markdown in a writable tree whose content is replayed into a child as an
authoritative `user/message` — the model's own claimed memory. Anything that can write those files,
including a tool executed inside the workspace, injects text into every session downstream. That is a
durable prompt-injection surface, and worse than the ordinary kind because it arrives wearing the
guise of the agent's own past.

Mitigation, in the order that pays:

1. **Hash every chapter body and artifact at write time** (`sha256` in frontmatter *and* registry).
2. **Verify before citing** at continuation time; a mismatch gets an explicit `⚠ modified since
   archived` marker on its TOC bullet rather than silent trust.
3. **Record the authoring session** per chapter, so tampering can be correlated with a turn.

Not solved: a determined in-workspace writer can update the registry hash too. The honest claim is
*accidental drift and single-shot injection are detected*, not *the archive is tamper-proof*. Say it
that way.

## Bounds — What Still Grows

The head is bounded; the index and the disk are not, and neither doc should imply otherwise.

- **The flattened TOC must stay an ancestor-path list, not a whole-tree dump.** Listing every chapter of
  every branch would make "flatten the DAG" a new way to exhaust context — the § Ancestry rule (walk the
  ancestor path only; siblings stay behind a future read-only command) is what bounds the index; folding
  below handles depth itself.
  *(This bullet reconstructs a line corrupted in the file's first commit — the fragment `DAG" becomes a
  new way to exhaust context` survived without its opening. The intent was restated, not recalled; see
  spikes/probe/FINDINGS.md § Doc corrections. Delete this parenthetical once re-reviewed.)*
- **TOC length grows with depth.** At ~30 tokens per bullet and 3 chapters per continuation, a depth-10
  chain costs ~900 tokens — fine. Depth 100 costs ~9K, which is not. **Bullet folding** belongs in
  Phase 4: when ancestor bullets exceed `tocBulletBudgetTokens`, fold the oldest group into one summary
  bullet citing a fold chapter. Folding happens only at continuation boundaries.
- **Reload is a feedback loop.** A model that `read`s three 8K chapters immediately re-triggers pressure
  and may continue again. State the remaining reload headroom in the TOC preamble so the model spends it
  deliberately, and have the pressure detector count reloaded content like anything else.
- **Retention.** Append-only with no GC is unbounded disk growth across abandoned chains. A retention
  policy, or at minimum a documented manual prune command, is required before anyone runs this for
  months. Content-addressed artifacts make pruning safe to reason about — refcount them.

## Open Questions

Carried into Phase 0 deliberately, not by omission:

1. **Is an unseeded `agents.create` durable, sidebar-listed, and resumable?** The premise of everything.
   If not, the design needs a different carrier and should not be funded as written.
2. **Does creating a session schedule a turn?** If so, the child burns its first turn acknowledging its
   own TOC. Fix by instructing the notice to stay silent until addressed, or by creating without
   running.
3. **Coexistence with `dsh-session-fork`.** It already maintains session lineage and a branch registry,
   and patches client `sessions.fork` globally. Depend on it as a peer, vendor against the same pinned
   version, or declare mutual exclusion — all defensible; picking silently is not.
4. **How do tool results that reference deleted files render?** A `read` of a file later removed is
   still verbatim text, which is correct — but a `bash` output naming a path that no longer exists is
   misleading without context. Probably a renderer annotation, not a format change.
5. **Test strategy.** The verification checklist is manual, but "the child is smaller than the parent"
   and "ranges validate" are exactly what an automated regression suite should own. Both reference
   plugins have `tests/`; we should decide the harness (vitest, like `dsh-compact`) before Phase 1.

## References

`examples/` is gitignored; read the **one** file that answers the question. Do not read all four.

| Concern | File |
|---|---|
| Workspace attach, preset compose, resume kernel | `dsh-session-fork/src/vendor/fork.ts` — header lists upstream sources + pinned commit |
| Why `agents.create` is the only durable route; notice event | `dsh-session-fork/src/branch.ts:8-14,154` |
| Storage-domain registry | `dsh-session-fork/src/store.ts:36-43` |
| `defineTool`, `jsonOutput`, `exec` caller | `dsh-session-fork/src/tools.ts:110-121,200` |
| `inject`, registration | `dsh-session-fork/src/index.ts:161,786` |
| Real fork handler — confirm what we avoid | `deepseek-harness/packages/api/session-controller/src/commands.ts:185-282` (`seed` at `:260`) |
| `CreateAgentOptions`, optional `seed` | `deepseek-harness/packages/core/agent/src/index.ts:95,388` |
| `SessionHeader` | `deepseek-harness/packages/core/session/src/types.ts:93-122` |
| `defineTool` signature | `deepseek-harness/packages/core/tools/src/schema.ts:545` |
| `ctx.llm.stream()` prefix reuse | `deepseek-harness/packages/compaction/compaction-basic/src/index.ts:225,290` |
| `ctx.fs` is optional | `deepseek-harness/packages/context/agent-instructions/src/index.ts:6` |
| `Schema<Config>` idiom | `dsh-compact/src/index.ts:15,26-37` |
| Packaging (`dsh.bundle.patch`) | `dsh-session-fork/package.json`, `cordis.patch.yml` |

**Do not port from:** `dsh-session-fork/src/vendor/compact.ts`, `squash*.ts`, `merge-region.ts` (span
rewriting — forbidden); `dsh-session-fork/src/prompt.ts` (system-prompt contribution — invariant 3);
`dsh-compact`'s mutation strategy (in-place by design). `dsh-plugin-dev-kb` is a minimal plugin shell
only; skip it otherwise.

## Phases

> **Superseded in part.** `docs/host-compaction-seam.md` found that the harness already ships automatic
> pressure compaction (`thresholdRatio`, default 0.8), provider-confirmed overflow recovery, per-model
> policies, and a single sanctioned `summarize()` subclass hook on `BasicCompactionEngine`. Phases 1-3 below
> predate that discovery: `pressure.ts`, `compact.ts`, custom surface mutation, and our own compact command
> are all **dropped**. The MVP becomes a subclassed engine that returns a deterministic TOC over archived
> chapters, plus the archive, registry, and fork tool. **Phase 0b (rounds 12-17) verified that revised MVP
> end-to-end** and settled the mount: our engine rides a preset realm (`isolate: { compaction: true }`
> group, our row replacing `compaction-basic`), continuations compose via
> `setup: agentCtx => agentPresets.mount(agentCtx, presetId)`, and `chapters_continue` remains the
> *branching* mechanism — automatic relief is the engine's. Read
> [docs/host-compaction-seam.md](host-compaction-seam.md) and FINDINGS § Phase 0b before implementing.

Reordered so the reserve-margin and pressure machinery — which automatic triggering needs — is built
early rather than last.

**Phase 0 — Prove the premise.** Skeleton, one trivial tool with an `output` schema, then: unseeded
create → durable? listed? resumable? header-matching? Single-event seed at `seq = 0` accepted by
continuity validation? Child first-request tokens materially below the parent's? Settle naming, the test
harness, and the `dsh-session-fork` coexistence question here.
*Gate: if the child is not durable and listed, stop and redesign.*

**Phase 1 — Render, cite, and bound.** `chapters_continue` with validated ranges; bodies rendered from
the log; artifact deferral and content-addressed dedup; registry with ancestry, numbering, hashes; flat
ancestor-path TOC with handoff note and back-links; the continuation **preflight** with
concrete refusal numbers; atomic ordering and idempotent retry. Manual trigger, agent supplies ranges.

**Phase 2 — Segmentation as a function, plus pressure detection.** `chapters_segment` returning validated
ranges, implemented as a callable usable **with or without an agent turn**; `turn/end` pressure check
that **surfaces a suggestion** (no autonomous action). Both the UI button and Phase 3 depend on this
seam, which is why it is here rather than near the end.

**Phase 3 — Automatic continuation.** Fires on the Phase 2 detector at `turn/end` only, through the same
Phase 1 preflight. Never mid-step, never `agent/pre-step`.

**Phase 4 — Bound the index.** Chapter splitting at continuation boundaries; bullet folding past
`tocBulletBudgetTokens`; reload budget in the TOC preamble; artifact refcounting and a retention/prune
command.

**Phase 5 — UI trigger.** Title-bar button sharing Phase 2's segmentation. Deliberately last: it needs a
client bundle, `tsdown.client.config.ts`, and the `slots`/`locale`/`connection` client injects — the
heaviest packaging in the project, for ergonomics rather than correctness.

Permanently out of scope: in-place span compaction, prefix rewriting, seeding from parent events,
system-prompt contributions, and truncating anything to fit.
