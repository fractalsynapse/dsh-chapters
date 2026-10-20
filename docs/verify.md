# Verification

The checklist in `AGENTS.md` is short because it only lists what matters. This is how to actually
perform each check, with the numbers to record.

## Test Strategy First

Decide the harness in Phase 0, before Phase 1 code. Both reference plugins test their own way:
`dsh-compact` uses vitest (`vitest.config.ts`, `test/`, `e2e/`), `dsh-session-fork` uses `bun test`
with `tests/`.

The point of choosing early: several core guarantees are *pure functions* and must be unit-tested, not
hand-verified on a live profile every time.

| Unit-testable without a running harness | Why it must be automated |
|---|---|
| Range validation (ascending, non-overlapping, coverage ≤ ceiling) | A silent gap drops archived history forever |
| Chapter renderer: event slice → Markdown, including fence-escaping and artifact deferral | Deterministic input/output; the only cheap way to catch a renderer truncating at an embedded ```` ``` ```` |
| `anchoredBoundaryOf` → archive ceiling | Vendored kernel logic; drift is invisible until a chain is corrupted |
| TOC assembly from a fixture registry (flat, chronological, back-links) | Proves the DAG flattening without a live session |
| Preflight budget math and refusal message | The "never truncate" guarantee is one `if` away from being lost |

Kernel-dependent behaviour (durable create, sidebar listing, cache behaviour) cannot be unit-tested and
needs the live procedure below.

## Live Procedure

Install for every step, after building:

```bash
tsc -p tsconfig.json
dsh plugin --profile web add "link:$(pwd)"
# restart: Ctrl-C, then `dsh web`, then refresh the page
```

A restart recomposes every session's header, which resets cache state profile-wide. **All cache
measurements are only meaningful within one process generation** — record the generation (restart) with
the numbers, or the measurement is unreproducible.

### The Gate Checks

**G1 — The child is smaller than the parent.** *The* regression test for the seeding mistake.
Record the first-request `usage` of both. Expected: child ≈ system prompt + TOC + note, and **materially
below** the parent's. A child near the parent's size means it was seeded from the log — invariant 2
violated. Every other check can pass while this one fails silently, so check it first.

**G2 — The parent's cache is undisturbed.** Continue the parent; record `usage.cacheReadTokens` on the
step before the continuation and the step after. Expected: both high, no drop.

**G3 — The child builds a stable cache.** Send two messages in the child; `cacheReadTokens` should be
near-zero on the first and high on the second.

Steps 4, 7, 8 of the `AGENTS.md` list are G1–G3. They are the whole point of the design.

### Correctness Checks

| # | Check | Procedure | Passes when |
|---|---|---|---|
| 1 | Installs | `dsh plugin --profile web add "link:$(pwd)"` | no error; note that `add` alone does not activate |
| 2 | Tools listed | restart, open an agent session | `chapters_segment` and `chapters_continue` in the tool list |
| 3 | Files written | run a continuation on a 2-topic conversation | chapter files exist under `<store-root>/<root>/chapters/` |
| 4 | **G1** | see above | child first request materially smaller |
| 5 | TOC is the first message | open the child | its entire content is the TOC notice; nothing inherited |
| 6 | Durable and listed | restart `dsh web` | child still in the sidebar, still resumable |
| 7 | **G2** | see above | parent `cacheReadTokens` unchanged |
| 8 | **G3** | see above | child cache builds on turn 2 |
| 9 | Reachability | in the child, ask it to `read` a bullet path | returns real archived text. A **reachability** test, not file-existence — pass `ls` first to see the difference |
| 10 | Artifact deferral | archive a turn with a large tool result; mark it `inline: false`, then `read` the reference path | artifact written and path resolves; identical results stored once; **and** the same result is still written when inlined (deferral is a copy decision, not a data decision) |
| 11 | Cumulative TOC | a second continuation | first fork's chapters still listed, by ancestry walk |
| 12 | Sibling branches | continue an ancestor twice | two correct, non-colliding TOCs, each listing only its own ancestor path |
| 13 | Registry survives restart | restart, continue again | ancestry and next number resume; no reset to `001` |
| 14 | Atomicity | kill `dsh web` mid-continuation, restart, retry the same call | no orphan citation, no duplicate numbers, no TOC pointing at a missing file |
| 15 | Range validation | hand it overlapping ranges and a deliberate gap | refused with the offending range named — not silently archived wrong |
| 16 | Preflight refusal | force a note large enough to blow the budget | refused **before** any session is created, with token numbers; **no truncation** |
| 17 | Tamper detection | edit a chapter body on disk, then continue | `⚠ modified since archived` surfaced from the stored hash, not silent trust |
| 18 | `ctx.fs` absent | run in a configuration without the fs provider | clean refusal with an actionable message, not a crash |
| 19 | Turn boundary | attempt a continuation with an open turn | ceiling lands on a completed `turn/end`; the in-flight exchange is carried by the handoff note, not by a mid-turn cut |
| 20 | First-turn behaviour | open a fresh child, wait | confirm whether it acknowledges its own TOC (open question 2). If it does, the notice needs a stay-silent instruction |

### Evidence Map (as of probe round 26/26b, 2026-09-17)

Checks 1-19 were executed mechanically on the `.dshdev2` scratch profile
(`spikes/probe/lib/round26*.js`, `results-26*.json`): 18 of 20 PASS with durable evidence — including
[15] overlap refusals naming the range, [16] budget refusals carrying numbers, [17] a tampered chapter
surfacing `⚠ modified since archived` inside a real child's notice, [14] an idempotent retry reusing
numbers `[1, 2]` with no duplicate chapters, [13] registry state read back across a process kill, [6]
continuation children AND fork siblings resuming across boots, [19]/[20] turn-boundary refusal and
creation-schedules-no-turn. [7][8][9] (cache gates) point at r11/r22/r23 evidence; [10] boot-level rests
on its L0 tests plus the citation-rule test; [18] is N/A because the store uses node:fs by design.
**Genuinely human-only:** sidebar/visual resume in a browser, `/compact` observed in a live UI, the
readability judgment of TOC prose and chapter bodies — plus optionally following one real 40KB tool
result into an artifact.

## Knowledge Layer — P1 Checklist (record §13)

| # | Check | Passes when | Evidence |
|---|---|---|---|
| K1 | Project identity | same repo URL, different spellings → one key; non-git cwd degrades honestly; local-path upstreams key off the resolved path | unit `repo.test.ts` (10) + `sync-local-upstream.test.ts` |
| K2 | Redaction at the chokepoint | a secret-bearing transcript never lands in a chapter or artifact, same secret → same marker | unit `redact.test.ts` + render chokepoint test; FINDINGS-era |
| K3 | Turn signatures, live | a completed real turn yields a signature with paths/terms from HUMAN content only | **live probe r35j (K5b)** + L0 `engine-adapter.test.ts` (real Session shape) |
| K4 | Topic-sequential composition | same-topic adjacent turns merge into one chapter; topic changes split; size cap splits | **live r36: merge proven (score 0.171 < τ, shared primary)**; L0 compose/anchor tests |
| K5 | Index | shards deterministic; incremental manifest gates commits; rebuild-from-empty == incremental | unit `indexing.test.ts` (7) |
| K6 | Search | topic>title>summary ranking, budget packing with total-vs-shown honesty, project scoping | unit `search.test.ts`; live r35j (K7: finds through a LOCAL-ONLY mirror) |
| K7 | Commands context-free | `/chapters-link` (4 modes: view / path / git-URL+token / `treedx+`URL+token), `/chapters-status` render as flow nodes; the model's context is unchanged | durable: `command/run`+`command/done` lifecycle events, no model/usage around them (e2e plane); r35j K2/K8; treedx modes: `link-treedx.test.ts` |
| K8 | Sync loop, success path | two machines over a REAL git smart-HTTP remote: publish → remote carries layout+index → clone sees it → search crosses | integration `sync-remote.test.ts` + **e2e `knowledge.spec.ts` — suite green 2026-09-18 (4/4, twice — also after the credential-move + three-mode link)**: browser composer link pushes to a live git-http-backend remote, status reaches 'synced', the child TOC carries the Project line + (N msgs), the debounced push lands `collections/`, and machine B searches A's chapters |
| K9 | Sync loop, degradation | remote down ⇒ local-only mode (mirror+index current, status names it); recovery rebuilds and pushes | `sync-remote.test.ts` degradation arc; **live r35j: link to unreachable remote, search still works, status 'local-only'** |
| K10 | Triggers fire | push scheduled after each archive (debounced); pull on first turn + pre-fork | **proven by K8's e2e run**: `collections/` reached the remote with no manual sync between fork and poll; L0 `scheduler.test.ts` + first-turn tests |
| K11 | Notice v2 | `Project:` line + per-chapter `(N msgs)`; legacy records never render a fake zero | r35j (K6, K6b); `notice.test.ts` |

Human-only rows (unchanged): sidebar visual resume, `/compact` observed in a live UI, TOC/chapter
readability judgment.

## Knowledge Transport Providers (record §15, Amendments 2026-09-21)

| # | Check | Passes when | Evidence |
|---|---|---|---|
| T1 | Seam preserves git behavior | provider selection defaults 'git' for every pre-existing record; all K1–K10 evidence still green after the refactor | full suite (276→285) with zero git-mode changes; `provider.test.ts` selection + migration rows |
| T2 | TreeDX publish/clone/search | machine A syncs (create→workspace→commit), B clones via the provider and `chapters_search` finds A's chapter through the materialized mirror | `treedx-sync.test.ts` (transport grade, stub) + **`treedx-live.test.ts` PROVEN against the real dev-auth container 2026-09-21** (born-head clone, publish→clone→search crossing, bad-token auth detail, head advance/lease reuse, binary blob round-trip) |
| T3 | Divergence & lease classes | moved head + staged work ⇒ `diverged` ⇒ rebuild-from-store republishes BOTH contributions; busy lease ⇒ bounded retry ⇒ `rejected` ⇒ pull-and-retry; failed push CLOSES its workspace (leases survive ttl otherwise — measured) | `treedx-provider.test.ts` (all three), `treedx-sync.test.ts` (rebuild converge) |
| T4 | Degradation with numbers | service down / token bad ⇒ `local-only` (offline mirror still publishes, commits, indexes, searches); `auth` detail carries the re-link instruction, never the token | `treedx-sync.test.ts` offline row; `treedx-provider.test.ts` auth row (token-sentinel absence) |
| T5 | Oversized refusal | a UTF-8 file above the service limit ⇒ refuse with the number, never truncate | `treedx-provider.test.ts` 1 MiB-413 row |
| T6 | Identity namespaces | `treedx+host/repo` key ≠ a git remote's key for the same canonical string (one pool per transport); stable across spellings (`/api/v1`, trailing slash, case) | `provider.test.ts` identity rows |
| T7 | Commands surface | `/chapters-link treedx+…` resolve-or-creates the managed repo, stores the token 0600 under the DSH home, records kind+repoId; view/status print provider + head | `link-treedx.test.ts` (5) |
| T8 | Dead-mirror self-heal | a pre-existing non-empty mirror dir (stale test residue, moved tree, abandoned pool) moves aside as `.stale-<ts>` and the clone proceeds — the old hard refusal made every later sync of an affected workspace a permanent deadlock (the r39 e2e class) | unit `sync.test.ts` self-heal row; `treedx-provider.test.ts` clone row (both providers); e2e boots now run dirty-free |
| T9 | Body-hash anchor round-trips | the frontmatter anchor hashes EXACTLY what `parseChapterFile` returns as the body (the writer appends `'\n'`; hashing bare `bodyText` made every real chapter look tampered to the enrich guard, which silently refused — host logger). Sanctioned writes preserve body bytes and re-anchor the registry's whole-file hash | unit `enrich-store.test.ts`/`enrich-wire.test.ts`; **the enrich e2e passed 2026-09-23 — the first time the ladder ever wrote through the real UI** |
| T10 | Host-plane enrichment route | `/chapters-enrich run` resolves a route from the last real tool-bearing session (`noteRoute` persists `enrichment.route`; the host has no live agent) — without it, a fork-only flow could never enrich | `enrich-wire.test.ts` + the passing enrich e2e |
| T11 | Git-plane auth honesty | a rejected credential (401/403) classifies as `auth`, never `network` — clone/pull/push carry it and the degrade-to-local-only status says `credentials rejected … re-link with /chapters-link`, not the unreachable-ghost (the TreeDX live lesson applied to git) | `git-auth-classification.test.ts` (5) over a REAL smart-HTTP remote with a token gate; classifier unit rows included |
| T12 | Corpus listing is complete | `paths/list` paginates (limit 100, base64 offset cursor) — `corpusPaths` follows `nextCursor` to the end; a second machine materializes EVERY file past a page boundary | `treedx-sync.test.ts` pagination row (150 files over the paginating stub); the live container (>100 paths) proves it at the real service |
| T13 | The human entry surface | `/chapters-link` all four modes incl. refusals (no-token non-loopback, junk target), `/chapters-status` renders each fact ONCE (a duplicate-`Provider:` line was caught here), `/chapters-enrich` verbs, legacy workspace-token migration to the DSH home (0600, old file deleted) | `link-git-commands.test.ts` (11), `token-migration.test.ts` (4) |
| COV | Both coverage ledgers are statement-grade and run | `npm run coverage:ci` — the GATED deterministic ledger (c8 over all unit+integration, `--check-coverage` at 85% statements/branches/functions/lines; enforced in hosted CI, which is GREEN end to end 2026-09-25) — currently **98.11% stmts / 86.44% branch / 93.8% funcs @ 549 tests, zero skips with the TreeDX container up** (the plans-carriage work added 80 rows and RAISED branch coverage from the 85.61% this row used to quote). `npm run coverage:e2e` — seven-project replay under E2E_COVERAGE=1; boots run lib/*.js with REAL source maps (tsconfig `sourceMap`) remapped by c8/v8-to-istanbul; first ledger **80% stmts / 62% branches / 74% funcs** — it corrected the earlier line-range estimate honestly (tools.ts 99% lines → 72% statements). The 2026-09-23 audit then closed most of that gap at the DETERMINISTIC plane: the engine's construction/listeners/degraded-summarize/plot-elicit/finalize-guard paths (`engine-lifecycle.test.ts` — real cordis `Context()`, real base engine, injected llm/tokenMeter fakes: engine.ts 40→91% stmts), every tool wrapper's success/refusal/missing-caller surface (`tools-surface` + `tools-branches` + `tools-deep-branches`), the TreeDX error taxonomy via one-shot stub faults (`treedx-provider-branches`) and parser-shape drift via injected `fetchImpl` (`treedx-parser-branches`), the local-path git transport arms (`gitops-branches`), host-command error arms (`host-command-branches`), and the pure planners (vocabulary/enrich/indexing/search/arrival/archive — `rules-vocab-branches`, `enrich-planner-branches`, `indexing-branches`, `notice-search-rules-branches`, `render-archive-ladder-branches`, `pure-branches`). It also caught one REAL bug on the way: `canonicalizeRemote` carried embedded `user:token@` credentials into the project key (pasting a remote with and without creds forked the pool — now stripped, pinned in `pure-branches.test.ts`). Gotchas pinned in the script header: c8 filters include/exclude BEFORE remapping (`--include=src/**` against lib-path profiles zeroes the report). Neither ledger alone is the claim; the e2e one makes index/render-in-browser paths that no deterministic test can see accountable |
| H1 | Corpus carries no project instructions | host-injected context (instruction files, runtime snapshot, skill catalog, our own TOC notice — event-level AND `<system-reminder>` spans inside human messages) renders as a countable `⟦omitted:host-injected …⟧` marker, never bytes; conversation survives verbatim and byte-identical | unit `injections.test.ts` (15) + `render.test.ts` rows; integration `corpus-hygiene.test.ts` (archive→sync→remote→pull→search sentinel-absence, and legacy-store-publishes-unchanged anti-migration guard); e2e stays AGENTS-BLIND (tape masking) |


## Plans Carriage (docs/plans-carriage.md, implemented 2026-10-09)

A session plan is one `tool/call` for `exit_plan_mode` whose `arguments.plan` carries the whole
markdown, answered by a `tool/result` that carries the human verdict. There is no plan document in
the log, so EVERY row below is about reading those two events the same way in three places — the
renderer, the segmentation tool, and the child's notice.

| # | Check | Passes when | Evidence |
|---|---|---|---|
| P1 | Verdict classification is right for every host shape | approved (`{approved:true}` / the fixed render text), rejected ("keep planning" + feedback), dismissed (takeover text), `failed` (the review never opened: no channel, service reloaded, outside plan mode, no `#` heading), pending (NO result event) — and a `superseded` rule that only fires for a same-title later submission | unit `plans.test.ts` (23) over fixtures copied from `@deepseek-ai/dsh-plan-mode/lib/index.js:230-289`; the pairing primitives are pinned separately in `log-shape.test.ts` (7) |
| P2 | `pending` is never printable as approval | a plan with no result renders "NO RESULT: the review was never answered"; the notice adds "do NOT implement it", and the word `approved` appears nowhere in that row | unit `plans.test.ts` + `render-plans.test.ts` + `continue-plans.test.ts`; integration notice assertion |
| P3 | Full plan bytes are retrievable | archive → the artifact file EXISTS on disk → its bytes equal the submitted plan (modulo the § 9 redaction chokepoint) → `chapters_artifact` `toc` lists the plan's own headings with line numbers and `search` reaches a phrase by SHA alone | integration `plans-carriage.test.ts` (4, real `node:fs` + real registry domain); unit `render-plans.test.ts`, `plans-engine.test.ts` (engine path parity: the same block from `buildFinalizedChapter(s)`) |
| P4 | `plan/mode` is not a silent hole | the event renders as a `mode` line, folds last-value-wins into `planMode:` frontmatter/record, and stays OUT of `unrenderedSeqs` — while an unnamed event type STILL lands there | unit `render-plans.test.ts` + `plans-engine.test.ts`; the pre-existing `render.test.ts` `mystery/event` row is unchanged |
| P5 | The plans block is MEASURED, never exempted | with the block on, the same archive REFUSES at a budget where the block-off variant passes; refusal carries both numbers | unit `continue-plans.test.ts` (the paired-measurement row); `preflight` untouched (`src/continue-core.ts:147-161`) |
| P6 | A plan above the ceiling is carried and named | `chapters_segment` returns `livePlans` (seq > `archiveCeiling`) and `modeActive`; the notice prints `NOT ARCHIVED — parent log seq N only`, and promises no artifact for bytes the store does not hold | unit `plans-tools.test.ts` (4) + `continue-plans.test.ts`; integration `plans-carriage.test.ts` (the open-review row) |
| P7 | Plan bodies obey the injection screen | a `<system-reminder>` span inside a plan is removed (countable marker upstream), while a plan that QUOTES `AGENTS.md` in prose survives verbatim — and credential patterns are redacted in BOTH the printed head and the stored blob | unit `plans.test.ts` + `render-plans.test.ts` (H1 family) |
| P8 | A plan-less path is byte-identical to pre-feature | no `## Plans in this chapter` block, no `plans:`/`planMode:` frontmatter lines, no `## Plans` in the notice, and `chapters_segment` emits no `planHint` — the whole feature is conditional on there being a plan | unit `render-plans.test.ts`, `continue-plans.test.ts`, `plans-segmentation.test.ts`, `plans-tools.test.ts`; integration `plans-carriage.test.ts` |
| P9 | Both carriage paths agree | the CONTINUATION path (`chapters_continue`) and the ENGINE path (in-place `summarize`/finalize) render the same block and the same record facts, including a verdict that lands past a composed chapter boundary — which is why `renderChapter` scans the whole event list, not its own range | unit `plans-engine.test.ts` (5) + `render-plans.test.ts`; zod round-trip of `plans`/`planMode` through the registry in `plans-engine.test.ts`, legacy rows gaining nothing |
| P10 | Artifact citations resolve wherever they were written | a chapter's `artifacts/aa/<sha>.txt` reference resolves whether the blob sits at the STORE ROOT (arrival stubs) or inside the ANCESTRY TREE (`<store>/<root>/artifacts/…`, where `writeArchive` puts deferred results and every plan) — before this fix the second form was unreadable through `chapters_artifact`, which is what "every byte remains retrievable" actually promised | `artifact-query.test.ts` rows + integration `plans-carriage.test.ts` (`resolveArtifactWithMirror` over the real tree) |
| P11 | The browser plane runs in the chain | `/plan <message>` → a real `exit_plan_mode` call → the host's review card opened and answered by a real CLICK → fork; asserts the submission's bytes are the artifact's bytes (or provably only-redacted), `planMode: inactive` from the fold, a `kind: plan` document on disk, and that the BRANCH child carries **no** `## Active plan` and no call-out while still citing the archive; plus a guard that no `compaction/*` entered the journey | `tests/e2e/plans.spec.ts` = chain project `plans` (13 s replay, no LLM; 3-entry tape). **Scope, learned at cost:** the continuation leg was REMOVED from this journey because a tape freezes the model's tool ARGUMENTS — my scripted upstream derived `chapters_continue` ranges from the ceiling the live segment tool reported while distilling (30 here), and the runner's session lands at 29, so `validateRanges` refused the stale input (correctly). A journey whose recorded request embeds a machine-specific seq cannot be hardware-neutral. Continuation semantics — `## Active plan`, `## Previous plans`, the seeded `plan/mode`, the checkpoint carry — are covered by the deterministic plane (`continue-plans`, `plans-engine`, `plan-documents`, the § 10 kernel probe) and the in-place path by the heavy/arrival/enrich/fanout journeys. Tape provenance: scripted upstream, see `tests/fixtures/model-tape/plans/PROVENANCE.md` |

| P23 | **Retired in 0.1.17 with the legacy copy** (support floor 0.2.0): `installChaptersPreset` and `presets/chapters/` are deleted, so there is no installed file set to half-delete. The key is ACCEPTED-and-inert since 0.1.18 — removing it would make an existing profile patch fail to parse, and a bundle that will not mount is worse than a key that does nothing | see P24 |
| P24 | The preset is a **visible declaration row**, and the row composes on every host in range | `preset-chapters` is inserted by our own `cordis.patch.yml` with the preset definition in its `config`, mounted by `@treeseed/dsh-chapters/preset` (`src/preset.ts`) — the visible Loader entry the host's own presets are, overridable and `disabled`-able from a profile patch, with the registration's lifetime yielded to Cordis (an `apply()`-scoped disposer un-registered it: measured as `register()` succeeding with the roster WITHOUT `chapters`). Rows the host cannot import are dropped and NAMED, because one unresolvable child makes the whole preset `broken` | 15 rows in `preset-declaration.test.ts`, **each verified to fail on the mutation it guards** (ralph re-disabled, an unknown pruner key, `toolFilter` restored, `{{cwd}}` restored, the durable id renamed) — plus real boots of the packed tarball on 0.2.0-rc.2 (`roster: present`, `inventoryRows: 28`, `unusableRows: []`, tool-schedule pruned), 0.2.1-alpha.4 (`registered`, `inventoryRows: 29`, nothing pruned) and 0.1.5-rc.1 (boots; the row says the host cannot register rows) |
| P21 | The continuation has a **human-pulled door**, and the two doors cannot drift | `/chapters-continue` = `deterministicCommand({intent:'continue'})`, the same builder as `/chapters-fork`; only name/verbs/intent/no-directive prose differ; archive semantics identical (everything since the watermark). CLIENT SIDE, same discipline: the assistant row registers both doors from ONE runner (`src/client/doors.ts` `makeDoorRunner` + a two-row `DOOR_ACTIONS` table) — a composer-only continue left the user with a created child and no affordance | unit `continue-command.test.ts` (7 rows) incl. the **no-drift row**: same events in ⇒ same ranges, titles and plan facts out of both doors; the no-plan case, the refusal naming its own door, and approved ⇒ NOT seeded vs still-planning ⇒ seeded `['user/message','plan/mode']`. Unit `client-doors.test.ts` (7 rows) pins the two client rows (distinct id/order/label/command, the fork label frozen for the specs), that ONE child-id regex parses BOTH door wordings, that both rows fire their own command through the same body, and — by reading the server's own templates — that the reply wording the client parses is still what `deterministicCommand` emits. Browser: project `fork` asserts BOTH buttons render |
| P22 | The continuation shape is covered **in the browser**, on every push | the leg that a tape could not carry (§ 15) is back, driven by the command — no model request, no frozen `endSeq`; asserted from the child's durable log without switching the UI: `## Active plan`, the operative plan by title with its real verdict, `plan document:` and `chapters_artifact` citations, `## Finding things`, no seeded gate after approval, exactly one synthetic notice (invariant 2) | `tests/e2e/plans.spec.ts` project `plans` — replays in ~14 s with no LLM/GPU, eight-project chain green |
| P18 | Search answers **without a pool linked** — the findability audit | `buildLocalCorpus` walks the workspace store (chapters, `kind: plan` documents, rules) and answers through the SAME scorer as the mirror door (`rankEntries`), so ranking cannot drift between doors; artifacts are deliberately not indexed (they answer to `chapters_artifact`); the answer names its door ("searched this machine's store, N docs, no pool mirror") so a session never reads *this machine only* as *the whole project*; "nothing matched" (`documents>0`) is distinguished from "nothing here" (`empty`); a pool miss falls back to the local store before answering empty | unit `local-corpus.test.ts` (5) + integration `find-without-a-pool.test.ts` through the real tool wrapper — the empty answer used to be born in the wrapper, not the pure function |
| P19 | A child is TOLD the lookup verbs | the notice gains a three-line `## Finding things` naming `read` (chapters), `chapters_artifact` (deferred blobs, path or bare sha) and `chapters_search` (everything else), plus the one fact a model cannot infer — that plans are searchable **as plans** (`kind: plan`) and rules arrive from other machines; `retrievalHints` (default on) off ⇒ the notice is byte-identical to the previous shape | unit rows in `find-without-a-pool.test.ts` (on/off goldens); measured that NO committed tape prefix contains a seeded notice, so the change costs no re-record, and the eight-project chain replays green |
| P20 | Kernel-drift gate on the seeded continuation | the seed depends on two host facts: `plan/mode` is a KNOWN event type and is NOT surface-eligible. Read from the kernel's OWN exported predicates (`KNOWN_SESSION_EVENT_TYPES`, `isSurfaceEligibleType`, `isAppendSurfaceEvent`, `adoptSessionEvent`) rather than reimplemented, so the gate fails on a change of kernel INTENT, not on refactoring. Without it, a host upgrade turns a gated child into an ungated one with every existing test still green | unit `host-seed-contract.test.ts` (4 rows, 0 skips against the pinned host; skips loudly naming the missing package if the host is absent) |
| P12 | A plan is queryable AS a plan | each submission becomes its own `kind: plan` document in the same tree, so pool transport, mirror rehydrate and the corpus index carry it unchanged; `loadCorpus` keeps the file's own kind instead of flattening it to the directory's; `chapters_search` answers a plan query with the plan | unit `plan-documents.test.ts` (5) + integration row in `plans-carriage.test.ts` (asserts the published path, the indexed kind and the search hit) |
| P13 | Plan numbering never touches chapter numbering | plans allocate through their own registry counter (`nextPlanNumber` / `reservePlan`, attempt-keyed, idempotent under retry); a chapter number is never consumed, and names come from the registry rather than a directory scan so siblings cannot collide | unit `plan-documents.test.ts` (counters, retry reuse, writer-without-plan-allocation stays additive) |
| P14 | A directive is never annotated, and superseding never overwrites | enrichment skips any document whose own frontmatter says `kind: plan` (a rename cannot disarm it); a revised plan leaves the earlier document's bytes intact and both stand in the store | unit `enrich-plan-documents.test.ts` (3) + integration evolution row |
| P15 | Plan mode survives a continuation only when it should | seeded `plan/mode` ONLY for `intent: 'continue'` while the fold says active (measured: kernel accepts the two-event seed, host projection folds it to `active:true`, one-event control does not); never for a branch, never after an approval — because approving a plan EXITS plan mode | unit `continue-plans.test.ts` (four rows: seed shape, approved-no-seed, branch-no-seed, `planSeedMode:false`) against the installed-kernel probe recorded in docs/plans-carriage.md § 10 |
| P16 | The notice reads the intent, not just the log | continuation → `## Active plan` + `## Previous plans on this path` (marked history); branch → zero bytes, plans live in the cited chapters and as documents; the mode statement is either "the directive above is live" or "this child starts OUTSIDE plan mode", never both | unit `plans.test.ts` (seeded/unseeded/branch rows) |
| P17 | The one injection-screen exception is named, not open-ended | `kind:'plugin' + plugin:'plan-mode' + form:'notice'` archives verbatim; any other plugin notice, snapshot or instruction shape still screens; `isHumanAuthored` (which drives topic signatures and `(N msgs)`) is unchanged | unit `injections.test.ts` (two rows, incl. wrong-form and wrong-plugin negatives) |
## Two-Tier Rules — SPEC (record §7.1, §7.3–§7.9; issue #50)

**Nothing below is verified yet.** This is the checklist written ahead of the code, docs-first, so
that each row can be proven to fail on the mutation it guards before anyone calls it a fact. The
P3 rows above stay the shipped-behavior record; these extend it with the session tier.

| # | Claim to be proven | What makes it true | How it is witnessed |
|---|---|---|---|
| R1 | A rule survives an in-place compaction | `rulesCarry` is the third lead section in `planSummarize`, on BOTH the composed and legacy paths, beside `planCarry`/`plot` | unit over a real `summarize()` input; assertion on the checkpoint text itself, not on a mock — this row is the reason the round exists |
| R2 | Continue carries both tiers; fork carries project only | `intent` filtering at the four door sites, one helper | the existing "both doors archive identically" row must still pass (same ranges, titles, plan facts) while the rules bytes DIFFER — that asymmetry is the guard |
| R3 | `ADD RULE:` is deterministic and free | parse at the existing `turn/end` listener; no model call on the path | unit + a row that fails if any model token is spent (the meter is never exempted — same doctrine as plans carriage) |
| R4 | Session rules never reach the pool | one filter in `planStoreToRepo` | integration over a real git remote **and** the TreeDX stub, two machines: machine B sees the file list without session paths |
| R5 | A model-derived rule activates only on a verbatim quote | `derivedFrom: model` + quote match against human bytes in the archived span | unit rows in both directions: quoted ⇒ active, inferred ⇒ `proposed` and renders nothing |
| R6 | Selection is deterministic and announced | pure function of (files, stored topics, caps) — no clock, no readdir order | two runs with shuffled input order byte-identical; withheld line present whenever `shown < active`, including `withheld: 0` |
| R7 | Empty ruleset ⇒ zero bytes | `kind:'none'` short-circuit retained on the checkpoint path too | golden row; and the tape chain replays without re-recording for the notice-side change (measured license) with **one** re-record paid for the new tool schema |
| R8 | Ungoverned never looks like governed | the zero-rules line names `projectKeySource` + the remote/path used | unit rows for all four divergences of record §7.8 (path-derived, fork-listed-first, TreeDX-keyed, unlinked) |
| R9 | A conflict is reported, never resolved | `/chapters-rule conflicts` writes nothing | unit: rule file bytes + `sha256` unchanged after the call; refusal path covered |
| R10 | Session loss is re-derivation, not corruption | marker rules replay off the durable log | integration: wipe the store, replay the parser over the log, same rule set (the enrichment half re-runs through the existing ladder) |

## The Cache Metric, Before You Trust a Number

`usage.inputTokens` is the **uncached delta** and `usage.cacheReadTokens` is the cached prefix, so:

```
totalPrompt = inputTokens + cacheReadTokens
hitRate     = cacheReadTokens / totalPrompt          // NOT cacheRead / input
```

Dividing by the delta yields nonsense like 1721% — which these notes actually did before it was caught.
For "the parent's cache is undisturbed" (G2), assert **`cacheReadTokens` does not collapse**. Do *not*
assert that hit percentage stays flat: it falls innocently every time the prompt grows past a cache-block
boundary while the prefix is fully retained. Measured steady state on this harness: 396,800 cached + 822
uncached, **99.79%**.

## Engine-Path Checks (Phase 0b delta)

For the `ChaptersCompactionEngine` path (in-place compaction, no new session). Rounds 12/13/17 already
proved the *mechanism* offline (durable records, zero usage, realm dispatch — see
[spikes/probe/FINDINGS.md](../spikes/probe/FINDINGS.md) § Phase 0b); these are the product-level checks
that still need a running chapter engine:

| # | Check | Passes when |
|---|---|---|
| E1 | Zero-inference summarization | the `compaction/summary` event carries **no `usage` field** and no provider call appears in the round (proved with a stub at r12/r13; must re-prove with the real TOC `summarize()`) |
| E2 | Archive honesty after automatic compaction | every `shadowedSeq` of a landed compaction resolves (via durable log + `sourceEventSeqs`) into a written chapter file whose hash matches the registry |
| E3 | Header cache across a compaction — **CLOSED by r23 (measured, per-machine)** | cloud: `cacheReadTokens` held at **7,424 on both post-replacement turns** while uncached refill fell 13,658 → ~7,000. Local llama.cpp (r28-era probes): reuses NOTHING across a head replacement (0 cached) but steady-state turns cost only the new content. **Never quote one machine's number for the other.** |
| E2E-TAPE | Acceptance without the GPU | `test:e2e:replay` serves every model turn from `var/model-tape/<project>` (isolated per boot) (proxy smoke: exact + prefix hit, loud 503 miss with journal). Usage fields ride the tape, so the token meter and compaction thresholds fire at identical steps under replay. Tapes are committed test DATA under `tests/fixtures/model-tape/` (the rest of `var/` stays ignored) — CI replays them via `scripts/ci-replay.sh` with no local model; regenerate via `test:e2e:record` (local GPU) when PRODUCT prompts change. The local model remains the distiller and ultimate witness. STATUS 2026-09-23: pipeline current (escape/whitespace classes, volatile rules incl. HOSTPORT-BLIND + derived-count collapses for `(N est tokens)` and host-injected char counts, tool bytes matched out); SEVEN-project replay chain (suite, fanout, heavy, arrival, enrich, rules, fork). Doc edits are ALWAYS free (user decision 2026-10-01, no exceptions): the tapes stand in for ANOTHER project — injected doc bytes are masked from matching, and compaction summaries that paraphrase doc prose ride the tape as recorded model output, so no doc edit ever requires a re-record. The e2e is the integration witness that the deterministic layers cannot replace — it found two real product bugs (the enrich body-hash anchor mismatch and the missing host-plane route) that had been invisible behind the host logger |
| E9 | P2 enrichment + vocabulary, two-machine grade | `node --test tests/integration/two-machine-enrich.test.ts` + `--project=enrich` tape replay | **green 2026-09-20** — enriched frontmatter/provenance cross the pool byte-exact; B honors A’s aliases and dedupes its own vocab pass; caught+fixed r37 (modifications invisible to commits). Four-project replay chain green, 0 misses |
| CACHE | **Cache hit rates rise over time; nothing poisons the prefix silently** | Three nets, all born of the 2026-09-25 machine deep-dive (user report: "hit rates FALL over time"). The decoded truth — timeline first, because the first attribution got it wrong twice: a parent session's provider cacheRead rode 11,386→29,656 (hit .997) for seven warm requests, then COLLAPSED to a pinned 9,613 at request seq 78 — BEFORE any compaction event (those land at seq 105). Cause: KV-CAPACITY EVICTION — parent + three fan-out children + a live agent session sharing one 65,536-token llama.cpp pool (total_slots 1 per /props); prefix lookup kept doing exactly its job, returning the shared 9,613-token header for every divergent chain. The engine's pressure compaction then fired CORRECTLY at the meter's number (~66,700 ≥ 0.9×64,000) — the meter is provider baseline + 4-chars/token estimate of content added since the last request, so its trigger point is invisible in provider usage numbers (29,656 looked early; it was not). After the children quiesced the parent RE-WARMED (req 121: read 21,969, hit .97). **Deterministic net 1**: `tape-prefix-stability.test.ts` — every mid-chain tape request must extend its predecessor byte-for-byte (only the two documented replacement points may break a chain); message mutation mid-session — the general cache-poison class — fails this ledger with the offending entry; all seven projects pass. **Deterministic net 2**: `context-hygiene.test.ts` — no context-window literal may ship in src/ or presets/, no preset may pin a window key: the threshold math (floor(configured window × ratio)) can only follow adapter config. **Physical net** (opt-in, live): `npm run test:e2e:cache` serial — asserts the warm curve (no collapse <50% of best cacheRead, ≥50% of prompt growth landing cached, final hit ≥0.90, no compaction in-window; full ledger on failure; first run: 0%→99.7% monotonic). `E2E_CACHE_CONCURRENCY=N` adds N-1 live tenant chains firing per round — VALIDATED at CONCUR=3 (17.6 min): the probe chain still finished hit 0.997 with zero tenant errors, while the interleaved tenants showed the textbook capacity signature the user's log had (cacheRead pinned at 9,617, hit ~0.50 when their turns alternated on the single slot, recovering to 0.998 the moment they got two contiguous turns). Proves the collapse is capacity/interleaving, not the plugin: the same server, same slot, a chain left alone still warms to .997; pass measures this server holding N warm chains, pinned-header/queue-starvation measures the capacity cliff; run it while your own agent sessions are few, and read the ledger SHAPE (collapse-and-stay vs flat-pin vs dip-and-recover) before believing any single attribution | Host-capacity epilogue (2026-09-26, measured on the dev box): single-slot llama.cpp pins interleaved chains to the shared-prefix LCP (9,617 tokens in every experiment); unified KV (--kv-unified, auto slots) crashed b10920 on hybrid-GDN models (Qwen3-Next class; llama.cpp #23210/#21401) — RETESTED WINNING on b11176 (2026-09-27): contention probe CONCUR=3 passed, every chain at 0.997-0.998 with tails restoring one turn after a collision, zero crashes; keep auto slots (1), never force N_PARALLEL>1, re-run scripts/prefix-swap-test.mjs + the contention probe after any image upgrade — one trap measured: LLAMA_ARG_CTX_CHECKPOINTS=0 looks like a saving (upstream invalidates them for the recurrent layers) but on b10920 it deletes ALL cross-request prefix reuse (cached_tokens flat 0); keep the default 32 |
| E2E | The fork BUTTON, browser journey | **green (2026-09-19, 7 specs / three projects — suite@0.75-of-32K + heavy@0.5-floor-off + arrival@0.9-floor-500 — on port-keyed throwaway homes)**: specs CREATE their sessions through the UI ('New session' + one real Local-model turn; turn-complete = the session's OWN `turn/end` in its own log — the global registry count false-passed twice and was retired). Fixture-free by design after the R29-era rows aged out of the 90-session sidebar. The suite also caught the 'Internal Testing Notice' focus trap and the re-link origin bug (see FINDINGS). |
| E10 | P3 rules lifecycle (record §7) | unit (status resolution, budget refusal, golden absent-notice bytes) + transport (three machines over a real pool) + e2e `rules` project replay | proposed everywhere by default; per-machine core facts; verbatim in the child's OWN log after UI approve; overflow refuses with per-rule numbers — **green 2026-09-20 at unit/transport grade** (three machines over a real pool; exit criterion covered); the `rules` browser scenario parked out of the default chain pending the r39 diagnosis — evidence-preservation first |
| E2E-EDGE | Oversized turn handled gracefully | **green in the heavy project (captures 5.3–13.2m; run 11: 5 crossings, 27.8m; 6.0m suite pass)**: one browser turn reads 700KB range-by-range and crosses the threshold 5×: every mid-turn compaction commits (provider `dsh-chapters`, zero usage), every shadowed seq is chapter-covered, the pre-compaction marker survives in the transcript, the turn completes, and the follow-up turn answers — fork row reappears after settle (observed). The model's plan erosion under heavy trims is the fork's motivation; FINDINGS records it. |
| E4 | Pruner composition | with `tool-result-pruner` mounted in the realm, a chapter covering a pruned result still renders the ORIGINAL text (follow `sourceEventSeqs` backwards), plus the model's inline override where requested |
| E5 | Shrink-floor refusal is loud | a region too small to yield a smaller framed TOC fails with `ManualCompactionError code='summary'` and changes no surface (r12 behavior; keep as regression) |
| E6 | Automatic timing inherits the host's |
| E7 | Arrival-time artifacting (architecture amendment) | **green 2026-09-19 (9.3m)**: 373KB book / one read → exactly 1 arrival prune at the tail; model answers buried token + chapter count via 5 `chapters_artifact` calls; ZERO compaction events at production 0.9; blob fingerprint in no `request/*` event; cache table in FINDINGS shows prefix intact (cacheRead monotonically 15.7K→24.5K) |
| E8 | Plot carriage across in-place checkpoints | forward path live (persona discipline — suiteB oversized run carries `PLOT:` blocks through 7 compactions); render→extract round trip pinned in unit (`carried plot survives the checkpoint round-trip`); elicited fallback unit-pinned (capped input/output, degrades to null) — fires only when the agent writes no note | compaction lands at `agent/pre-step`, bracketed `compaction/start.turn` = open turn number (r13/r17 `turn: 2`); never mid-request, never mid-step |

## Bug Reports

Cache and context behaviour are the plugin's core promise, so a report must include:

- parent session id, child session id, root session id, store directory, archive ceiling
- chapter paths written, and any artifact references
- `usage.cacheReadTokens` for the parent's steps immediately before and after, plus the child's first two
  steps — **and the process generation (which restart) each was taken in**
- **first-request token counts for both sessions** — the single most diagnostic number, since a silently
  re-seeded child is the most damaging regression
- the ranges supplied and the refusal text, if a preflight rejected the attempt

## The first real-remote push (manual, one-time per project)

The sync loop is integration-tested against a fake driver that models the git
semantics it relies on; the wire protocol itself is isomorphic-git's (https only
— isomorphic-git 1.42 registers no `file://` transport, verified against its
transport registry). The first push against a real remote is therefore a
**manual, one-time step per project**:

1. Create a **private** empty repo (record §2.1: per-project, user-created) and a
   scoped token for it (fine-grained PAT limited to that repo).
2. In a Chapters session: `/chapters-link https://… <token>`.
   The token is stored 0600 at `.dsh-chapters/.git-auth/<projectKey>`.
3. The command reports the sync steps; on `push rejected`, re-run
   `/chapters-link` (pull-retry) or wait for the next archive event.

If isomorphic-git ever chokes on a specific forge's smart-HTTP, the documented
fallback is a CLI driver (the `GitDriver` seam in `src/gitops.ts` exists for
exactly this swap) — the loop's logic is driver-agnostic by design.
