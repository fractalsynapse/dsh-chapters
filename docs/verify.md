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
## Repair (#60) — recovering an archive from the durable log

| # | Claim | Procedure | Status 2026-10-22 |
|---|---|---|---|
| R1 | The auditor finds the measured damage | `node scripts/chapters-repair.mjs --home <lab> --project <cwd> --cwd-override <lab-tree>` on a COPY of SAIP's live registry + store + 26 session logs | **PASS** — 436 findings: hollow 5, empty-artifact 335, never-archived-span 19, unregistered-file 73, ghost manifest 2, stuck reservation 2. Matches the manual audit exactly. |
| R2 | A repair re-derives lost knowledge | apply, then grep for three phrases that previously matched 0 files | **PASS** — span 5265-5467 (the "foundational to the project" hosting brief) is now in `chapters/030-hosting-…-plan-1.md`; 719 moves across 3 passes |
| R3 | Repair converges (idempotent) | run apply again; the third pass must move 0 | **PASS** — pass 3 = 0 moves; audit falls 436 → 3 findings |
| R4 | What it will NOT do | 3 files remain: two `015-*.md` claiming one number. Re-registering needs a new number = renumbering a chapter → refused, with the reason printed | **PASS** — residue is a human decision, reported as such, not silently "fixed" |
| R5 | Nothing is deleted or rewritten | after a full apply, the husk files still exist (copied to `.repair-quarantine/`), the registry keeps every record (append-only), and the log's md5 is unchanged | **PASS** |
| R6 | The run is reversible | `restoreRepair` walks the journal backwards; new files return from quarantine | **PASS** — `tests/integration/repair-apply.test.ts` |
| R7 | Dry-run is genuinely read-only | registry bytes and directory listing identical before/after | **PASS** — pinned by a row |
| R8 | LIVE application | `~/.dsh` is read-only to the agent sandbox (EROFS), so SAIP and this repo have NOT been repaired for real | **BLOCKED on the user**: run `node scripts/chapters-repair.mjs --project /home/adrian/Projects/saip --apply all --yes` yourself, or approve the sandbox |

Known limitation, stated rather than hidden: an audit through `ctx.fs` cannot list a directory, so it
reports `blindSpots: ['orphan-file','test-litter']`; the offline script has `readdir` and sees them.

## Two-Tier Rules — SPEC (record §7.1, §7.3–§7.9; issue #50)

Rows **R1–R10 verified 2026-10-20** except **R-e2e**, which this host cannot run (see the last row
and §13 P3c). Each row below was written docs-first and then proven to fail on the mutation it
guards — the mutation runs are named per row so a future reader can repeat them. The P3 rows above
stay the shipped-behavior record; these extend it with the session tier.

| # | Claim | Status | How it is witnessed (and the mutation that proves it) |
|---|---|---|---|
| R0 | The empty tier still renders **zero bytes**, and the pre-#50 option shape renders **byte-identically** to the previous builder | ✅ verified | The golden literal was captured by running **HEAD's** `buildRulesSection` over the same fixture and diffing it against the new one (text-equal, kind-equal, only the non-rendered `withheld` field added). On the checkpoint path an empty set asserts neither header nor announcement appears |
| R1 | A rule survives an in-place compaction | ✅ verified | `rules-checkpoint.test.ts` drives the **REAL realm engine** through `summarize()` and reads the text that would be prefilled next: project rule + session rule verbatim, project before session (positional precedence); a parent's rule rides the child's checkpoint (R1b — the tier binds the TREE); over budget the omission is announced. Mutation: dropping `rulesSection` from `leadSections` breaks 3 of 4 rows |
| R2 | `chapters_continue` carries both tiers; `chapters_fork` carries project and **zero session bytes** | ✅ verified | `rules-doors.test.ts` asserts the asymmetry through the shared renderer, and a **source-shape row** fails if `tools.ts` or `engine.ts` calls `buildRulesSection` directly — two rule-pickers would drift apart invisibly (the same argument that pins `rankEntries` and `doors.ts`) |
| R3 | `ADD RULE:` is deterministic and free | ✅ verified | `session-rules.test.ts` (8 rows): line-start-only, minimum length, dedupe; the two injection screens (`isHumanAuthored`, `stripReminderSpans`) each with a positive and a negative; assistant-restatement never captures (the amplification path); idempotent across repeated turn/ends; numbers honor registry **and** disk; §9 credential screen; listener containment (disabled / missing cwd / throwing store). The module holds no `ctx.llm` reference at all |
| R4 | Session rules never reach the shared pool, on **either** provider | ✅ verified | `rules-transport.test.ts`: a real git pool (A stages project only, B pulls and never sees the session file, A still renders it locally — exclusion ≠ invisibility) and the TreeDX stub's commit tree. Mutation: deleting the single `isSessionRuleFile` skip reddens both |
| R5 | Mined rules are governed by **policy**, not by proof that a human said them, and each one carries its **warrant** (§7.5, Amendment 2026-10-21) | ✅ verified | `rules-mining.test.ts` (20 rows): `rules` is OPTIONAL so the old three-field answer still validates; bounds (≤3 **written** per chapter, sub-minimum dropped, a garbage `rules` value cannot cost the annotation); the quote check is a LABEL — `stated` when the chapter's human bytes contain it, `inferred` when they don't, and BOTH govern under the default `rulesAutoActivate: true`; the row named "THE REVERSAL, PINNED" asserts exactly that, and the rendered head shows `inferred from ch.N — nobody said it` beside the text with the agent required to name the rules it applied; `autoActivate: false` writes `reviewOnly: true` and renders NOTHING until `approve` (a curation fact — the write-once file is byte-compared unchanged); assistant prose is inadmissible even as a label; ladder rows prove human-bytes-only evidence, mining before the hash-guarded write, `rulesEnrichment: false` logging the drop, an unwired plane WARNING, a throwing sink not losing the annotation, and `rulesModel` making a second call on its own route whose answer replaces the annotation pass's; `/chapters-rule active` prints the posture and the inferred count. Mutations: predicate ignoring `reviewOnly` → 2 rows; `autoActivate` ignored → 2; `rulesModel` ignored → 2; basis classification collapsed → 1 |
| R6 | Selection is deterministic and announced | ✅ verified | Shuffled input order yields byte-identical selection; two identical runs render identical text; the withheld line appears exactly when `shown < active`, and its ABSENCE is asserted when no cap is set. `active`/`chapters_rules` return the counts even when nothing was withheld, so "you are seeing all of it" is a fact |
| R7 | Nothing was silently clipped anywhere the budget bites | ✅ verified | Token ceiling still returns `refusal` with per-rule numbers and now counts **both** tiers; the checkpoint announces the omission instead of squeezing; the door path still refuses the continuation with numbers (§1.2) |
| R8 | Ungoverned never looks like governed | ✅ verified | `/chapters-status` prints an `Identity:` line with the divergence warning — and this repo's own non-git test workspace hit that branch during verification, which is the honest evidence the warning is not theoretical; `chapters_rules` answers "no linked project" separately from "nothing approved on this machine" separately from "nothing captured this session"; the head states the zero-project tier only when session rules are actually governing it |
| R10 | Every chapters session — fresh, continued, or DELEGATED — is told to use `chapters_rules` and `chapters_search` | persona row parsed from the shipped patch: the suffix names both tools, names delegation, keeps the `PLOT:` discipline, adds no unregistered prompt variable, and remains matched by the plot template-echo guard. Verified by mutation — dropping `chapters_rules` from the suffix reddens the row |
| R11 | Rule ancestry crosses the delegation edge, and every door uses the ONE walk | `tests/unit/rules-lineage.test.ts` (8 rows: header-only parent, transitive mixed edges, one-way direction, cycle termination, the 64-expansion cap with its loud flag, unknown session, throwing reader, anti-drift). Verified by mutation: disabling the header edge reddens 4 rows |
| R9 | A conflict is reported, never resolved | ✅ verified | `conflicts` wrote no file (directory listing asserted unchanged), the prompt explicitly forbids rewriting, and with no conversation route the verb refuses rather than half-answering |
| R10 | Losing a checkout is re-derivation, not corruption | 🟡 partial | `parseRuleMarkers` is deterministic over message text and capture dedupes against disk, so a replay fills gaps without duplicating — but the **end-to-end wipe-and-replay row is not written**. The mining half is now re-derivable by re-running the ladder, and capture dedupes against disk, so a replay fills gaps rather than duplicating. |
| R-e2e | The browser plane: a live model, the `rules` journey, the new tool in the header | ❌ cannot run on this host | `npm run test:e2e:replay` **refuses by name** (`tests/e2e/boot.ts:130`: the pinned host predates preset declaration rows). The re-record this feature owes is queued with the `dev/dsh-host-lock` move in `docs/backlog.md` — stated, not skipped silently |

**First live witness (2026-10-21, `npm run mining:probe`).** Three real archived chapters of this repo,
mined by `qwen3.8-flash` — the model that powers live sessions here — through the shipped code paths
(`buildMineInput` → `parseMinedRules` → `quoteIsHuman` → `captureMinedRules`), local :8080 down so the
token-plan hosted route was used. Nine rules captured (the 3-per-chapter cap bound every chapter),
**6 stated / 3 inferred**, and all three inferences came from the one chapter with ZERO human bytes —
a subagent chapter — which is exactly what the classification should do. The model's own `basis` claim
was the weaker signal: chapters 2 and 3 each declared only 1 stated rule, while the plugin's check
found 3/3 quotes genuinely present in the human text. So the label is earned from evidence, not from
the model's say-so, and the head rendered all nine in 479 tokens with nothing withheld at a cap of 12.
On quality: none of the nine was wrong or unsafe; the three inferences were arguably the most
transferable ("verify decisive architectural claims in shipped code before treating them as settled").
n = 3 chapters on one repo's own history is not proof, but it is no longer nothing.

**A cost finding, stated twice because the first version was wrong.** The probe reported completion
usage of 969–3237 tokens against a 700-token request. The inference I drew — that the annotation
ceiling was truncating mining — was **wrong**: a direct test of the same route with a 64-token cap
still produced 113 tokens with `finish_reason: stop`, and usage itemizes
`completion_tokens_details.reasoning_tokens`. `max_tokens` is advisory on this provider, not
enforced, and reasoning counts toward completion usage. So nothing was truncating; what was true is
that the ceiling had no business being a literal at three call sites (900/900/600) sized for
pre-mining answers. It is now `enrichmentMaxTokens`, default **4000** — above the observed 3.2K —
because a *strict* provider would enforce it, and one that itemizes reasoning deserves a budget that
covers the thinking. The lesson stays worth recording: a usage number is not evidence about a
mechanism until the mechanism is tested directly.

**Inference QUALITY had no witness when the posture was set; the first data is below and it is thin.** The mechanisms are proven against fixtures; nothing here can say how often a small model infers a *correct* standing order, now that inferences govern by default. That is the open risk of the 2026-10-21 decision, and the measured first step is cheap: point the enrichment route at a reachable model, run `/chapters-enrich run` over real archives, then read the `stated` vs `inferred` ratio in `/chapters-rule list --scope session`. If inferences are wrong more often than a human catches them in replies, the answer is `rulesAutoActivate: false` — not a new evidence gate (the amendment records why the gate was the wrong instrument). The box's GPU driver was unreachable when this landed (`nvidia-smi` cannot talk to it), so no vLLM boot and no real mining pass ran.

**Two environmental facts, learned the hard way on 2026-10-20 and worth repeating.** (1) The
deterministic suites need **Node ≥ 24** (`package.json` engines); on Node 22 every test file fails
with `ERR_NO_TYPESCRIPT`/unknown-extension, which looks exactly like a broken change and is not one.
(2) Under `npm run coverage:ci`'s parallel load the real-HTTP-git files
(`git-auth-classification`, `sync-remote`) intermittently failed with an EPIPE blamed on their
`before` hook. It was **recorded as a box-level flake and left alone — which was the wrong call**: the
"prove it predates my diff" step was right, and stopping there was not. The cause was real and is now
fixed in the rig: the test git server wrote each request body into a CGI child's `stdin` with **no
error listener**, so a child that had already exited raised an async EPIPE with no handler, which the
runner reported as uncaughtException after the test ended. Guards now sit on the child's three
streams and on both request/response objects ([tests/integration/http-git-server.ts](http-git-server.ts));
three consecutive combined runs since then are 800 pass / 0 fail. Lesson for the next agent, in the
repo's own style: a pre-existing failure is still a failure.
Ledger on this branch: **93.16% statements / 85.53% branches / 90.01% functions** — the gate holds.

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

## Door 5 — Subagent Settlement (#47; read contract corrected by #58)

The settlement door is the only archive that runs with nobody watching, so its checks are about **payload**,
not about plumbing. Every row here was verified to fail on the mutation it guards.

| # | Check | How to verify |
|---|---|---|
| S1 | The durable read is payload-bearing | `tests/unit/host-durable-read.test.ts` reads the **host's own published types** and asserts `SessionEventRecord` has no `data` key while `readSession`/`snapshotSessionEvent` yields one. This is a kernel-drift gate: a host rename must turn it red, not re-create husks. Cross-check by hand: `zstd -dc ~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd \| head -20` for a settled child — the real log has `data.name`, `data.arguments`, `data.message.content`; a hollow chapter has none of them. |
| S2 | Both arms, both modes | A **one-shot** child settles with a live handle (`snapshotEvents()`); a **continuable** child is disposed *before* `subagent/end` (`dsh-subagent/lib/index.js:1240-1250`) so only the durable arm runs. Integration rows cover each arm × each mode, and one covers **depth 2** (a continuation child that delegates — `d57b4710`'s parent is `ch-dc3be3ab` in the SAIP field data). |
| S3 | No archive that rendered nothing | Feed the real `data`-less record shape to `saveSession` and assert: skipped `payloadless`, **no file written**, **no chapter number reserved**, `nextChapterNumber` unchanged. Then the converse pair: the same span read through `readSession` archives with `stats.messages > 0`. |
| S4 | The watermark is never poisoned | After a S3 refusal, a later settle of the same child still archives (i.e. `max(endSeq)` did not advance). This is the property that makes the defect recoverable instead of permanent. |
| S5 | Warnings survive the door | `writeArchive` emits `N event(s) rendered no output` for a low-content chapter; assert door 5 logs it (via the injected `warn`/sink), not returns-and-drops. |
| S6 | Lineage recorded, tree NOT re-homed | After a settle the child's own row/frontmatter carry `subagent` + `parentSession` from the durable header, and the child keeps its OWN tree: `rootSession` is unchanged and its chapter paths still resolve. **AMENDED 2026-10-22 (#58):** this row originally demanded `linkChild` onto the parent's path. Measured against the code, that buys no reach (`buildIndex` walks ancestors only) and re-homes files already written under the child's root, so the door does not link; the row now pins the absence, and `subagent-auto-save.test.ts` ("lineage by design") holds both halves. |
| S7 | Fanout containment | A 10-child fanout schedules sync 10× and runs enrichment **0** times (`runNow` never per settlement) and no child blocks another (per-child promise chains). |
| S8 | Field census (human, one-time) | `SELECT` the store: no chapter may have `messages === 0` with `events > 0`. The recovery half of this defect is #60; measure **before/after counts** there, and quote them as a repair result, never as a passing test. |

**Anti-pattern that created this section:** a stub that returns *your* type instead of the host's.
`tests/integration/subagent-auto-save.test.ts` once faked `listEvents: async () => durable` with full
events and passed against a host verb that returns metadata. If a test proves a door works while the
production arm returns a different shape, the test is the bug.

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

## Prompt recommendations (#71) — SPEC + verification rows

Interface: site §28 (`concepts/prompt-recommendations`); host facts in `docs/contract.md`
§ Composer Ghost Layer. Off by default — **the effective model string non-empty IS the
enable**; there is deliberately no second boolean.

Deterministic rows (each must be proven to fail on the mutation it guards):

| Row | Pins |
|---|---|
| enable derivation | `effectiveModel = setting('prompt.model') ?? config.promptModel`; empty or unset ⇒ OFF, and a stored empty override beats a non-empty config (`off` verb) |
| input assembly | chapter summaries first, then the live tail; total ≤ `promptContextChars`; host-injected spans defused BEFORE the cap; deterministic order (same input ⇒ same bytes) |
| answer validation | trim → reject empty → reject > `promptMaxChars` → ONE retry with the cap restated → refuse with the measured length. Never truncate |
| cache & watermark | one entry per session keyed by the last completed `turn/end` seq; fresh hit ⇒ zero llm calls; new turn ⇒ recompute on next ask; in-flight dedup shares one promise |
| command arms | `model` show/set/clear texts, `off`, `suggest` refusals (off / no route / not computable / model failure) each name their remedy |
| status line | `/chapters-status` prints ON with the model + source, or OFF — both states, linked store or not |
| client pure logic | `shouldShowGhost` matrix: enabled ∧ !running ∧ draft==='' ∧ hasText ∧ !suppressed/boundary; accept ⇒ setDraft; typing ⇒ hidden; Esc ⇒ suppressed until the boundary moves |
| client anti-dup | `src/client/index.ts` contains no `commands.execute` for the ghost either — the wire body lives in `src/client/prompt-ghost.ts` ONE time, mirroring the door-runner rule (tests/unit/client-doors.test.ts pattern) |
| honesty | a suggestion never reaches a chapter file, the notice, the pool, or any model request: an archived session that used the feature contains zero recommendation bytes |

Manual browser procedure (browser-plane claim stays **gated by #56** — the corpus must be
re-anchored before replay can vouch for it):

1. `/chapters-prompt model local/qwen3.8-flash` (or a cloud route) ⇒ expect "…enables the feature".
2. Finish a turn, idle with an empty draft ⇒ the ghost line appears dimmed inside the
   composer card, labeled with the model; the host placeholder is HIDDEN beneath it (draft
   empty ⇒ host placeholder visible — our layer renders over it; if both are readable at
   once, that is a styling bug).
3. Type one character ⇒ ghost gone instantly; delete it ⇒ ghost back (while not accepted).
4. Click into the editor, press Right-arrow ⇒ suggestion lands as real draft text, cursor
   at its end; nothing sends. Enter sends as a normal human message — then verify in the
   log that the message is plain human-authored.
5. Esc on a fresh ghost ⇒ hidden for this turn; send any turn ⇒ boundary moves, a new offer
   may come.
6. `/chapters-prompt off` ⇒ ghost never reappears in this or later sessions, `suggest`
   refuses; `/chapters-status` says OFF.
7. Kill the model route (wrong provider) ⇒ ghost hidden, refusal only in command output, no banner.

**Distilled, observed, AND replay-verified 2026-10-22** (`prompt-suggestion.spec.ts`, project `prompt`,
port 41739): the scripted-upstream record run PASSED in a real browser on host 0.2.0-rc.2 — chip visible
with the suggestion, hidden by one typed character, re-shown on an emptied draft, Escape dismissed
boundary 1, the next boundary re-armed, ArrowRight accepted into the draft via the host's own
`InputActions.setDraft`, Enter sent it, and the log held the human message with zero persona bytes.
A true `E2E_MODEL=replay` run then passed with ALL SIX requests served from tape and zero misses
(corpus gate lifted for that check ALONE and restored byte-identical — the committed gate still
refuses the chain until #56 re-anchors the other eight; `tests/fixtures/model-tape/prompt/PROVENANCE.md`). The distill ALSO caught a rig bug worth remembering: `localModelUp` answered "no upstream" while a
healthy stub ran on the `E2E_UPSTREAM` port — the guard probed :8080 for any LOCAL base, the same
silent-skip family #54 fixed for remotes. A ROW had pinned that behavior ("loopback is answered on
:8080, not by E2E_UPSTREAM") — and the row was measured WRONG in use, twice, by this very journey
refusing to run against a live stub. Per the house rule (change obsolete behavior with its tests):
the row now pins probe-the-actual-base for local upstreams, plus a dead-local-port NO arm, with the
reason in its comment. The guard lying by REFUSING is the same disease as lying by nodding.

## Release gate — field checks, because green tests shipped a broken product twice

Every item below is the shape of a defect that reached `main` or was found in the field (SAIP,
issues #58–#61, #77–#82) **while the suite was green**. They are not more unit tests: several of
this week's bugs had rows passing correctly around them. The gate is that a human or an agent
observes the affordance working on a real project, and that every new instrument is shown to be
capable of failing.

Run on a scratch clone of a real project (not this repo), at the pinned host and pinned window.

1. **A continuation opens, not just a continuation created.** Fork (button or `chapters_continue`),
   then require: the app's current session IS the child (read `dsh.sessions.current`, or the door's
   own note — it now refuses to claim a switch it cannot verify), the child is in the sidebar, and
   the state survives a reload. *Why: #77 — three evenings of "the client refuses to catalogue
   plugin-created children" were a door calling `sessions.open`, a verb that does not exist
   (`docs/contract.md` § Client Sessions Service). Green throughout, because no test read the id.*
2. **The realm is mounted, not declared.** One session header must read `agentPreset: "chapters"`,
   and the sink must show at least one `compactIfNeeded entered` line. *Why: the preset pin sat on
   a retired row id (`agent-presets` → `agent-preset-registry`) and every acceptance boot ran the
   standard realm for two days — zero `compaction/*` events in 15 logs, while leg verdicts looked
   like product failures (#56, #78). "Declared" was asserted; "invoked" never was.*
3. **Context relief actually happens, with numbers.** Force one oversized read at the pinned
   window; require `compaction/*` events (or an arrival stub pair) in the durable log, then that the
   NEXT turn answers a plain question. *Why: #78's decline is now reported with
   `surface=/trigger=/window=/ratio=`, and a session that survives but answers a stale transcript
   token is exactly what `oversized-turn.spec` caught — after #81, the wrong answer had been the rig
   sending the instruction twice.*
4. **A command reaches the human.** Run `/chapters-status` and check BOTH the durable
   `command/done` AND the screen; today the screen half fails and that is #80, not a flake. A
   delivered-but-invisible result is a feature the operator cannot use (#61a, #67).
5. **A disabled feature is quiet in the durable log.** On a boot without `promptModel`,
   `countGhostCommandRuns(log)` must be ≤ 1 (one capability probe per mount). *Why: #79 measured 4–26
   `chapters-prompt` command pairs per session — a "once per mount" effect depending on `[props]`,
   writing into the transcript this plugin archives, with the OFF test passing because it only
   looked at the chip.*
6. **The rig's pins reach the realm.** The boot's own `cordis.patch.yml` must carry this project's
   `thresholdRatio` and arrival floor on the `chapters-engine` row. *Why: `Pins` were collected and
   applied to nothing for a whole release cycle (leg headers claimed 0.5 while realm defaults
   ran).*
7. **The corpus is one behavior.** `CORPUS_HOST`'s `host` equals the pin, and every project's
   `recordedAgainst` names the same code generation. If any leg was recorded before a rig-behavior
   change (send timing, window enforcement), re-record it: a mixed corpus passes for the wrong
   reason (#56, #81, #82).
8. **Instrumentation must be shown to be capable of failing.** For every gate this week added, name
   the mutation that reddens it — the hygiene guard, the roster predicate, the report helper, the
   window rows and the bounded-scroll row all have one. *Why: three bugs this week lived in code
   written to observe the fourth — `\bpending\b` missing an escaped newline, `ids.size > 0`
   disabling every #77 candidate, a helper resolving logs against an import-time home so a gate
   could never pass, and an unbounded `scrollIntoViewIfNeeded` that hung a leg for 17 minutes. Each
   looked like a product failure. **An unexercised assertion is a rumor of an assertion.**
