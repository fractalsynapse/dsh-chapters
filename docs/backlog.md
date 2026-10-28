# Open items — 2026-10-23 (host 0.2.0-rc.2)

Handoff while the nine-leg re-record and strict replay are in flight on
`feature/56-reanchor-tape-corpus`. Read this section first; the 2026-10-11 record below is history,
and item 1 there (live-model proof of the plans journey) is still open — tonight's `plans` leg was
again recorded through the scripted stub (`tests/e2e/stub-model.ts`), as its PROVENANCE says.

**What the last two days changed about our claims.** The preset pin had been written to a retired row
id (`agent-presets` → `agent-preset-registry`), so every browser boot since the 0.2.x move ran the
STANDARD realm: no `compaction/*`, no artifacting, no `chapters_rules` — the legs were measuring an
absence, not a failure (#56). The 0.2.x flattened `tool/result` shape silently disabled arrival
artifacting chain-wide. `uiWorkspace.openSession` never existed, so the continuation door reported a
switch it could not make (#77). All four are fixed with rows; the corpus is being re-anchored as I
write, and **no e2e claim is current until replay is green** — `CORPUS_HOST` was flipped in the same
change, so a red replay means that flip must be reverted, not the tape widened.

0. **The acceptance chain is one rig bug from green — and it was #77's lesson, in my own tooling.**
   A pristine home commits a draft under a **fresh session id** while `dsh.sessions.current` keeps
   naming the draft, so `newSessionWithTurn` watched a log that received nothing (journey turn
   completed at seq 42, 28 s after its question, in *another* directory). Warm homes hide it; CI is
   always cold, which is why "green here, red there" survived the matcher fix (#89's path fold), the
   host-binary fix (`resolveHostBinary`), the tracked profile seeds, and my own false
   header-composition claim (withdrawn on #89). Fixed by `adoptSessionForTurn` — the durable log
   decides, candidates are only where to look, `null` rather than an invented id — with 4 rows,
   mutation-checked. **The pending step is mechanical but long**: re-distill the nine legs under it
   (`var/run-decisive.sh`, heavy behind the #86 watchdog), strict-replay locally, then one push and
   watch hosted acceptance. Only then: corpus commit + `CORPUS_HOST` re-lift, `coverage:e2e`,
   merge #89, rewrite #73's verification from those numbers.

0b. **One sequencer at a time (#82, live lesson 2026-10-23).** Two detached helper scripts
   (`var/after-pass.sh`, `var/after-pass2.sh`) were both waiting on "runner idle"; the first fired,
   relaunched a full eight-leg pass against a build taken *before* the newest commit, and the second
   would have stacked a competing cycle on top. Killed the duplicate. Rules now written into the tooling:
   `run-decisive.sh` honors `DISTILL_PROJECTS` so a follow-up re-records only the legs that need a new
   build, and a cycle script must `pgrep` for any live `distill|playwright|run-decisive` before starting.
   Careful with `pgrep -f` patterns from inside a shell whose own command line contains the pattern — my
   cleanup killed its own tool call.

1. **#83 — the e2e specs have never been type-checked.** `npm run typecheck:e2e` (new, deliberately not
   in CI) reports **120 errors**: 39 wrong-arity calls, 12 cannot-find-name, 10 argument-type, 26
   un-narrowed `unknown`, 22 missing-lib, 3 phantom properties. Two bugs this week (a missing import,
   a dropped closing paren — both mine, both from the composer wiring) were invisible *only* because
   this check did not exist. Close it: fix the arity class by giving `newSessionWithTurn` a named
   options object (`{ turnMs, actionGrace }`) so a positional `false` is un-writable; triage the rest;
   then wire the gate beside `typecheck` and `typecheck:client`. Do not exclude a file to shrink the
   number — a dev-only tool moves out of `tests/e2e` instead.
2. **#82 — a running distill and the deterministic suite share `tests/fixtures/model-tape`.** (Third live instance 2026-10-23: `tape-provenance.test.ts` correctly went red mid-re-record because the runner had cleared a project directory — that row is now the canary, don't soften it.) Tonight
   the tape-coherence rows went red for exactly the projects being re-recorded, and a leg that dies
   halfway can leave a partial project directory in the corpus. Recommended shape: record into
   `tests/fixtures/.tape-staging/<proj>`, promote with `rename` on `rc == 0`. That makes "the corpus
   is one coherent change" a mechanism instead of my self-control, which has already slipped once.
3. **#80 — plugin command results produce nothing operator-visible.** Durable `command/done` yes, DOM
   no (measured twice: this leg's own teardown aria snapshot; `/chapters-status` on a fresh boot).
   Success paths are undelivered, which is #61a one layer up. Needs a host fact (`docs/contract.md`)
   before code: is there a slot/toast/flow renderer for `command/done`, or must the plugin own the
   affordance?
4. **#81 criteria 3 and 4.** The delivery guard is now at every composer call site with a drift row,
   but the browser assertion "one instruction ⇒ exactly one `user/message` carrying it" is not written
   yet, and the predicate still decides from the durable log only — a synthetic turn whose record is
   delayed is still a race we have not measured.
5. **#78 — the design decision, still the maintainer's.** A single `tool/result` larger than what can
   fit beside the mandatory retain tail is NOT relievable by pressure compaction (measured: 6
   compactions + 6 `context-overflow` entries + the endpoint's `400`, with the arrival floor switched
   off by design). Option A: treat survivability as an invariant (hard ceiling, artifact with a loud
   warning — the archive keeps every byte, so the worst case is a context-economy miss). Option B:
   accept "disable the floor, read 30K tokens, the session degrades" as correct. `heavy` is green, so
   this no longer blocks a leg — it is a product statement we should make deliberately.
6. **The remaining release steps for #56**, in order: green strict replay (no fallback) → fresh
   `coverage:e2e` → PR to `staging` (reload the `release-workflow` skill first — the gate is
   mandatory) → CI green → merge → rewrite PR #73's verification text so every claim carries the
   artifact that proves it. `main` stays agent-forbidden.

---

# Open items — 2026-10-11 (history)

Handoff for a fresh session. Everything below is *scoped and reachable*; none of it is a unknown
defect. Shipped state: **0.1.13** (tag = npm `latest` = the user's installed profile), hosted CI green
(deterministic gate + eight-project tape chain), and the untagged commit after it (`5bdc11b`) changes
only the e2e stub and this record.

Order matters: 1 and 2 are the ones that change what we are allowed to *claim*.

## 1. Live-model proof of the plans journey

**What is missing.** Every acceptance claim for plan carriage runs off a tape distilled from the
scripted upstream (`tests/e2e/stub-model.ts`), because this box's model server was in a CUDA-OOM
restart loop. The behaviour at our seam is proven; "a real model plans, a human approves, the
continuation carries it" is not.

**What attempt 5 already bought** (see `tests/fixtures/model-tape/plans/PROVENANCE.md`): a real
`exit_plan_mode` submission, the host review answered by a real click, `plan/mode` flipping
active→inactive on approval, the archived chapter carrying the plan, and the **branch** child receiving
zero directive bytes — all with a live model. What it did *not* buy: the continuation leg, because the
model called `chapters_segment` and then answered in prose.

**How to close it.** The container is now `RestartCount=0` with `N_PARALLEL` removed.

1. Prove a **completion**, not a health check: `curl` a real ~14K-token chat request and confirm it
   finishes. `/v1/models` answering proves nothing (measured repeatedly).
2. Run the journey live: `E2E_MODEL=live E2E_PORT=41850 E2E_THRESHOLD=0.99 E2E_NO_AUX_MODEL=1
   npx playwright test -c tests/e2e/playwright.config.ts --project=plans`
3. Expect cost: ~15 tok/s decode means several minutes per turn, and with one slot this session's own
   turns queue behind it. Do it when the box is otherwise free.
4. Record the outcome in `PROVENANCE.md` either way — including a failure and its cause. Do **not**
   promote the scripted tape's status based on a live run that only half-completed.

**Honest limit.** A live journey is inherently non-deterministic (attempt 5 proved the model may chain
two calls or may not). It is evidence, never a CI gate. Do not try to make it one.

## 2. The seeded-gate row in a browser

**What is missing.** The seeded `plan/mode` into a continuation child (§ 10 of
`docs/plans-carriage.md`) is proven by a kernel probe and by deterministic rows, but never *observed*
in a real session.

**Already done, and it is the hard part:** the session shape was reached live-in-the-harness and
recorded — `plan/mode {active:true}` at seq 4, `turn/end` at 21, **no** tool call. So a session can be
in plan mode with a completed turn, which gives the deterministic door a real ceiling to archive
against. The attempt was reverted unshipped for two harness reasons, both now fixed on `main`:

- the stub had to learn to answer **plainly** in plan mode (`kind: 'plain'`), and its "is the human
  asking for a plan?" test first read the **last** user message — but the harness appends its own
  injected user messages (workspace instructions, runtime snapshot, skill catalog) *after* the human's,
  so the ask was invisible and the next step hung 15 minutes on a review card that could not appear.
  Now it scans every user-role message, the trigger is a whole sentence so the plan-mode *policy* text
  cannot set it off, and both properties are pinned by rows in `tests/unit/stub-model.test.ts`.
- a **stale stub process** was serving pre-edit logic, which made a harness bug look like a product
  one. Restart the upstream before trusting any distillation.

**Remaining work.** Re-add the leg (draft is in this file's history of the repo: new session → `/plan`
with a plain ask → wait for `plan/mode` + `turn/end` → `/chapters-continue` → poll `ch-` children for a
`plan/mode` event at seq 1 with `active:true`, assert exactly one `dsh-chapters` user/message, and
assert the notice carries **no** plan section since no plan was submitted). Then re-distill the plans
tape with a **fresh** stub and replay it. Roughly 15–20 minutes.

## 3. Per-message anchoring (needs a product decision, not just code)

`deriveRanges` already accepts any anchor, and the fork/continue doors archive from the watermark. What
does not exist is a way for a human to say *"branch from this message"*, because the button acts at
conversation end. Two open questions before code:

- where the affordance lives (message action row vs selection in the composer), and
- **how the child is told what it did not inherit** — an anchored branch silently drops the tail, which
  is exactly the kind of unstated loss this project refuses. It needs a line in the notice.

Scope it as its own plan; do not fold it into a release.

## 4. Default-preset shipping policy (the user's call)

Today `chapters` is opt-in: the profile must name it, and the README/site tell users how. The
alternative — make it the default agent preset — changes every new session's header. That is a
distribution decision with a cache consequence (a recomposed header is measured at ~12K tokens on a
32K model) and it belongs to the human, not to an agent. Ask before touching it.

## 5. Human-judgment verification rows

Still open and still human-only: readability of a real checkpoint in a real browser, and whether the
notice/preamble *feels* right to work in. These are not automatable and should not be faked with
assertions. `docs/verify.md` lists them; run them after installing, in the project you actually care
about.

## Also worth knowing

- **Durability caveat for a new project:** with no pool linked, the archive lives only in the
  workspace. `/chapters-link <path-or-url>` is the difference between "this machine remembers" and
  "the project remembers".
- **Search now answers unlinked** (0.1.12) and says which door it used. If a result ever looks
  machine-only when you expected the pool, that note is the first thing to read.
- **`/chapters-continue` vs `/chapters-fork`** is the intent line: continue carries the operative plan
  and may seed plan mode; fork carries nothing.

## Preset delivery on 0.1.7+/0.2.x — landed, and what it exposed (2026-10-16)

**Landed:** the `chapters` preset now EXISTS on a declaration-row host, by `agentPresets.register()` at
activation (`src/preset.ts`), with rows the host cannot import dropped and named, a held disposer, and a
deferred ROSTER check (`present` / `DECLARED BUT BROKEN` / `absent` / `unknown`) as the only health signal.
**Support floor is 0.2.0** (user decision 2026-10-16): the legacy `.agent-presets` copy, the
`presets/chapters/` tree, `installChaptersPreset`'s copy arm and `preset-install.test.ts` are DELETED; a
pre-0.2.0 host gets `delivery: REFUSED` with its tools intact. The engine row's `thresholdRatio` became
the host-plane config `compactionThresholdRatio` (no hardcoded tunables). Verified on real boots:
0.2.0-rc.2 → `register: pruned, roster: present, inventoryRows: 28, unusableRows: []`;
0.2.1-alpha.4 → `register: registered, roster: present, inventoryRows: 29, unusableRows: []`
(after dropping `toolFilter`, which alpha.4 THROWS on — see the config-key row of the drift test). `tests/unit/preset-declaration.test.ts`
(13 rows, `src/preset.ts` at 100%) is the drift gate, and it now RUNS on this box instead of skipping.

**Why the row is not a shipped patch layer** — measured, because it looks like the obvious fix and it is a
boot-breaking one: `dsh.bundle.patch` as an ARRAY throws `ERR_INVALID_ARG_TYPE` at
`dsh-app-boot/lib/index.js:853` on every host before 0.1.7-alpha.1, and a row naming
`@deepseek-ai/dsh-agent-preset` aborts that host's plugin tree (`Cannot find package`). `disabled: !!js`
cannot gate it either: the Loader evaluates `disabled` before services mount, so the row is disabled on the
NEW host too (measured). Full record: `docs/contract.md` § Presets are declaration rows.

**Open, in order:**

0. **Re-anchor the e2e host, then re-distill the tapes — IN PROGRESS (#54).** The lock now
   resolves `@deepseek-ai/dsh` **0.2.0-rc.2** (chosen by witness: the host this box has been running
   the plugin on, not npm's latest), `hostSupportsPresetRows()` answers true, and the boot's named
   refusal has lifted itself exactly as designed. Three 0.2.x rig drifts were found by booting rather
   than guessing and are fixed — the `session.v4` log format, the Preview Notice focus trap, and the
   provider block that 0.2.x reads only from `cordis.patch.yml`. Distillation no longer needs the GPU
   box (see `docs/development.md` § Distilling tapes WITHOUT the GPU box). REMAINING: re-distill all
   eight projects on the new host, re-run `npm run test:e2e:replay` strict and `coverage:e2e`, and
   re-measure the browser ledger before ANY browser-plane claim is made. `ci.yml`'s `host-capability` job reads that same lock and
   SKIPS the acceptance job with a step-summary reason plus a `::warning::` while the pinned host
   predates declaration rows: visibly skipped, never red-by-accident, never green-by-omission.
   Publishing is unaffected — the release gate is the deterministic suite. The per-boot row pins (`thresholdRatio`, `enrichmentEnabled`,
   `auto`, `elicitedPlot`, `toolResultArtifactTokens`) and the `[e2e] boot pins:` line were deleted with
   the YAML they patched; they come back expressed as CONFIG on the registered row (`compactionThresholdRatio`
   exists now; the rest need the same treatment). Until then the browser acceptance chain does not run, and
   `docs/verify.md`'s P23 is retired rather than passing.
1. **The roster verdict is a boot log line, and a user has no terminal.** 0.1.18 made the preset a
   visible Loader row (`preset-chapters`) and put the mounted-row count in that line, so the
   "is it actually usable" fact is one grep away — but it is still a grep. Candidate: surface it in
   `/chapters-status`. Nothing else in the plugin reports health to a human today.
2. **`installChaptersPreset` and `compactionThresholdRatio` are accepted-and-inert** since 0.1.18 (the
   preset is a row; the engine threshold is row config). They must be DELETED in the next minor — a key
   that silently does nothing is its own drift — and the removal needs the same care: check no shipped
   profile patch sets them, then drop both from `Config` and from `cordis.patch.yml`'s header.
2. **`compositionInventory()` is used by the dev witness only.** Making the boot check itself compare
   mounted rows would catch a row that resolves but never activates — the `broken` flag does not always
   cover that, and the witness proves the shape of the answer already.
3. **A reset registry can overwrite a chapter — no guard exists today.** `writeArchive`
   (`src/archive.ts:106`) reserves numbers from the registry and writes them; nothing checks whether that
   path already exists on disk. So the exact incident shape — registry gone (host reinstall) while chapter
   files remain, or restored by rehydration — lets a NEW archive reuse number 001 and clobber a surviving
   file, which breaks the append-only rule from the inside. Two rows are missing: at boot, report files the
   registry does not know (`<store>/<root>/chapters/*.md` vs registry rows, counted); and refuse a
   reservation whose target path exists, with the numbers.
4. **Rehydration restores bytes, not rows.** `rehydrateStoreFromMirror` (`src/sync.ts:476`) fills absent
   chapter and artifact files only. Search works off the files' own frontmatter, but numbering, ancestry and
   collections are registry state, so a rehydrated store can be searched and cannot be continued cleanly.
   Decide: rebuild rows from frontmatter (honest — the bytes are the ground truth), or refuse continuation
   over a partially restored store with numbers. Do not let it look like a fresh chain.

## Host bug we cannot fix: the workspace directory-picker modal (2026-10-16)

Reported by the user as "the directory selection modal crashes before I can select a workspace", and it
survived a host upgrade. Root-caused with real boots (`var/picker-probe/FINDINGS.md`, kept out of the
repo's claims — it is host code): the picker's CLIENT bundle and the shell's client module table must come
from the same host generation. The 0.1.x picker asks for `IconFolderOpen16`/`IconFolderClose16`;
0.2.0-rc.2's shell exports only the `…Regular` spellings, with no compat alias in either direction. The
slot boundary catches it, so the symptom is a rendered-then-dead dialog:
`Error: Minified React error #130 … got: undefined`, logged as
`slot entry crashed in 'sidebar.workspaces.directoryFlow'`
(`@deepseek-ai/dsh-client-ui-renderer/lib/client.js:618`). A stale profile-local copy of
`@deepseek-ai/dsh-client-ui-directory-picker-*` under `$DSH_HOME/profiles/<p>/node_modules` shadows the
upgraded global install and reproduces "the new host did not fix it" exactly.

Nothing in this plugin contributes to that slot (its client half registers
`conversation.chat.assistant-actions` only), so the repo can ship no fix — only the recipe, which the
site documents: purge the stale picker copies, and if the auto-resolved backend is not the one you want,
pin the pair deliberately in the profile patch (`disabled: true` on `directory-picker`, insert
`@deepseek-ai/dsh-host-directory-picker-browse` + `@deepseek-ai/dsh-client-ui-directory-picker-browse`).
Upstream ask: compat aliases for the renamed icon exports, or a boot-time shell↔plugin version handshake
that rejects a mismatched bundle instead of crashing at render.

## Two-tier rules — specified, deliberately not built (2026-10-20, #50)

The design round that produced record §7.1 + §7.3–§7.9 and Amendment 2026-10-20 started from one
measured hole: `planSummarize` composes `leadSections = [planSection, plotSection]`, so a plan and a
plot survive an in-place compaction and a **rule does not**. Docs are committed ahead of code
(docs-first); `docs/verify.md § Two-Tier Rules — SPEC` rows R1–R10 are the checklist, and each one is
supposed to be provable-red before it is called a fact. A fresh session should start at the tests, not
at the implementation.

Two things the round decided **not** to do, so they don't get rediscovered as oversights:

**1. Team-identity curation facts (multi-human collective approval) — deferred, and it is a real
design question, not a gap.** Approval is per-machine by the 2026-09-20 amendment, and that boundary
was NOT relaxed: a rule a teammate approves is not `core` on your machine. For checkouts on *one*
machine that is invisible (`harnessId` = hostname, so they share one facts file) — which is exactly the
use case that asked for it. For **several humans on one project**, the cost is re-reviewing a growing
list. The clean way to buy it back without reopening the bug the amendment closed: keep facts namespaced
by *writer* and let a machine read **more** namespaces — my own `edits/<harness>/curation.jsonl` ∪ a
recognized team identity's `edits/<teamId>/curation.jsonl`, still one writer per file (§3.3 survives),
no file rewrite, and "primary architect" becomes whoever holds the team credentials rather than a role
people are trusted to respect. Local `revoke` must still win over a team fact (last-write-wins by
namespace precedence, stated explicitly). Needs a decision first: is the population one team, or can
unrelated projects share a TreeDX instance? The second turns this from a feature into governance.

**2. Per-request rule injection — rejected on measurement, not taste.** Invariant 3 keeps the global
system prompt out, and E3/r23-r28 show a head-position replacement reuses nothing on llama.cpp
(`cacheReuse 0`) — a ruleset that churns mid-session would be a cache-wipe machine on the target
hardware. Carriage happens at the two moments a head is actually rebuilt, plus `chapters_rules` on
demand. If someone revisits this, the honest argument is "small models drift mid-window", and the
answer is the pinned class + the withheld-count line, not more injection.

## #50 two-tier rules — what the next session inherits (2026-10-20)

The round landed green on the deterministic plane (640 unit / 137 integration rows, coverage gate
held at 93.16 / 85.53 / 90.01). Three things are deliberately unfinished, and none is a surprise:

1. **Mined-rule quality: first data in, sample tiny.** `npm run mining:probe` (2026-10-21) mined
   three real chapters of THIS repo at `qwen3.8-flash` through the shipped path: 9 rules, 6 stated / 3
   inferred, every inference confined to the one chapter that had no human text, none wrong or unsafe.
   Full numbers and the caveats in `docs/verify.md` R5. Next: probe archives from a project that is not
   this repo — our own history is the friendliest corpus available, and a rule like "treat pinned tests
   as authoritative" is true here partly because the reader is already convinced.

   1b. **Settled 2026-10-21, and settled twice:** the first reading ("mining is being truncated by
   `ENRICH_MAX_TOKENS = 900`") was wrong — the token-plan route does not enforce `max_tokens` at all
   (a 64-token cap returned 113 tokens, `finish_reason: stop`) and it itemizes
   `completion_tokens_details.reasoning_tokens`. What was real is that the budget was three
   hardcoded literals sized for pre-mining answers, so it is now `enrichmentMaxTokens` (default
   4000). If a future provider DOES enforce the ceiling, this is the knob; if mining ever needs its
   own budget, `rulesModel` already gives it its own call.
   1c. **Endpoint default is the regional token-plan door**
   (`token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`): QwenCloud gives no region
   choice, and the `maas.qwencloudapi.com/compatible-mode/v1` alias answers `401 Invalid API-key
   provided` for the keys on this box. `scripts/llm.mjs` defaults to the regional door, keeps the
   alias as a probe candidate behind it, and takes `DSH_LLM_BASE` as the override — so a credential
   that starts working at the alias is used with no edit.
2a-1. **The knowledge-loop journey cannot reach the door after two commands run** — precise,
   measured 2026-10-22. `suite` now dies at `forkDoor(page).click()` waiting for
   `button[aria-label="Fork with chapters"]:visible, last` for 25 minutes, with the upstream
   journal showing **44 completed answers, 0 throttles, 0 deadlines** — so it is not quota and
   not the model. What the journey does between the last assistant message and the click:
   `/chapters-link`, then `/chapters-status`. Those render as command **flow nodes**, so after
   them the last assistant chat row is no longer the newest actionable node, and the door row
   on it is not `:visible` (host action rows appear to be gated on the newest/hovered message —
   the fork journey, which forks right after ONE turn, clicks the same helper without issue).
   FIX (rig, not assertion-weakening): select the door **scoped to the last assistant message**,
   scrolling/hovering that message first — the same affordance a human uses — rather than
   "the last visible door in the document". Keep `forkDoor` as the single selector so all four
   journeys move together, and keep the `toBeVisible` assertions: a door nobody can reach is a
   real defect, whether the cause is the plugin or the client's hover gating.

2a. **On 0.2.x the switch to a forked child is a silent no-op, and the child never
   appears in the session list** — measured 2026-10-22 against the CURRENT build (host
   0.2.0-rc.2, plugin link-verified by the new boot guard). The door announces success
   (`branch “…” is session ch-3865899e…`) and renders NO note element, which
   `src/client/doors.ts` emits only when `sessions.open()` did not throw — yet
   `localStorage['dsh.sessions.current']` still names the PARENT, focus stays on the parent's
   composer, and after a full reload the sidebar lists one session. The child is real: its
   directory holds `session.lock` + `session.v4.jsonl.zstd`, `session_projcache` has both
   entries, and the log carries the whole notice (`Project: …`, `(N msgs)`, rule categories).
   **Prime suspect is our own swallowed failure**: `src/tools.ts` attaches with
   `workspaceRegistry.createCanonical(cwd)` → `workspace?.attachSession?.(sessionId)`, both
   optional-chained — and AGENTS records that very attach as the fix for round 6's "an
   unattached session shows as an unrelated root, so it is not listed". If 0.2.x reshaped that
   return, the chain no-ops silently and orphans the child from the workspace, which matches
   every symptom. NEXT: make the attach loud (diagnostic + door note when the service or method
   is absent; never an optional chain through a required step), re-run, and let the message name
   what is missing. `tests/e2e/fork-button.spec.ts` already asserts the switch — it is the gate,
   and it is red for the right reason.
   Superseded by the above, kept so nobody re-bisects it: an earlier version of this entry blamed
   a `format v4 message requires a producer-owned source kind` refusal. That message was real but
   came from a COPIED plugin tree dated Oct 16 in `.dshdev-local`; the current build produces no
   such refusal, and `spikes/seed-admission/` shows host 0.2.0-rc.2 admitting our notice, the
   notice + `plan/mode`, and the notice + `agentOptions` + preset mount (5–6 durable events each)
   while correctly refusing the retired v3 wrapper.
2. **The browser plane is blocked by CORPUS PROVENANCE, not by the host any more.** The
   preset-row refusal is gone — `dev/dsh-host-lock` resolves 0.2.0-rc.2 and
   `hostSupportsPresetRows()` answers true, so the rig boots the preset and CI's acceptance job
   RUNS instead of skipping on capability. What stops replay now is that the eight tape projects
   were distilled against 0.1.5-rc.1, and tape matching is normalized request-PREFIX matching over
   prompt bytes the host composes. `tests/fixtures/model-tape/CORPUS_HOST` says so in one place,
   `scripts/corpus-anchor.mjs` reads it, `tests/e2e/boot.ts` refuses REPLAY by name (RECORD stays
   allowed — a gate that blocked the way out would strand itself), and CI skips the acceptance job
   with a step summary and a `::warning::`. Lift it by re-distilling all eight
   (`scripts/distill-tapes.sh`) and updating the record — **issue #56**, with **#57** (door
   selector scoped to the last assistant message) as the blocker inside it. Extending
   `rules.spec.ts` with the checkpoint-carriage and continue-vs-fork assertions is still owed, and
   must be written after the corpus is anchored — spec assertions that cannot execute are a false
   witness, which is why they are not written preemptively.
3. **R10 is only partly proven.** Marker rules re-derive off the durable log and dedupe against
   disk, but there is no end-to-end wipe-and-replay row yet.

Two local truths to save the next agent an hour: the suites need **Node ≥ 24** (on 22 every file
fails for a reason that looks like your diff), and `coverage:ci` intermittently reddens
`git-auth-classification`/`sync-remote` on this box under parallel load — **verified pre-existing** by
running it in a worktree at the last docs-only commit. Re-run before blaming the change.


## Retrieval is untested in the field (#61, record only — do not "fix" it speculatively)

Measured over 26 SAIP sessions / 4,049 tool calls: `chapters_search`, `chapters_artifact` and
`chapters_rules` were called **0 times**, and no tool call anywhere referenced a `.dsh-chapters` path.
So the archive's retrieval promise is **unverified in the field**, not proven broken: the deterministic
and browser planes both exercise those doors, and a real long session may simply never have needed them.

Deliberately NOT acted on in #61: no persona rewrite, no "make the model search more" prompt change. The
persona is a product-prompt surface and every byte of it costs a tape re-distill (#56/#57), so a change
there needs a measured defect, not an inference from an unused-tool count. If a future project shows
knowledge that WAS archived and never retrievable when asked for, that is the evidence that opens this.

## #71 prompt recommendations — push transport (follow-up, gated on the compile-deps move)

The feature ships on the PULL transport (`/chapters-prompt suggest` over `remote.commands`,
the door-proven wire) because our compile-time `@deepseek-ai/*` closure is still
0.1.5-rc.2, where `appendPluginRecord` / `PluginRecordMap` do not exist (grep-verified;
facts in `docs/contract.md` § Composer Ghost Layer). When the workspace deps move to 0.2.x
(they must for `hostSupportsPresetRows`-era work anyway):

1. Merge `SessionProjectionMap['chaptersPrompt']` + `PluginRecordMap['plugin:dsh-chapters/prompt']`
   in `src/prompt.ts`; at generation, `appendPluginRecord` the whole-value record (durable,
   append-only, never surface-eligible — invariant 1 honored), register a
   `ProjectionDefinition` folding it (plan/goal pattern), and have the client read
   `useProjection('chaptersPrompt')` instead of pulling.
2. Screen the record type in `src/injections.ts` (host-injected, never archived) and bucket it
   as un-rendered in the chapter renderer — one predicate, per the #59 rule.
3. Add a kernel-drift row: plugin records must stay NOT surface-eligible
   (`isSurfaceEligibleType`), read from the kernel's own exports.
4. The pull command stays as a manual verb (`suggest` re-arms the ghost); the anti-dup client
   row keeps the wire body singular either way.

- **#105 / seed-vs-protected-head (blocking for `chapters_continue` on 0.2.x).** Every child we create
  seeds a `user/message` at `seq 0` (invariant 2), which is a `SURFACE_TYPE`, so the host's header
  `system/message` can never claim the protected first surface head — measured: 50/53 logs have the header
  first, the only 2 exceptions are our children, and one is refused by the UI. Ask of the host team:
  `docs/host-protected-head-ask.md`. Mitigation candidate (b), **gated on a measurement, not a guess**:
  spike `spikes/seed-protected-head/` — one boot, fake provider, zero model tokens; create a child seeded
  with a non-surface synthetic event (the `plan/mode` precedent) and one seeded with the notice, run one
  step each, then reload through the host's own reader. Ship (b) behind a config flag only if the state
  seed is admitted AND the header lands as the first surface event. Related: #77, #58, #101, #61.
- **#113 / the composer ghost is REMOVED (maintainer decision 2026-10-25), `/chapters-prompt` survives as a
  deliberate command.** The chip re-fired per step inside one turn, errored on empty threads, and its overlay
  was unreadable and overlapped the placeholder. What landed instead: turn-scoped generation (`src/prompt.ts`
  keys on `turn/end`, not the last surface event), a `quiet` class on "nothing to offer" refusals, and a
  multi-line labelled block from `/chapters-prompt suggest` so the prompt is shown whole with its model,
  source and cap (the same shape `/chapters-status` gets an expander for). Site §28 and
  `docs/contract.md` § Composer Ghost Layer still describe the removed overlay — they need a pass, and if the
  ghost is ever revived it must answer all four defects with measurements, not a restyle.

## Tape generation + acceptance (state at 2026-10-26, end of the debugging round)

**Resolved, with evidence:**
- The Alibaba token-plan credential is **valid**: `GET …/compatible-mode/v1/models` → `http=200`. My earlier
  `401 Invalid API-key` reports were **my invalid model id** (`qwen3.8-flash`, then a broken extraction that
  yielded `"json"`), because this gateway reports a bad model as a key error. Do not re-diagnose the key.
- File/`~/.bashrc`/harness-process key fingerprints are identical (`5ff7ab0a`, 114 chars) — the credential
  path works; an agent tool shell still can't inherit it, so `.dshdev-local/e2e.env` is the supported route.
- `qwen3.8-flash-next` (the fixture name in the tracked seed) is **not** in the plan's `/models` list; that is
  exactly what `E2E_UPSTREAM_MODEL` exists to translate.

**Next, in order:**
1. Pick a real id from `/models` (a flash-tier one, e.g. from the list returned), verify one
   `chat/completions` call answers `200`, and record which id.
2. In harness mode set `E2E_UPSTREAM=https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`
   and `E2E_UPSTREAM_MODEL=<that id>`, then `LEG=rules MODE=record` — the shortest leg.
3. Read a **fresh** session tree (mtime-since-start) for `assistant/message`. Two prior readings were wrong:
   one used an Oct 23 stale dir, another found none because sessions land under the port-keyed home only if the
   model answered at all.
4. Only then revisit: the live-mode `composer did not take focus (active: API key)` wall, and the missing
   `Fork with chapters` door. Both may be downstream of a provider that never answered — do not treat either as
   a UI bug until step 3 shows an assistant message existing.
5. Standing diagnosability fixes owed: boot must assert a provider answered before journeys poll; failure
   artifacts must include a DOM (`error-context.md` has none, which is how I claimed "present but not visible"
   from a call log).

### The bar renders nothing because its pull never returns (2026-10-26, measured)

Proven by instrumenting rather than reasoning, each step eliminating a hypothesis:

- the profile row reaches the plugin: `[chapters-config] promptModel delivered = "qwen-token-plan/qwen3.8-flash"`
  — so the server-side enable rule is satisfied;
- the component **is mounted** by the host and receives real props: `[client:prompt] mount; sid=session-…
  exec=function inputActions=object status=off` — so the dock registration and slot name are correct;
- the initial `status=off` then hides the row (`barVisible` false), which is the *by-design* default;
- but the mount-time `refresh()` produced **no** dispatch, **no** catch, and **no** `finally` — it awaits
  `exec(...)` and never returns, and nothing reached the host (the server log has no `chapters-prompt` line).

So the remaining fault is the command wire from the dock: `runCommandText(remote, sessionId, line)` resolves
for the assistant-action doors (the fork leg clicks it successfully) and hangs when fired at mount. Ordering
hypothesis: at mount the session may not be attached for a command dispatch yet, or the doors' path awaits a
different signal. Fix, in this order:
1. bound the pull (`Promise.race` with a timeout) so a hung wire becomes a **delivered** failure, not silence —
   the bare `catch {}` that swallowed tonight's diagnosis is already replaced with `console.warn` (#61);
2. fire the first pull on the same edge the doors succeed on (after a completed turn / idle), not at mount;
3. only then decide whether `off`-until-first-answer stays the default or the bar shows `Analyzing…` while the
   first pull is in flight. The maintainer's approved shape says *Analyzing… then Recommended Next Step*, so if
   the pull is reliable, `off` is the wrong default for a configured session.

Rig gaps found on the way, worth their own rows: `E2E_KEEP_HOME=1` is documented but no longer implemented in
`tests/e2e/*` — so a passing boot deletes the only copy of the profile it wrote and post-hoc inspection is
impossible; and `typecheck:e2e`'s `TS2769` count is structural (one per `projects` entry, because Playwright's
`Project` type has no `env`), so it must move with the number of legs, not be treated as a regression.

### Why the bar is invisible: a refusal is stored as `off` (2026-10-26, measured end to end)

The chain, each link proven rather than assumed:
- dock registration correct → component mounts with real props (`exec=function`, `inputActions=object`);
- pull resolves (no timeout, no catch) → the wire works;
- reply read verbatim: `suggested next step: off` + `model: qwen-token-plan/qwen3.8-flash (config)`;
- `parseBarState` parses that block correctly and dispatches `off`; `barVisible(off)` is false → row hidden.

So the client is right and the profile row arrives. The fault is on the server: `prompt-runner.ts` /
`prompt.ts` map a **quiet refusal** to `status: 'off'` ("a quiet refusal (`nothing to recommend yet`) is
`off`, not `failed`"). That single choice makes three different things indistinguishable to the human and to
the bar: suggestions switched off, nothing to recommend yet, and suggestions **unable to run at all**
(`refuse('prompt suggestions cannot run: ' + reason)` when `resolvePromptRoute` finds no route). In this rig
the model is configured, so what the bar is actually reporting is a route-resolution failure wearing the
costume of "off".

Fix, in this order, rows first:
1. Only "there is nothing to recommend yet" may store `off`. A route/transport failure stores `failed` with
   its reason, because the human must be able to tell a disabled feature from a broken one — the rule
   `off` means off and `unavailable` means unavailable, already adopted for `/chapters-rules` in #109.
2. Add a unit row per refusal class over the runner's write, so the mapping cannot collapse again.
3. Then re-run `LEG=prompt` and read the reply: `analyzing`/`ready` means the bar renders; `failed` means it
   renders *with the reason*, and the remaining bug is the host route discovery (`hostRoute` in `src/index.ts`)
   — a different, narrower problem.

### Next unknown, isolated: did the suggested-next-step door register at all? (2026-16 17:20)

Eliminated by measurement, one link at a time: listener arg order (`(session, event)` — matches
`makeSignatureListener`'s published shape), `enabled()` (`prompt.effective().spec !== ''`, and the profile row
is delivered), the read/write store (both the registry row's `promptSuggestion`), and the merge order
(`statusOf` contributes only `{autorun, fired}` — it cannot clobber the status).

What is left: `ctx.on('session/event', …)` at `src/index.ts:684` may not be the bus the *realm* doors use
(`src/engine.ts:560/574/585` register inside the realm class on `this.ctx`). The registration prints
"dsh-chapters: suggested-next-step door armed" — or "REFUSED" — through `ctx.logger`, and the rig deletes the
home (and any per-port log inside it) at teardown, so tonight's run cannot answer it. `E2E_KEEP_HOME=1` is
documented but no longer implemented anywhere in `tests/e2e/`.

Therefore, in order:
1. Deliver the rig's own logs: on teardown, copy the boot's stdout and the per-port diagnostics file to
   `var/e2e-<port>-diagnostics.log` BEFORE the home is deleted, and re-implement or delete the
   `E2E_KEEP_HOME=1` doc claim. A rig that discards the only evidence of a boot is the #61 bug in my own tooling.
1b. **The delivery attempt itself failed**: the teardown copy ran but found nothing at
    `rigStoreRoot(port)/diagnostics.log` — the store root is not directly under the home (the journey's workspace is), so the path must be derived from the boot's actual store root, not assumed. Prove it by listing the home's tree inside the copy step once, then point the copy at the real file.
2. Re-run `LEG=prompt MODE=record` and read whether the door armed. If REFUSED, the event bus/registration is
   the bug and the fix is to register where the working doors register.
3. If armed but no claim, instrument `promptRunner`'s three early returns (`ev.type`, `enabled`, `eligible`)
   with the reason each one took, delivered to the diagnostics sink, and re-read.

### Where the corpus work stands (2026-10-26, end of session)

Recorded green against the maintainer's route: `rules` `explore-dev` `fork` `arrival` `fanout` `enrich`
`plans` `suite` `heavy` `prompt` `prompt-off`. Bar leg passes 4/4 in record AND in replay; OFF leg 1/1 in both.
Open, in order:
1. one whole-chain `MODE=replay` green run (CI's gate) — in progress;
2. `npm run corpus.stamp` + `corpus.check` so `CORPUS_HOST.distilledAt` matches the tapes (it still says
   2026-10-23 while every tape is from 2026-10-26);
3. `coverage:e2e` refresh on the new plane;
4. #126 (host: no composer draft API for docks) — until it lands, the bar explains the refusal and Run
   submits through `/chapters-prompt run`;
5. then cut `0.2.2-dev.1` and hand the maintainer the install/restart.

### The orphan reaper covers the host port but not the tape-proxy port (2026-10-26, measured twice)

**Correction, a day late and worth the edit:** when I wrote the sentence above the reaper was NOT in the tree.
PR #124 was still open, `tests/e2e/boot-reap.ts` did not exist, and `boot.ts` still only advised `pkill` — so
nothing was reaped, host port or proxy port. My diagnosis described a component I believed in rather than one I
checked for. It merged as `a8ff124`; the chain now running gets to find out whether it actually works, against a
live orphan holding 41733. The proxy-port gap below stands on its own evidence (two EADDRINUSE faults today:
42739 and 42733).
`tests/e2e/boot-reap.ts` reaps repo-owned `dsh web --port <n>` holders before a boot. The proxy binds
`<rig port> + 1000` (`42731`-`42740`) and is covered by nothing, so a leg killed mid-boot leaves a proxy
holding that port and the **next** chain dies at once:

    Error: listen EADDRINUSE: address already in use 127.0.0.1:42733
    (earlier today, the same fault on 42739)

Both were mine — a 250s `timeout` on a leg whose teardown then never ran. Manual reaping works (kill the
repo-owned holder), but a rig that manufactures its own next failure is the #108 class: the run that got
killed already knew the port was its own.

Fix, rows first: extend `orphanBootPids` to take a port set (host port AND proxy port) and a matcher for the
proxy's own command line, keep every existing constraint (repo-root in argv, never self, never an ancestor),
and have the boot reap before `startModelProxy` binds, reporting which pid it signalled. A row must fail
against the current code to prove the gap: a holder of the proxy port is not reaped today.

### CI acceptance is red where the local chain is green — and its annotation is empty (2026-10-27)

Local: `E2E_MODEL=replay npm run test:e2e` → **10 projects, EXIT=0**, including `prompt` 4 passed and
`prompt-off`. CI on the same commit: deterministic + preset-rows **success**, acceptance **failure**, and the
annotation says only `ci-replay: tape replay exited 1` with **none** of the detail lines the script is written
to attach (`✘|Error:|expect(|Received:|Expected:|[0-9]+ failed`, plus the `error-context.md` heads).

That emptiness is itself the clue: `scripts/ci-replay.sh` tees the chain into `var/ci-replay.log` and greps it,
so "no matches" means the log contained no test verdicts at all — a failure at boot/setup, not an assertion.
Prime candidates, in the order to test:
1. run `bash scripts/ci-replay.sh` locally with its CI env (`E2E_HOME_ROOT=/tmp/dsh-e2e`,
   `E2E_TAPE_DIFF=$PWD/var/e2e-tape-diffs`) and read the real stop;
2. the store tripwire: `assert-store-untouched.mjs snapshot`/`verify`. On my machine `.dsh-chapters/` already
   exists (this session's own store), so the pair cannot fail here — only a pristine checkout can show whether
   the rig writes into the repo root;
3. host install in CI: the script installs the pinned `@deepseek-ai/dsh` project-scoped in its own prefix and
   `dsh --version` must match `tests/e2e/rig-pins.json`; a mismatch throws before any test runs, which fits
   "no verdicts in the log" exactly.
4. the new fatal-on-miss guard: it aborts a leg on a `MISS` written after install. Locally green means no miss
   for my `$HOME`; CI's `/home/runner` paths could produce one if WORKSPACE-BLIND does not cover a new field.

Do not "fix" any of these by loosening a gate. Reproduce, read the line, fix that.

### `heavy` cannot replay because its record run never completed (2026-10-27, measured)

CI-shaped chain: `suite` **4 passed (37.2s)** — the header fix is confirmed — then `heavy` aborts at
`MISS tape=heavy entries=23 messages=4 closest=0009.json commonPrefix=2 divergeAt=msg2`.

That is not a matcher bug and not the header. `heavy`'s re-distill **failed its own leg** (step 4,
`oversized-turn.spec.ts:161`: post-compaction session answers `STILL-HERE` within 300s) after three
`OVERFLOW refused … est=145382–163026 tokens window=32000 — rig-enforced` lines, and its tape froze at 23
entries from +300s onward. A tape distilled by a failing journey is not a recording of the journey; replaying
it and calling the miss the tape's fault would be backwards.

Order of work:
1. make `heavy`'s **record** run green again on the current build (it was green under the harness-profile
   shape this morning, and the leg's own design expects the rig to refuse over-window requests, so the
   difference to chase is what the synthesized `local` row does *not* carry that the ambient row did —
   `retryPolicy.maxRetries: 0` is the first candidate, and `E2E_HARNESS_PROFILE=1` is the toggle that isolates
   it in one run);
2. only then re-distill `heavy` and expect replay to pass;
3. if step 1 shows the refusal really is the product's problem (post-compaction surface still over window),
   that is a product fix with a red row, not a distillation retry.

Also true now and worth keeping: `prompt-off` distills (1 passed, 20.5s) and is in the distiller's `ORDER`;
the `prompt` tape is 14 entries where it had been 546, because `distill-tapes.sh` clears each project's tape
directory first and my ad-hoc `MODE=record` loops had been accumulating instead.

### The corpus tree is currently MIXED across header shapes — do not commit it as the re-anchor (2026-10-27)

Where each leg's tape stands after the placement fix, and what it implies:

| leg | distilled under | state |
|---|---|---|
| `suite`, `arrival`, `enrich`, `fanout`, `rules`, `fork`, `prompt`, `prompt-off` | CI shape (provider `local`) | re-distilled green; replays green for `suite` (4 passed, 37.2s) |
| `heavy` | **harness profile** (`E2E_HARNESS_PROFILE=1`) | passes only in that shape (1 passed, 53.5s); its tape is therefore NOT CI-replayable |

So `heavy` is the last leg to land, and it needs a **row fix, not a re-run**: the synthesized `local` provider
row in `boot.ts` sets `retryPolicy: { mode: normal, maxRetries: 0 }`, which the ambient row does not set, and
that difference alone flips heavy from pass to fail. The decision, in order:

1. remove the `maxRetries: 0` override from the synthesized row (host default) and re-distill **heavy alone**;
2. if the leg then passes in CI shape, re-distill any leg whose behavior depended on that retry suppression —
   the honest default is to re-distill the whole set once, in one command, so the tree has exactly one shape;
3. only then `corpus:stamp` + `corpus:check`, and commit the corpus as one coherent change with the chain green.

Two traps here worth naming: committing a mixed tree would make CI red in a way that looks like flaky tapes (the
`commonPrefix=0` signature again), and "it passed when I changed the toggle" is not evidence that the rig's
default is right — it is evidence that the two shapes differ, which is the thing to eliminate rather than route
around.

### CI's acceptance red is expected while the committed corpus is mixed — do not debug it (2026-10-27)

The tree in `HEAD` was distilled across two header shapes (eight legs under provider `local`, `heavy` under
the harness row), and CI replays whatever is committed. So its `acceptance — ten tape-replay legs` job fails
for a reason already diagnosed, and its annotation cannot tell me anything new. The sequence that resolves it
is fixed by the diagnosis, not by urgency: uniform re-distill (running) → one coherent corpus commit → CI-shaped
chain green locally → read CI again. A red job that was predicted from known state is a checkpoint, not a bug.

### A re-distill must be one pass over a FROZEN regime (learned the hard way, 2026-10-27)

What happened, in order: I committed a global change to the rig's retry regime, launched the uniform distill
under it, discovered the change was wrong for `arrival`, reverted it to a per-leg pin mid-flight, and then
expected the half-distilled corpus to replay. It could not. `suite` recorded 7 entries **with retries on** and
replayed **with retries off**, so it missed at `msg3` — a corpus whose legs were distilled under three different
regimes, and every failure downstream of that looks like a matcher bug or a product bug.

The rule, plainly: the regime set (ports, thresholds, floors, retry policy, provider identity, and now
`hostRetries`) is frozen *before* the corpus is distilled, in one uninterrupted pass, and the pass is what gets
committed together with `CORPUS_HOST`/`BUILD_STAMP`. A regime change discovered mid-distill means the distill is
restarted, not patched leg-by-leg — mixing tapes from different regimes is precisely the "mixed tree" failure I
documented an hour earlier, and I walked into it anyway because the temptation was to fix one leg at a time.

Current state after this lesson: heavy passes with its declared `hostRetries: true` (distill exit=0, 19
entries), arrival's 122-entry junk tape was discarded and restored from git, and one uniform pass over the final
regimes is running.

### `arrival` needed a second distill pass — live-model nondeterminism, recorded (2026-10-27)

First pass under the frozen regimes: `arrival: exit=1`, 41 recorded requests, failing its own assertion with
`model never found the buried token via the artifact tool` (`Expected substring: "EMBED-CENTER-4417"`). Second
pass, same build, same regime: `exit=0`, 10 entries. Nothing in the rig changed between them.

So the leg's outcome depends on the model actually choosing `chapters_artifact` and reading the right offset —
which is the thing the leg exists to test, and also why one capture is not a guarantee. Handling, deliberately:
the corpus now carries a tape distilled from a **passing** run (the rule), and this note is the record that the
leg needed two attempts — not a claim that it is stable. If it fails a third time, that is a product/leg issue to
file with both logs, and re-rolling until green stops being an acceptable answer.

Also from the same pass: `prompt-off` was in the distiller's `ORDER` but its commit landed after the batch had
started reading the script, so its tape is being re-distilled separately rather than left stale — a mixed-regime
corpus is the failure mode I already documented and then still managed to create.

### CI still fails at the knowledge loop while the identical local chain is green (2026-10-27)

State of evidence, so the next round starts from facts:

- Local, in CI's exact shape (`E2E_MODEL=replay npm run test:e2e`, no provider, no credential): **all ten legs
  green, `CHAIN_EXIT=0`**, and the corpus is committed as one change (`2df6704`) with `corpus:stamp`/`check`
  agreeing at `lib=8bb44fc2`.
- CI run `40465462766`: step 8 (`tape replay`) fails, step 7/9 (store snapshot/verify) pass, and the uploaded
  artifact shows the failure is in `suite`'s knowledge loop: `test-results/a-knowledge-loop-…`, plus
  `var/e2e-tape-misses.log` and a `var/e2e-tape-diffs/000.json`.
- The annotation carries no detail lines even after widening the grep, so nothing matched — the grep needs the
  `2026-…` journal form and the `distill:`-style lines too, which is a diagnostics gap to close, not a mystery.
- The artifact's diff pairs a 2-message incoming against a *title* candidate, because `storedCandidates` selects
  by equal message count, not by kind. So it cannot show the divergence: the next probe must compare CI's
  `incoming[0]` against the committed **conversation** tape entry's `prefix[0]` directly, character by
  character, and print the type of each element first (my attempt died on exactly that assumption).

Leading possibilities, none yet evidenced: the runner's model adapter defaults differ (CI's `dsh --version` is
the same pin but the header can still carry a machine-specific token the blinds do not cover), or the header's
skill/tool catalog on a pristine home differs from this machine's installed plugins — which would be a
normalization gap of the same family as AGENTS-BLIND and the workspace/path blinds, and the right fix is a
narrow blind with a red row, never a widened matcher.

### The local-vs-CI header gap is a **build identity** difference, not a config leak (2026-10-27, three hypotheses killed)

Evidence, in the order it arrived:

1. `ls -l dev/dsh-host-lock/node_modules/@deepseek-ai/dsh` was a real directory, and CI's install command was
   run verbatim here (`npm ci --prefix dev/dsh-host-lock --no-save`, then `dsh --version` → `0.2.0-rc.2`).
   Re-distilling `suite` after that still records a **7,276-char** header. So "my host install drifted from
   CI's" is dead.
2. The copy filter in `boot.ts` was allowing `rel === 'storages'` and `storages/workspace.json` from the
   developer's `.dshdev-local`. Excluding them was edited, re-distilled, and measured: still 7,276. **The edit
   was reverted** rather than left in the tree as an unverified "fix" — a change kept because it seemed
   plausible is how a rig accumulates cargo cult.
3. Section-by-section comparison of the two headers: **no heading differs at all**. The divergence is prose
   inside the same sections — CI says `…Prefer showing the primary results within your final response…`, the
   local header at the same offset says `…Tokens prefixed with @ are paths the user explicitly referenced…`.
   Same document structure, different text: that is two **builds** of the client UI packages, not two
   configurations.

So the machine-specific input is which `@deepseek-ai/*` bundle the boot actually resolves. Both
`~/node_modules/@deepseek-ai/` and the lock hold 289 packages, and the home dir additionally contains a linked
`dsh` dev build — the exact shape #89's note describes as "a linked dev build wearing the pin's version string".
The next probe is therefore resolution, not regime: have the boot print, once, the **resolved file path** of the
package that contributes the header (the conversation/client-ui module), and compare that path on the two
machines. If it is `~/node_modules/…` locally, the fix is to make the rig resolve strictly inside
`dev/dsh-host-lock` (an explicit loader path or a barrier directory), and the corpus re-distills once after that.
Until that is measured, do NOT re-distill again hoping for a shorter header, and do not add a blind to mask it —
masking a header that differs by build would hide the fact that the acceptance run and the recorded corpus were
produced by different software, which is the one thing the tape system exists to prevent.

### ROOT CAUSE of local-vs-CI header divergence: the plugin reads this repository's rules tier at boot (2026-10-27)

The local header carries a `## Chapters memory and rules` section at offset 6,389 of 7,276 chars:

> "Before starting a task, run `chapters_rules` … project rules your team approved, plus session rules…"

CI's 2,783-char header contains **no such section**, and the words `rules`/`chapters` do not appear in it. The
section is contributed because `.dsh-chapters/` exists **in the repository under test** — it holds the approved
project rules for this project. A GitHub runner checks out a repo with no rules tier (the CI workflow even
asserts the directory never appears), so the host composes a shorter system header, message 0 of every request
differs, and every tape fails to match. `verify-committed.sh` reported `.dsh-chapters` as PRESENT locally while
I was still hunting the cause.

Five hypotheses were eliminated to get here, all of them plausible, none measured first: host-install drift
(re-ran CI's exact `npm ci --prefix dev/dsh-host-lock`; still 7,276), copied `storages/` (edited the filter,
re-distilled, reverted the change as unverified), header sections (none differ), the once-per-repo
`var/e2e-profile-base` (deleted and rebuilt; still 7,276), and inherited `DSH_PROFILE_DIR` (real leak-surface,
fixed as `rigChildEnv` with two rows, but not the cause).

The fix is isolation, not normalization, and it must NOT be a blind that masks the section — masking it would
hide that the acceptance run and the corpus were produced by different repository state:
1. decide what the rig's workspace must be for the plugin's own store/rules domain. `#61` pinned
   `artifactStoreRoot` per port, but the rules tier still resolves to the workspace's `.dsh-chapters/`;
2. either run each leg in a pristine workspace (no rules tier, no chapters) — matching CI and what a real user
   gets on a fresh project — or seed an identical rules fixture into the rig workspace so local and CI compose
   the same header. Either way the choice is made once, in the rig, before the corpus is re-distilled;
3. then one frozen-regime distill, then the CI-shaped chain, then CI is expected to match without any change to
   a test.

Until then the corpus in `HEAD` is unreplayable on CI, and the local chain's green is not the same claim.

### Narrowed: the section is contributed at boot with no rules on disk in either home (2026-10-27)

Two more measurements, both cheap and both local:

- **Present from the first request.** All 14 conversation-header entries in the `suite` tape carry the section
  (one aux entry at 1,692 chars is the only header without it). So it is composed at boot, not mined mid-run —
  enrichment timing is ruled out.
- **No rules exist to read.** The suite boot's home (`/tmp/dsh-e2e/e2e-home-41731`) has no `knowledge/` mirror
  and no `rules/` directory at all. The only rules file anywhere under the rig roots is
  `e2e-home-41735/chapters/rules/dev2/001-security-…md`, which is the **rules leg's own fixture** on its own
  port — exactly where it belongs, and unrelated to `suite`.

So: locally the plugin contributes its rules/chapters instruction section when there is nothing on disk to
back it; a CI boot contributes no such section. That is either (a) the section's gate ignoring the empty-store
case and emitting the boilerplate anyway, or (b) a genuine per-boot difference in which plugin rows mount. Both
are answerable by the plugin's own report — `/chapters-status` prints the store root, the mirror root and the
rule counts in every state, including unlinked — so the next probe is to run that command inside a rig boot on
each machine and compare its output, then write a red row against whichever side is wrong. No blind, no
matcher change, until the gate is understood.

### CONFIRMED with a positive control: the repo rules tier was the header divergence, and the store-root fix removed it (2026-10-27)

The `diagnostic('rules-section', …counts…)` line I added after the empty-guard is the measurement, and the
batch supplied both halves of it:

    port 41735 (rules leg)  contributing: project=1 session=0 categories=1 projectKey=b08a5d89-…
    port 41731 (suite)      (no line)
    port 41739 (prompt)     (no line)

The control proves the instrument fires when the section is contributed, so its absence on `suite` and `prompt`
means those boots genuinely do not compose the section any more — which is the effect of the resolver fix:
`mined-rule capture` and `/chapters-repair` were doing `join(cwd, artifactStoreRoot)`, so the rig's **absolute**
per-port root became a path *inside the repository under test*, and the rules tier sitting in this repo was
being read into message 0 of every request. A GitHub checkout has no such tier, hence 2,783 chars there against
7,276 here, hence every CI replay miss with a locally green chain.

All ten legs then re-distilled green under the frozen regimes (`FROZEN_EXIT=0`), and the claim being tested now
is the only one that matters: the same corpus replaying under `npm run test:e2e:replay` with no provider and no
credential, run twice, and then on CI.

### Current truth of the pipeline (2026-10-27, after the confirmed header fix)

- All ten legs **distill** green under the frozen regimes (`FROZEN_EXIT=0`).
- `npm run test:e2e:replay` locally: **suite green, heavy reproducibly red** — `MISS tape=heavy entries=25
  messages=3 closest=0001.json tied=[0001,0003,0004,…]`, identical in two consecutive runs. The chain uses
  `&&`, so nothing past `heavy` has a replay verdict at all; no claim is made about them.
- Therefore the corpus is **not** committed and `CORPUS_HOST` is **not** stamped. The earlier commit
  `2df6704` is stale against current code (it predates the store-root and selector-hook fixes) and I am leaving
  it in history with this note rather than amending it.
- Next measurement, not another theory: run `LEG=heavy MODE=replay` with `E2E_TAPE_DIFF` and compare
  `incoming[2]` against the **same-kind** stored candidate (the previous diff pairing was useless because
  `storedCandidates` selects by message count, so a conversation request was matched against a title request —
  that selection should be filtered by role/kind before comparison, which is itself a small rig fix).

### `heavy`'s replay divergence is compaction TIMING, and the mechanism line is in the sink (2026-10-27)

`var/e2e-engine-errors-41733.log` around the replay:

    [realm:engine:decline] relief declined while the surface is over the trigger (surface=47256 trigger=16000 window=32000 …)
    [realm:engine:compactIfNeeded] decided: compaction … (trigger="context-overflow")

So relief was declined at the pressure check and the overflow path compacted a request later than the recorded
run did — the surface then carries a checkpoint notice where the tape carries reading turns, and the request
diverges at message 2 of 5. `heavy` is the leg deliberately parked ON the compaction boundary (threshold 0.5,
arrival floor pinned to 1M so arrival cannot relieve it), which is why it is the only leg where timing is
visible at all; every other leg replays fine.

This is NOT a blinding job: masking a compaction that fired at a different step would let the tape certify a
conversation that did not happen. Two honest options, in order of preference:

1. **Make the boundary deterministic in the rig.** The record and replay paths must reach the pressure check at
   the same request index. Whatever makes replay arrive at a different surface size — instant tape answers
   skipping wall-clock gaps, the decline branch, or an aux call ordering — should be pinned by a row asserting
   "the heavy session compacts at request N in both modes", measured from the sink, not argued.
2. **Re-scope the leg's boundary** so it sits between two compaction points instead of on one, with the claim it
   makes restated to match (compaction happened, surface recovered, session stayed healthy). The current
   assertions already claim exactly those three things; the brittleness is in where the reads are placed.

Option 1 is the right one if achievable, because it preserves what the leg proves. Either way the corpus stays
unstamped and `heavy` stays red in the chain until it is fixed — no skip, no widening.

### Autorun's idle edge: measured to the edge of what the host exposes (2026-10-27)

Props the dock actually receives (printed once, then the probe was removed):
`usePanelInfo, useSessions, useSessionStatus, useWorkspaces, useResource, useSessionRetainInfo, sessionId,
inputActions, useSession, useConversation, useInput, useTrajectory, useChat, useProjection,
renderFactorySlot, exec, session, input`.

So `useSessionStatus` IS provided — my first two guesses (scalar prop, absent hook) were both wrong. But
calling it with an identity selector yields an object with **no enumerable keys** (`statusKeys=` empty), so
`deriveRunning` has nothing to fold and `running` stays `undefined`, which keeps Autorun disabled. The leg now
asserts arm-ability and stays red on that assertion: the honest state is "not shipped, and the reason is
measured", not "works" and not "removed because inconvenient".

Next attempts, cheapest first: (1) `useSession` / `useChat` / `useConversation` are alternates carrying status
in this host family — try the same identity-selector read on each and print key counts once; (2) if all are
opaque, the dock hook contract needs a selector the host understands (a projection name, like the goal bar's
`useProjection("goal")`), and `docs/contract.md` § "What a dock component is handed" should record which;
(3) only if none work, `#126` grows a second paragraph: the dock cannot observe idle or write the composer, so
Autorun is not arm-able on 0.2.0-rc.2 and the bar ships with that stated.

### Correction: `heavy`'s compaction boundary IS deterministic; the suspect is notice content (2026-10-27)

I wrote that replay "compacted one request later than the recorded run". The sink says otherwise — record at
08:43:45 and replay at 08:46:02 log the **same** surfaces in the same order:

    relief declined … (surface=33900 trigger=16000 window=32000 ratio=0.5): no safe…
    relief declined … (surface=47256 trigger=16000 window=32000 ratio=0.5): no safe…

Identical numbers mean the engine reached the same decisions in both modes, so a timing/boundary theory was
wrong and option 1 ("pin the boundary") is not the fix. What remains, consistent with every byte diff so far,
is that the **checkpoint notice text itself** differs run to run (how many chapters are listed, the archive
count) — and that notice is part of the surface, so it changes est tokens for everything after it and the
request sequence stops matching the tape's, even though each individual volatile piece is now folded for
*MATCHING*. Matching and surface-size are different consumers of the same bytes: blinding the count lets a
request match; it does not make the surface the same length.

Therefore the right question is product-side and narrow: should the checkpoint notice's chapter list be
byte-stable for a given session state (fixed cap, stable ordinals), or is `heavy` asking for determinism the
notice never promised? Answer with a red row that measures two runs' surface sizes from the same session state,
not by adding another blind.

### Ties are the disease, not the cure: `heavy` now ties FIVE entries and still misses (2026-10-27)

After re-distilling cleanly on the current build (`suite` 33, `heavy` 27, `arrival` 18, `enrich` 3 — the first
batch had been contaminated by strays I killed too late), the strict chain gives:

    MISS tape=heavy entries=27 messages=7 closest=0003.json tied=[0003,0004,0005,0006,0007,…]

`suite` passes. `heavy` sits exactly on the compaction boundary, so its surface contains a checkpoint notice
whose chapter list grows with every extra compaction. My two folds (archive count, TOC line count) make those
surfaces **equal as match keys**, which is what produced five tied candidates — and when several tape entries
tie, the proxy may serve bytes recorded against a different surface size, so the following request diverges.
The pair run passed only because that capture happened to be small (4 entries) and unambiguous.

Conclusion, stated as the constraint it is: more masking makes matching weaker and replays less faithful, and
`heavy` cannot be made deterministic by blinding its way through. Two real options remain, both needing a red
row first:

1. **Byte-stability in the notice itself** — render the chapter list from a deterministic cap and stable
   ordinals so identical session state yields identical bytes on any machine. This reduces ties at the source
   instead of papering over them, and it is a product property users get too (a notice that changes for no
   reason is a cache-cost bug, not a cosmetic one).
2. **Move `heavy`'s reads off the boundary** so the journey's surfaces are not decision-sensitive. The leg's
   three claims (compaction happened, surface recovered, session stayed healthy) survive unchanged; only the
   placement of the oversized reads moves. This is NOT deleting, skipping, or widening the assertion — if any
   variant of it would let a real compaction failure pass, it is the wrong fix and must be refused.

Also recorded because it was my error and it cost a batch: strays from an aborted chain were still holding the
per-leg ports while the first four legs re-distilled, which is why `suite` produced a 6-entry tape that missed
its own replay. Check `pgrep -f "playwright test"` is empty BEFORE starting a distill, not after.

### The header divergence is Node's ANCESTOR WALK, and `HOME` cannot fix it (2026-10-27)

Measured, in order:

- The boot spawns `dsh web` with `cwd: ROOT` (the repository under development). Node resolves bare
  specifiers by walking ancestors of the importing file, and the walk from `/home/adrian/Projects/dsh-chapters`
  passes `/home/adrian/node_modules` — **289 `@deepseek-ai/*` packages, including a linked `dsh` dev build**
  (home `dsh-agent` = `0.2.0-rc.2`, repo root `dsh-agent` = `0.1.5-rc.2`, lock = `0.2.0-rc.2`).
- A CI checkout walks `/home/runner/work/dsh-chapters/dsh-chapters` → `/home/runner/work` → `/home/runner` →
  `/home` → `/` and finds no `node_modules` at any of those levels. Same pin, same version string, different
  available bundles → different mounted plugin set → different system header: 7,276 chars here against 2,783
  there, diverging 141 characters in (right after the identity/model line), with **no section headings
  differing at all** — prose in the same slots.
- Two fixes I already ruled out by measurement: re-running CI's exact `npm ci --prefix dev/dsh-host-lock`
  (unchanged, still 7,276), and `npm ci` at the repo root (unchanged, still 7,276). Setting `HOME` to a scratch
  directory would also do nothing: the walk is over the **path**, not the environment variable.
- This is the same class #85 described for a home under `var/` — "a linked dev build wearing the pin's version
  string" — and that fix moved the *home* to `/tmp` but left `cwd: ROOT`, so the walk still reaches the
  developer's tree. #89 fixed the **binary**; the **module resolution path** was never closed.

Two honest ways to close it, both needing a red row that pins the composed header length (or better: pins the
mounted-plugin list) so a drift fails loudly instead of producing a machine-local corpus:

1. **Distill in a CI-shaped location.** Run the rig from a scratch clone whose ancestors contain no
   `node_modules` (e.g. under `/tmp`, with the same `npm ci` steps `scripts/ci-replay.sh` runs). The corpus then
   has the header every replay environment can reproduce. Cost: distilling outside the working copy, which my
   per-port absolute store roots already support (#69) — and the workspace-relative `read` paths a leg uses
   must still resolve, which they do for a clone of the same commit.
2. **Cut the walk at the repo.** Give the boot an isolated module root — e.g. spawn with `cwd` set to a scratch
   workspace and pass the repo path to the leg explicitly — so no ancestor above the repo can supply a bundle.
   This is the cleaner long-term rig property (the boot should never be able to see `~/node_modules`), but it
   changes what `cwd` means for every leg and so needs the leg-side workspaces audited first.

Until one of them lands, **no corpus committed from this machine is CI-replayable**, and the honest status is:
local strict chain is what a local machine can prove (nine legs green, `heavy` red on ties), while CI fails at
`suite` with `commonPrefix=0` — the same number, a different meaning from the earlier proxy fault: the header,
not the endpoint.

### The CI-shaped probe was inconclusive — recorded as inconclusive (2026-10-27)

Ran `suite` replay from a clean clone at `/var/tmp/dsh-probe` (no `node_modules` in its ancestor path, the
property CI has). Outcome: **4 failed**, but the failures were `example.spec.ts` ("has title", "get started
link") and `discovery.spec.ts` — the page-load scaffolding — and there was **no `MISS tape=` line at all**. So
the clone's browser/app environment was broken before the tape matcher could say anything, and the run neither
confirms nor refutes the ancestor-walk theory. Two facts it did establish:

- A fresh clone could not boot at all until `4b66a29` (the `.dshdev-local` ENOENT stack trace is the red
  evidence for that fix), so this experiment was not runnable before it.
- `E2E_PROVIDER=harness` in a clean clone refuses correctly (no ambient profile → no route), which is the
  intended guard, and CI's shape needs no provider because replay never authenticates.

What would settle it, cheaply and in one run: reproduce the page-load failure first (most likely the Playwright
browser path — CI installs browsers into the workspace cache and the rig's `e2e-one.sh` may expect them there),
then rerun the clone's `suite` replay and read whether `msg0` diverges. The claim on the table stays exactly as
recorded above: same pinned host, different available bundles, different composed header — a hypothesis with
strong code-level support and no A/B yet, so no committed tape set may be called CI-replayable on its strength.

### CONFIRMED by A/B: the same tape replays green here and misses in a CI-shaped clone (2026-10-27)

Same commit, same 33-entry `suite` tape, two locations:

- `/home/adrian/Projects/dsh-chapters` (ancestors include `/home/adrian/node_modules`, 289 `@deepseek-ai/*`
  packages): `LEG=suite MODE=replay` → **4 passed**.
- `/var/tmp/dsh-probe` (a clean clone; no `node_modules` at any ancestor level; same pinned host installed with
  CI's own `npm ci` commands, same `npm run build`, same Playwright browser build copied into `var/ms-playwright`):
  `LEG=suite MODE=replay` → **`MISS tape=suite entries=33 … tied=[every entry]`** — which is precisely CI's
  signature, reproduced locally without a push.

So the ancestor walk is not a hypothesis any more: the machine that records a corpus changes message 0, and a
tape recorded here is unreplayable where the runner has no developer tree. Two practical consequences, both
already paid for elsewhere in this repo: the rig's `WORKSPACE-BLIND` fold is what lets tapes from either path
compare at all, and the distill must therefore run in a CI-shaped location, not in the working copy.

Also worth keeping: my first two probe runs failed for reasons that had nothing to do with the theory — no
browsers in the clone (`var/ms-playwright` is gitignored and the workspace cache is per-checkout) and a `cp -a`
whose error I had hidden behind `2>/dev/null`. Both looked like "the experiment refutes the theory" until I read
the error text. An inconclusive run and a refutation are different results, and only one of them is interesting.

### The scratch distiller reaches the model but `suite` stalls in the clone — next thing to diagnose (2026-10-27)

What the CI-shaped run proved and what it did not:

- **Proved:** the ancestor walk is the header cause (green here / `MISS … tied=[every entry]` there for one
  33-entry tape), the credential chain works once `.dshdev-local/e2e.env` is placed in the clone, and the
  sync-back guard did its job: the distill never exited 0, so nothing was copied over the working corpus and the
  committed tapes are intact at 33 files.
- **Did not:** produce a corpus. `suite` recorded 5 entries in ~3 minutes with clean `status=200` responses, then
  went silent — no model traffic for 11 minutes while Playwright sat inside test 1. The clone's server log shows
  the last turn ending normally and this line from the bar:

      [chapters-prompt] prompt: not enabled (no defining model) — round skipped

  which is a *different* machine-local difference: the working copy has a `promptModel` row in its ambient
  profile, the clone composes without one. So the clone is not yet a faithful recording environment for legs
  whose journey touches the suggestion bar, and I stopped the run rather than let it burn a timeout.

Order for the next attempt, cheapest first: (1) make the route/prompt-model configuration part of the rig's
seeded profile rather than ambient state, so clone and working copy compose the same thing — this is the same
class as everything else today, authority in tracked seeds; (2) confirm with `suite` alone that the fork door
appears in the clone; (3) only then run the full ten legs there, then the strict chain there, then stamp and
commit. Do not assume a stall means "slow": the journal said the last request finished 11 minutes earlier.

### Clone stall: located to `a-knowledge-loop.spec.ts:41`, but NOT yet explained (2026-10-27)

Established by measurement, including two of my own wrong inferences corrected in place:

- The clone's `suite` leg stalls at `a-knowledge-loop.spec.ts:41` after 5 tape entries; the last model traffic is
  `DONE status=200` and the server's last line is `turn/end sighted seq=35`, so the turn completed and the journey
  moved past it. Silence then lasts 10+ minutes with no further requests.
- **Wrong inference #1 (mine, from an hour ago):** `[chapters-prompt] prompt: not enabled (no defining model)` is
  printed by BOTH the local and the clone boot, so `promptModel` is not the clone difference. I had written it up
  as the next fix; it is not, and that correction is in the commit that followed.
- **Wrong inference #2 (partly):** I expected my new bounded door assertion to fail fast and name the door. It has
  not produced a failure, so the stall is not obviously the door click — it is somewhere later in the journey
  (the pool push/search steps are the remaining candidates with long polls), or the assertion is being satisfied
  and the wait is downstream.

What would settle it, and is the next action: run the clone's suite leg with Playwright's reporter verbose plus a
shorter per-test timeout (or split the spec's steps), and read which `expect.poll` is live when it hangs — the
sink and journal already show there is no model traffic, so it is a browser-side wait. Do NOT re-run the full
ten-leg scratch distill until that is answered; a batch that stalls on leg 1 for 5,400s produces nothing and the
sync-back guard (correctly) refuses to copy anything.

Also true and worth keeping: the guard worked as designed — the earlier scratch failure synced nothing back and
the committed corpus is intact at 33 suite files, because I restored it with `git checkout` after the first
destructive version of the script.

### Clone stall, labeled: the knowledge loop's FIRST turn never ends; 3 of 4 suite tests pass there (2026-10-27)

Running the clone's `suite` with a short per-test timeout and the line reporter produced the label the hang
never would:

    Error: expect(received).toBe(expected)   > 841 | await expect.poll(turnSeen, { timeout: turnMs, … },
        'this session's own log shows turn/end')
      1 failed · 3 passed (12.3m)

So in the CI-shaped clone the other three suite specs pass, and the knowledge loop dies waiting for `turn/end`
on its FIRST turn. Supporting measurements, all from the clone's own artifacts:

- Model traffic is healthy up to a point: `DONE status=200` for requests growing `msgs=7 → 10 → 13` (the read
  loop), last response 47,568 bytes at 11:56:59, then **no further requests for ~11 minutes** while the test
  waited. So the stall is not a slow endpoint and not a refused overflow.
- The engine sink's last lines are `compactIfNeeded entered (trigger="pressure")` followed by
  `decided: none` — pressure was seen and relief declined, then silence.
- Ruled out since: `promptModel` (both boots print the same `not enabled` line), port collision between the
  clone and the working copy (`ss -ltn` shows nothing on 417xx now, and the legs use per-project ports), and
  "the door click hangs" (the bounded door assertion I added never fired — the journey does not reach it).

Next probe, which is the only thing that can answer this: run the clone leg with the throwaway home PRESERVED
(the boot deletes `E2E_HOME` at teardown — that is why every diagnosis so far has been second-hand), then read
that session's own log for the last event before the silence: whether a tool call is mid-flight (a `git push`
against the http-git remote, or a `read` on a path that exists in the working copy but not in the clone) or the
engine is waiting on the declined relief. My suspicion, stated as suspicion and not as a finding: the journey's
later steps use workspace paths, and a clone at `/var/tmp/dsh-rig` has a different absolute root, so a step that
resolves a path against the ORIGINAL working copy would block. That is testable in one preserved-home run.

### The clone's knowledge loop DID complete — the stall is in the rig's own session adoption, not the product (2026-10-27)

Read directly from the surviving throwaway home (`/tmp/dsh-e2e/e2e-home-41731`, 44 events, `session-57b99de0…`,
the same id the engine sink named during the stalled run):

    user/message seq 10: "Which file defines the chapter composer merge rule? …"   ← the needle, present
    … tool/result seq 37 …
    turn/end   seq 43: {"turn":1,"reason":{"kind":"completed"}}                    ← the turn, completed

And the assertion still reported `Expected: true / Received: false` after `Timeout 720000ms exceeded` at
`tests/e2e/session.ts:841` (`turnSeen`). Two sessions exist in that home: the journey above, and a 6-event one
whose last events are a `chapters-prompt … state` command run. `turnSeen` needs
`user/message` with `seq > preSeq` carrying the needle **in the log it is reading**, so the predicate was pointed
at the wrong session (or read an empty log) for twelve minutes while the work finished elsewhere.

Why this matters more than the clone question: `newSessionWithTurn` is the rig's shared entry helper, used by
almost every leg. A poll that can silently watch the wrong session is a false-red generator — and the #77
comment in that same function records it happening before, on cold homes, with a passing run nobody could see.
The fix is rig-side and testable: when the poll gives up, the diagnostic must print the ids it tried, what
`listRecentSessionIds()` returned, and the byte length of `sessionLogTextById` for each — the four-facts message
that #61a promised exists for exactly this situation, and which did NOT appear in this run's output. Finding out
why the diagnostic was swallowed is the first step; it is the instrument this repo's own rule demands ("a
detected failure is a delivered failure").

Sequence I will follow: (1) restore/extend that failure diagnostic so it always prints the per-id evidence;
(2) add a row for the two-session case (needle in session B, spec holding session A ⇒ helper adopts B);
(3) then re-run the clone's `suite` — a CI-shaped corpus is the goal, and the clone is not CI-shaped-broken, it
is being mis-read by my own harness code.

### Confirmed: the session-scan fix makes the clone's `suite` pass (4 passed, 1.7m, 38 entries) — and it exposes the next decision (2026-10-27)

Same clone, same command, one change (`sessDirs` returning absolute paths and unioning every workspace dir in
the boot's home): the journey that had completed unseen for 720 seconds now finishes in 1.7 minutes. So the
stall was the rig's own blind read, exactly as the preserved home showed.

**The consequence to decide before the next big run.** A corpus recorded in the clone replays there, and CI is
CI-shaped — but my working tree is NOT, because the pinned host the boot spawns lives at
`ROOT/dev/dsh-host-lock/node_modules/.bin/dsh`, and Node's ancestor walk from inside the repository reaches
`/home/adrian/node_modules` (289 `@deepseek-ai` packages). That is what made the header 7,276 chars here and
2,783 in a clone. So:

- If I record in the clone and sync back, **CI goes green and `npm run test:e2e:replay` in the working copy
  goes red** — a corpus that only replays where it was not recorded.
- The right fix is to remove the asymmetry, not choose a side: put the rig's host install OUTSIDE the repository
  (e.g. install the pinned lock under `/tmp/dsh-e2e/host-<pin>` and spawn that binary), so the working copy and a
  CI runner resolve the same bundles and compose the same header. `resolveHostBinary` already reports which
  binary it used and whether it is pinned (#89), so the authority exists; what is missing is an install location
  whose ancestors are clean.
- Interim honesty: until that lands, "chain green" must name its location. A local green and a CI green are
  currently different measurements, and I will not call them the same result.

### The runner mounts 7 tools and it is STABLE — not a race (2026-10-27, three-request dump from CI itself)

CI's artifact `var/e2e-header-suite.log` now contains more than one request:

    chars=2893 tools=7      ← the conversation request (its aux sibling is `chars=396 tools=0`)
    chars=396  tools=0

and locally the same two lines read `chars=7396 tools=34` / `chars=396 tools=0`. **The aux header is identical on
both machines**, so the host and its prompt machinery agree; only the agent assembly differs, and it differs
consistently rather than drifting — which rules out the mount-timing race I raised as the leading alternative.

Every environment level I can measure is equal, with numbers, not narrative:

| level | this host | CI runner |
|---|---|---|
| host lock deps | `declared=79 missing=0` | `declared=79 missing=0` |
| installed at lock root | `deepseek-ai-packages=289`, `installed-top-level=179` | same |
| repo-root `@deepseek-ai` | 34 dirs (18 undeclared by package.json) | report uploaded (same script) |
| profile base tree | `node_modules=2 deepseek-ai=0 @treeseed=1` | built by the same `bootstrap-dev-profile.sh` |
| host provenance | lock resolves to `registry.npmjs.org/…/dsh-0.2.0-rc.2.tgz`, integrity matches `npm view` | same tarball |
| pinned host install | `npm ci --prefix dev/dsh-host-lock` (CI's own command) | same |

Refuted as causes, each in one run: ancestor `node_modules` walk (a clean clone at `/var/tmp`, with zero set
difference in installed packages, composes the LONG header), `$HOME` state (reran with `HOME=/var/tmp/clean-home`
— unchanged), external host install location (`E2E_HOST_DIR`, 2 rows, unchanged), header prose or section
headings (zero CI-only sentences: CI is a strict subset), and the "profile plugins decide it" story once the
profile-base counts came back equal.

**What this means for the objective, stated without softening:** a corpus recorded on any machine that mounts 34
tools cannot be replayed by a runner that mounts 7, because message 0 is the tape key. So either (a) the
assembly difference is found and the rig mounts identically everywhere — the remaining candidates are the
session's `permission/preset` / `sandbox/mode` / `approval/policy` kernel events and anything the profile's
`settings.yaml` seeds differently, which is a code read of the host's assembly path rather than another
environment A/B; or (b) the corpus is recorded BY the runner, which needs the route credential as a repository
secret — a maintainer action and the exact blocker issue #56 records ("no credential for the runner"), so I am
naming it as your decision rather than working around it. I have not added a blind to mask the header, and I do
not intend to: masking it would certify a corpus recorded by different software than the one that replays it.

### The two machines do NOT mount the same plugin list — and the id that differs is untracked (2026-10-27)

The boot now reports its own mounted tree (`var/e2e-home-plugins-<port>.log`), so this is read from artifacts,
not inferred:

    CI:    patchPluginIds=preset-chapters,agent-preset-registry,'@treeseed/dsh-chapters',llm-pi-ai,
           agent-default-model,llm-gate,fetch-timeouts,ui-settings-general
    local: patchPluginIds=preset-chapters,agent-preset-registry,'@treeseed/dsh-chapters',llm-pi-ai,
           agent-default-model,llm-gate,fetch-timeouts

`ui-settings-general` appears in **no tracked file**: `tests/e2e/fixtures/dev-profile-cordis.patch.yml` (0),
`.dshdev-local/profiles/web/cordis.patch.yml` (0), and it is present in the AMBIENT `~/.dsh/profiles/web/
cordis.patch.yml` (2 occurrences). So a booted home's plugin list can be inherited from developer state, and the
two machines' assemblies are not the same input — which is precisely the class that has produced every
local-green/CI-red result in this session.

Everything else is now eliminated with numbers rather than argument:

- installed bytes: `topVersion=0.2.0-rc.2`, `checked=289 mismatched=0 allIntegrityMatch=true` — on BOTH machines
  (each installed package's embedded dist integrity equals its lockfile entry).
- host's own `request/header`: `config` and `adapterDefaults` differ in **0 keys**; the aux header is `chars=396
  tools=0` on both; the conversation header is `chars=7396 tools=34` here vs `chars=2893 tools=7` there, and it is
  STABLE across requests, so it is not a mount race.
- theories killed by a run this round: `CI=true`/`GITHUB_ACTIONS` (no effect), `NODE_PATH` (not set locally at
  all), undeclared repo-root packages (34 on both, and they are hoisted transitives), the pre-boot
  `profile-base-node_modules=0` reading (an order artifact — the boot reports its own tree now instead).

Next step, and it is a rig fix with a row, not another A/B: make a booted home's plugin list derive ONLY from the
tracked seed — assert in a row that `patchPluginIds` equals a fixed expected list, so a machine that injects an
extra ambient id fails instead of quietly recording a corpus no runner can replay. Then re-check the tool count
from the header dump: if registering `ui-settings-general` (or any ambient id) is what moves 34 to 7, the
asymmetry is closed by construction and the corpus becomes portable.

One honest process note: the previous commit claimed an integrity scan that had NOT been applied (a silent
python-heredoc failure I read past). The scan exists now, verified with `checked=289 mismatched=0`, and the
correction is in that commit's message. The probe run with `env -u NODE_PATH` also failed at boot
(`e2e boot failed within 60s (port 41737)`), which was a port/env transient and is NOT evidence about tools —
recorded so nobody reads a failed run as a result.

### Like-for-like at last: same project, two machines, different mounts (2026-10-27)

Correcting my own earlier comparison (CI's `suite` against my `fork` — not the same project, so the plugin-id
difference I announced was not yet proven):

| `suite` booted on | header | tools | plugin ids |
|---|---|---|---|
| this host | `chars=7396` | 34 | `preset-chapters, agent-preset-registry, @treeseed/dsh-chapters, llm-pi-ai, agent-default-model, llm-gate, fetch-timeouts` |
| the runner | `chars=2893` | 7 | same **plus `ui-settings-general`** |

So for the same project the runner mounts one MORE plugin and gets 27 FEWER tools. `ui-settings-general` is in no
tracked file (seed 0, dev-home 0, ambient `~/.dsh` 2) — so the file the boot ends up with is being modified by
something other than our seeds, most plausibly the host writing its own defaults into
`profiles/web/cordis.patch.yml` at startup when the home lacks them.

Consequence and next measurement, in that order: the boot's mount report should be taken TWICE — once at the
moment the URL appears and once after the journey's first turn — so we can see whether the id list is what the
seed wrote or what the host rewrote, and correspondingly whether tools grow or shrink. If the host rewrites the
patch, the rig must pin it (write, verify by re-read, and refuse to boot if the ids differ from the tracked
list) — that is the row this whole investigation has been driving at: **a booted home's plugin list is a rig
fact, not ambient state.**

### The profile patch is rewritten DURING the run — so single-reading comparisons were unreliable (2026-10-27)

Same file, same boot, two moments: `count=43` at URL-ready, `count=44` after the journey. The host expands or
repairs `profiles/web/cordis.patch.yml` mid-flight.

Therefore, correcting myself again: my claim that "the runner mounts `ui-settings-general` and this host does
not" was drawn from a single boot-time reading on each side and is **not** a reliable machine comparison —
locally that id appears only after the run. The genuine, still-unexplained asymmetry is unchanged and remains
the thing to chase: for the same project, `tools=34 / chars=7396` here against `tools=7 / chars=2893` on the
runner, with the same 21 `tool-*` rows present in both boot-time patches and `config`/`adapterDefaults`
identical.

Next read, from CI's own two-phase artifact: does the runner's patch also grow mid-run, and does its tool count
at request 1 match its boot-time id set or the later one? If the runner's id set is stable at 43 and tools stay
7, the failure is runtime mounting (silent), and the rig must surface it — e.g. by having the plugin print the
registered tool names at boot into the per-port diagnostics, which the artifact already uploads.

### Elimination table: what the 34-vs-7 tool gap is NOT (2026-10-27, all measured)

The gap is real and stable, and it is the reason a locally recorded corpus cannot replay on the runner (message 0
is the tape key). Everything below was a hypothesis I raised and then killed with a run rather than an argument:

| hypothesis | how it was refuted |
|---|---|
| host install is a dev build wearing the pin | lock `resolved:` = `registry.npmjs.org/…/dsh-0.2.0-rc.2.tgz`, integrity equals `npm view`; both report `topVersion=0.2.0-rc.2` |
| deps differ on disk | both: `declared=79 missing=0`, `deepseek-ai-packages=289`, `installed-top-level=179` |
| package CONTENT differs | both: `checked=289 mismatched=0 allIntegrityMatch=true` |
| undeclared repo-root packages | both report `repo-root-deepseek-ai=34`, 18 undeclared (hoisted transitives) |
| profile plugin list differs by machine | two-phase boot report: runner `44 at boot / 44 late`; here `43 at boot / 44 late` — same final set, and `ui-settings-general` appears mid-run on both |
| mounted tool rows missing on the runner | both patched profiles contain the same 21 `tool-*` rows (`tool-bash, tool-fs, tool-goal, tool-jobs, tool-subagent*, tool-web, tool-workflow, …`) |
| ancestor `node_modules` walk | a clean clone at `/var/tmp` (no `@deepseek-ai` at any ancestor) still composes `7396/34` |
| `$HOME` state | reran with `HOME=/var/tmp/clean-home`: unchanged |
| ambient-profile leak (`DSH_PROFILE_DIR`) | `rigChildEnv` strips it (2 rows); unchanged |
| external host install location | `E2E_HOST_DIR` preferred when set (2 rows); unchanged |
| CI environment flags | `CI=true GITHUB_ACTIONS=true`: unchanged |
| `NODE_PATH` | not set in this environment at all |
| record-vs-replay mode | local `suite` replay in CI shape AND in harness shape both dump `7396/34` |
| host config / adapter defaults | the host's own `request/header` event: `config` and `adapterDefaults` differ in **0 keys**; aux header identical (`396/0`) on both |
| mount timing race | the runner's tool count is 7 on every captured request, and its patch is 44 ids at both phases |

What is left: the runner boots the identical host, identical bytes, identical profile, and registers only our
plugin's 7 tools, while this host registers 34 — with no error anywhere in the boot's output (CI's server log is
292 bytes, just the URL line). The next instrument worth building is therefore not another environment A/B:
capture the mount FAILURE itself, e.g. have the rig ask the host to report per-plugin load results (the loader
knows which `tool-*` rows it resolved) and fail the boot when a `tool-*` row in the profile does not appear in
the registered tool list. That is a red row with a real assertion, it converts a silent gap into a loud one, and
it is the version of "a detected failure is a delivered failure" that this incident needs.

Until that gap is closed, no corpus recorded here is replayable by the runner, so item (2) of the objective
cannot be satisfied by re-distilling harder. Local-only items that ARE still actionable: `heavy`'s ties,
`coverage:e2e`, and the Autorun-displaces-goal pixel.

### `heavy`'s divergence, profiled: same notice at msg1, different turn AFTER it (2026-10-27)

Captured with `E2E_TAPE_DIFF` (message counts equal, so the pairing is valid this time):

```
LIVE  (5 msgs): system 7276 | notice 1005 | assistant 77   | user 104 | user 314
TAPE0 (5 msgs): system 7276 | notice 1005 | assistant 300  | tool 15  | user 314
TAPE1 (5 msgs): system 7276 | notice 1005 | assistant 300  | tool 15  | user 314
TAPE2 (5 msgs): system 7276 | notice 1005 | assistant 300  | tool 15  | user 314(?)
```

What that says, and what it rules out:

- **msg0 and msg1 are byte-identical across all candidates** — the header and the checkpoint notice match exactly,
  so this is not the header, not a volatile count, not the TOC fold, and not the ordering race I closed last
  round (that race was real; it was not this).
- The divergence is **one turn later**: the tape's surface continues with the reading assistant turn plus its
  tool result; the live surface continues with the final `STILL-HERE` turn. Same notice, so both runs DID compact
  — but at different message indices, i.e. the compaction boundary sits one assistant/tool round apart between
  record and replay even with served bytes identical.
- Therefore the remaining mechanism is in **when the engine decides to compact**, given an identical surface: the
  only inputs left are est-token drift (which depends on bytes that already match) and the bounded-loop/relief
  path (`relief declined … surface over trigger`, then a later `context-overflow` compaction — the sink shows the
  same two surface sizes in both modes, so a *later* decision point is plausible while the decline itself is
  identical).

Next instrument, and it is small: assert the compaction index directly. During distill, record the message index
at which each `compaction/summary` event lands for this session; during replay, assert the same indices before
the journey proceeds. If replay can be made to compact at the recorded index, the leg is deterministic and the
tape matches; if it cannot, the boundary is genuinely non-replayable and `heavy`'s oversized reads must move off
it — restating the leg's claim only as "compaction happened, surface recovered, session stayed healthy", which
is what it already asserts, with the reads placed between boundaries. Either outcome is decided by the
assertion, not by another fold, and no blind over `msg2` is acceptable: it is the only message that still carries
information about where the boundary fell.

### Where the corpus stands after the 0.9 change (2026-10-27)

`heavy` is fixed and pair-verified twice under the new trigger (4 entries, replay 1 passed 29.0s), and its
capture is committed with the pins that produced it. The uniform ten-leg pass that followed did NOT converge,
and the honest reading is two separate items, not one mystery:

- `plans` failed its distill (`exit=1` at `tests/e2e/plans-approved-plan…`), the leg that runs against the
  scripted stub — so the stub path needs its own look before any batch is trusted.
- `suite` missed against a tape distilled MINUTES earlier in the same pass: `MISS tape=suite entries=8
  messages=5 commonPrefix=2 divergeAt=msg2 got="{\"role\":\"assistant\",\"content\":null,…`. A `content: null`
  assistant turn (tool-calls-only) where the capture had content is live-model variation inside the recorded
  journey, the same class as `arrival`'s "never found the buried token" and `fanout`'s interleave. That means
  the chain is not green yet and **the corpus stays unstamped** — I am not committing a second mixed set, and I
  am not re-rolling `suite` until green either: if it needs more than one attempt, that is a flake finding to
  file with both logs, per the rule I wrote after `arrival`.

So the sequence is: fix the `plans` stub path, get one clean ten-leg pass where every leg distills green, then
the chain twice locally, then stamp and commit as one change. The runner-side blocker (7 registered tools) is
separate and unchanged.

### RETRACTION: `heavy` is NOT fixed by the 0.9 trigger — a fresh capture misses again (2026-10-27)

I wrote earlier this session that moving `heavy` to `threshold 0.9` fixed it, "pair-verified twice". The clean
ten-leg pass disproves that: `heavy: exit=0 tapeEntries=7` distilled green, and the strict chain immediately
after reports `MISS tape=heavy entries=7 messages=6 tied=[0003…0006]`. The two earlier passes were real but they
were two samples of a journey whose compaction boundary is not fixed by construction — exactly the same failure
shape I documented for `arrival` (model never found the buried token) and `fanout` (a 36-request interleave),
just with a boundary instead of a retrieval.

So the honest position:

- `threshold: '0.9'` stays (it aligns heavy with every other leg and the pins/drift rows argue for it), but it
  is NOT a determinism fix and I will not describe it as one.
- The committed corpus is unchanged: this pass's captures were discarded (`git checkout` + `git clean` on
  `tests/fixtures/model-tape`), because `fanout` also failed its capture (`exit=1`), so a commit now would
  record a mixed tree a second time.
- What heavy actually needs is a boundary fixed by construction: assert the compaction INDEX at distill time and
  require it at replay (or place the oversized reads strictly between boundaries). Either is a real design
  change with a red row. Guessing at a threshold and calling a green pair "fixed" is the failure mode this file
  keeps catching me doing.

### CI state after the mount-fault work (2026-10-27): deterministic green at zero margin, acceptance red by name

Run `40554042382` on `fix/token-plan-provider-row`:

    typecheck · build · unit + integration (coverage gate 85/85/85)   success   Branches 85% (5007/5890)
    does the pinned host support preset declaration rows?              success
    acceptance — ten tape-replay legs, no LLM                          failure   MOUNT FAULT

Two things worth holding onto:

1. **The gate is at exactly 85%, with zero margin.** It passed because nine host-fact rows that used to
   *abstain* on the runner now run (they looked only in `$HOME/node_modules`; they try `dev/dsh-host-lock`
   first), and one real contract row covers the pool-miss → local-store fallback. That is the honest kind of
   coverage gain, but a future contributor can flip the gate by adding a single uncovered branch. If it fails
   for someone: the fix is another real branch row, not a threshold edit.
2. **Acceptance fails for the named reason, not a mystery.** The runner composes a 7-tool session where this
   host composes 34 with identical installs, identical profile ids, identical `config`/`adapterDefaults`, so the
   corpus recorded here cannot key-match there. The rig refuses loudly (`MOUNT FAULT`) instead of writing tapes
   nobody else can replay. The two exits stay open and both are named on #56: fix headless preset mounting of
   `@deepseek-ai/dsh-tool-*` (host-side, outside this repo), or distill on the runner with the route credential
   as a repository secret (a maintainer action). #127 therefore stays unmerged: agents may merge to `staging`
   only after the acceptance job passes.

### Sandbox provisioning did NOT explain the tool gap — both hypotheses refuted in one run (2026-10-27)

I theorized the runner's 7 tools came from missing bubblewrap (bash/fs/pwsh mount through `dsh-bash-sandbox`,
`dsh-fs-sandbox`, `dsh-pwsh-sandbox`). The job installed `bubblewrap`, then lifted Ubuntu's AppArmor restriction
on unprivileged user namespaces, and the same artifact that proved the problem now disproves the theory:

    before: bwrap version=not-installed userNamespaceTest=failed: spawnSync bwrap ENOENT
    after:  bwrap version=bubblewrap 0.9.0 userNamespaceTest=ok
    both:   chars=2893  tools=7  names=chapters_artifact,chapters_continue,chapters_fork,…(ours only)

So bubblewrap is present and functional, and the session still registers only our plugin's tools. Provisioning
stays in the workflow — a runner that can't sandbox is a worse test bed regardless, and the probe is worth
keeping — but it is NOT the cause, and I am not going to describe it as one because it was my hypothesis.

That closes the environment class: installed bytes (integrity-verified), profile ids (two-phase mount report),
`config`/`adapterDefaults` (0 differing keys), aux header (identical), variable environment (`env -i` boot),
`$HOME`/ancestor `node_modules` (clean clone composes the long header), AppArmor/userns (now `ok`), and CI flags.
What remains is inside the host's own preset/tool assembly — which package registers `read`/`bash` and under
what condition — and that is a host-code question, not a rig or provisioning one. The next person to look at it
should start from `dsh-agent-preset` and the `agent-preset-registry` row, not from my environment again.

Meanwhile the facts that are settled and useful: CI's deterministic job is **green** (branch gate 85.0%,
1,257+ rows, 0 fail) and the corpus is committed as one change with the strict chain green twice locally. The
acceptance job stays red with a named cause, and #127 stays open because acceptance must pass before a merge.

### The tool gap, narrowed to the host's assembly, with the last two local explanations closed (2026-10-27)

After bubblewrap was provisioned and namespaces verified (`userNamespaceTest=ok`), the runner still composes
`tools=7 / chars=2893` against `tools=34 / chars=7396` here. Two more classes now have evidence against them:

- **Our preset pruned rows on CI.** `buildPresetRows()` returns `dropped[]` and `src/preset.ts:274` logs
  `preset "<id>" registered — dropped N row(s)`. That line is absent from CI's per-port server log — and also
  absent locally, because the local log holds the same two `[chapters-prompt]` lines and nothing more, so the
  absence proves nothing either way. The drop path is therefore **not evidenced**, only unfalsified; treat it as
  a hypothesis, not a finding.
- **Our plugin is not mounted on the runner.** Refuted: CI's server log carries our own runtime lines
  (`[chapters-prompt] turn/end sighted session=session-23f5877b…`, `prompt: not enabled (no defining model) —
  round skipped`), so our plugin is alive there and contributes exactly the seven `chapters_*` tools.

So the remaining question is squarely host-side: what makes a session assembled from the `chapters` preset
expose the standard tool surface on this machine and not on a GitHub runner, given identical packages,
identical profile rows (44 ids, the same 21 `tool-*` rows), identical `config`/`adapterDefaults`, working
sandboxing, and no logged pruning. Two ways forward, both cheap to the person who can run them:

1. run the acceptance chain on a machine with an interactive host install (the maintainer's laptop) and compare
   the header dump — this reproduces the 34-tool case and can be bisected with `preset`/`agentPresets`
   introspection the host already owns;
2. or make acceptance able to distill on the runner (route credential as a repository secret), which sidesteps
   the asymmetry entirely: the corpus is then recorded by whatever the runner assembles.

I am not adding a header blind to make CI green, and I am not claiming the cause. Everything else in the
objective's pipeline is measured and stated above.

### The pin-linking fix works for CI and invalidates the local corpus — stated plainly (2026-10-27)

`linkPinnedToolPackages()` (pre-spawn) was verified to do what it claims: a CI-shaped clone went from `tools=7 /
chars=2880` to `tools=34 / chars=7378`, which is the mount asymmetry closed. But the same change alters what a
DEVELOPMENT host resolves — 24 rows now come from the pinned bundle instead of the developer's home tree, and
those builds are not byte-identical in their prompt contributions. Consequences, measured today rather than
argued:

- The committed corpus (which was chain-green twice earlier today, pre-link) now fails locally: `suite` ✓
  `heavy` ✓, then `arrival` ✗ with `model never found the buried token via the artifact tool` — a retrieval that
  reached its assertion but not its result, i.e. the capture no longer describes what this composition does.
- A fresh ten-leg capture on the linked build was attempted: nine legs distill green, `fork` failed once with
  boot-readiness (`e2e boot failed within 120077ms`, retried → exit=0, 2 entries), and the resulting corpus
  failed at `suite` with the door never rendering — a capture in which the model simply did not take the
  continuation path, the same nondeterminism already filed for `arrival` and `fanout`.
- The tapes are therefore RESTORED to `HEAD` and nothing was committed from these runs. No stamp move, no mixed
  tree, no claim.

The decision this leaves, and it is a real one rather than a preference: either (a) accept a longer capture
campaign on the linked build — re-distilling per leg until each capture is faithful, filing any leg that needs
more than two attempts as the flake it is — or (b) make the rig's composition independent of which bundle copy
resolves by pinning the *prompt-relevant* surface (e.g. declaring the preset's plugin rows as repo devDependencies
at the pin, which is what I attempted and reverted when 15 existing `0.1.5-rc.x` devDeps made the peer graph
conflict). (a) is the honest path and (b) is the clean one; doing (b) properly means aligning the repo's harness
devDependencies to the single pin, which is a larger, riskier change that deserves its own issue and CI cycle
rather than being folded into this branch.

### Correction: replay already refuses to serve on a partial prefix (#56, 2026-10-27)

Last round I named "replay serves nearest-prefix entries" as the acceptance blocker and queued a fix for it.
Reading `findReplay` before writing that fix disproved it: it skips any entry whose `prefix.length !== inc.length`
and then requires every element to be equal, ties resolved by newest `recordedAt`. There is no nearest-prefix
serving to refuse — the hypothesis was wrong, and it was written into the plan as though it were established.

What CI's artifact actually shows for `suite`: a 4-message request whose `msg0`/`msg1` match the capture and whose
`msg2` carries `{"name":"glob","arguments":"{\"pattern\":\"src/**/*.ts\"}"}` where the capture has
`{"name":"read","arguments":"{\"file_path\":\"src/compose.ts\",\"limit\":120}"}`. Since serving is exact-match,
the only readings left are (a) the assistant turn the runner *recorded into its own history* came from a different
tie-resolved entry than this machine's run did, or (b) the two machines' requests differ at an earlier position
than the journal's "first miss" implies, because an earlier 503 was absorbed. (a) is checkable: the tie-break is
newest `recordedAt`, so two entries that both match a 2-message prefix can serve differently — and `suite`'s
capture has 6 entries where more than one shares a 2-message prefix.

Next read, in order, and no matcher change until one of them lands: (1) for the runner's first request, list the
tape entries whose prefix matches it exactly and show their `recordedAt` — if more than one, the tie-break is the
mechanism and the fix is a deterministic tie (path/length, then newest) with a row, not a stricter gate; (2) if
exactly one matched, then the divergence is upstream of msg2 and the diff dump needs to be taken at request one,
not at the first miss.

### `coverage:e2e` under one-boot-per-journey now fails in `prompt` on a sidebar wait (#56, #129, 2026-10-27)

With `test:e2e:replay` routed through `scripts/chain-replay.sh`, the coverage run gets nine legs green and then
`prompt` times out in the rig's own view-adoption step:

    Test timeout of 300000ms exceeded — locator.click waiting for
    locator('[role="treeitem"]').filter({ hasText: 'Reply with exactly: OK' }).first()      at session.ts:945

The earlier failure mode there was `identity mismatch: dir claims session session-2ba8…, spec targets 2ba8…`, and
that was a real bug — one session, two spellings (the durable log keeps the `session-` prefix, the view does
not) — now fixed by `sameSessionId()` with a red-first row. What remains is different: the session's tree row
never carries the question text while V8 coverage is instrumenting the boot.

Deliberately NOT done: raising the timeout until it passes. A click that waits for a label that never appears is
a signal about what the view is showing, and a longer wait converts a real finding into a green row — the exact
"green tests, dead product" failure this branch exists to refuse. The next read is the sidebar's actual contents
at that moment (dump `role=treeitem` texts plus `dsh.sessions.current` under `E2E_COVERAGE=1`), which will say
whether the row is unlabeled, labeled with a stale title, or absent because the title response served under
coverage belongs to a different session.

### The `prompt`/coverage stall is an actionability wait, with a suspicious aux-title volume behind it (#56, #129)

Read from the artifact rather than assumed:

- the row is **found and visible**; the 300s goes to `own.click()` at `tests/e2e/session.ts:945`, and Playwright's
  only line is `waiting for locator('[role="treeitem"]').filter({ hasText: 'Reply with exactly: OK' })` — the
  classic never-becomes-stable signature, i.e. the sidebar is re-rendering under the click.
- the leg's proxy journal holds **2,966** lines, of which **190** are single-message requests served in 1–2 ms
  each — the shape of an auxiliary title call repeating over and over. If the tree's labels are being rewritten
  continuously, that is what makes the row unactionable, and it would explain why the leg passes under plain
  per-journey replay (`prompt` ok in both `K1` and `K2`) and fails only while V8 coverage is instrumenting the
  boot, where timing and render cadence change.

Not yet claimed: the 190 figure is a correlation, not a diagnosis. The confirming measurement is small and
specific — count single-message requests per leg for one passing (no-coverage) `prompt` run and one coverage run,
and dump `session/title` events from the run's session log with their timestamps. If the passing run shows a
handful and the coverage run shows ~190, the title loop is the mechanism and the fix belongs to how the rig
stabilizes the view before clicking (or how the title call is deduplicated), not to the timeout. If both show
~190, the loop is normal and the real problem is elsewhere in the render path.

What is deliberately not done: raising the click's timeout until the leg passes. That would convert a render
instability that a real user could hit into a green row.

### Correction: there is no title loop — I counted a cumulative journal as if it were one run (#56, 2026-10-27)

The 190 single-message requests came from grepping `var/e2e-upstream.log` for `tape=prompt`, and that file
**accumulates across every run of every leg**. Measured properly, with the journal length captured before and
after one run:

- `prompt` replay, no coverage: **14** new journal lines, **5** single-message requests. Leg green.
- `prompt` replay, `E2E_COVERAGE=1`, same single-leg invocation: **14** new lines, **5** single-message. Leg green.

So the aux-call volume is identical with and without instrumentation, and the title-loop hypothesis is dead — it
was never a diagnosis, it was a correlation I read out of the wrong denominator, and the record said "not yet
claimed" for good reason. What survives is the failure itself: in the full ten-leg coverage run `prompt` timed out
on `own.click()` waiting for the sidebar row to become stable, while the same leg passes both plain per-journey
replay and single-leg replay under coverage. That points at load/timing when ten boots run back to back with V8
instrumentation writing coverage for each — not at the plugin's title path.

Useful rule for whoever picks this up: the journal is shared and cumulative; measure a delta, not a grep. The next
step is to reproduce the whole coverage run and dump the row's actual state at the timeout (its text and whether
it is re-rendering), rather than raising the timeout.

### What the armed diagnostic saw when `prompt` fails under full coverage: the view had **zero** rows (#56, #129)

Second full `coverage:e2e` run with the new failure diagnostic in place: `suite heavy arrival enrich fanout rules
fork plans` ok, **`prompt` FAILED**, `prompt-off` ok (`COVPJ4=1`). The diagnostic printed:

    e2e: tree-row click failed for "Reply with exact…" — locator.click: Test timeout of 300000ms exceeded.
      current session: null
      rows (0):

That is not a flaky click and not a re-render race: at that moment the sidebar offered **no session rows at all**
and `dsh.sessions.current` was unset, so the row the `isVisible()` check had just accepted was gone by the time the
click resolved. The failing test also moved — this time it was the third prompt test
(`clicking the expanded prompt puts the WHOLE prompt in the composer for editing`, 5.0m), not the first — and no
browser crash, `pageerror`, `Target closed`, or out-of-memory line appears in the leg log or the server log for that
boot. A three-leg instrumented run (`suite fork prompt`) passed everything, so the condition needs the long
sequence; what it looks like is the view losing its session list partway through a nine-boot run, not the bar's own
behavior.

Next read, deliberately narrow: extend the same diagnostic to print the page's URL, title, and body length plus
`JSON.stringify(window.dsh && Object.keys(window.dsh))` at the failure — if the app is still there but the list is
empty, that is a store/restore problem under instrumentation; if the document itself is gone, it is the boot dying
under memory pressure, and the fix belongs to how coverage is collected per boot rather than to the spec. Still
not doing: raising the click timeout.

### CORRECTION, mine: `noAuxModel` was never inert, and I wrote that three times today (#129, 2026-10-27)

Commit messages written earlier today (`fix: make noAuxModel real at the pressure decision…`) claim the key "is read
by NOTHING in `src/`" and that I made it real in `src/engine.ts`. Both false. `noAuxModel` is a **rig alias**,
translated at profile-write time into `auto: false` + `elicitedPlot: false` (`tests/e2e/rig-preset-pin.ts:79`), and
the engine declares `auto: z.boolean()` (`src/engine.ts:287`). My search was for the alias's name inside `src/`, and
a translation layer will never satisfy it. The no-op is reverted (`fix: remove the no-op "gate"…`), the wrong guard
test is deleted, and the six-leg pin set that actually works is restored — plane 1,108/1,108, typecheck 0.

What survives, measured independently of that bad theory and still the open work: the asymmetry is real in the
durable logs — `arrival` ran **one** compaction event on the CI runner and **zero** on this host against the same
corpus (`var/e2e-session-logs/`, run 40611340353), while `heavy` ran two on both. The six legs that pin the switch
pass on CI; the four that must not pin it (`heavy`, `suite`, `arrival`, `fanout`) are exactly where the misses land.
So the remaining fix is a **deterministic trigger** for the machinery those four legs exist to exercise — an explicit
event at a pinned turn or size rather than a threshold crossing on a header that differs slightly between machines.

### Correction to my own commit message: `threshold 0.5` does not make `suite` compact earlier — it declines

`test: give suite a threshold margin wide enough to fire on every machine` argued the checkpoint would now fire
"well before the divergence point on both machines". The engine's own sink says otherwise: at that ratio the leg's
requests are logged as `relief declined while the surface is over the trigger (surface=22119 trigger=16000
window=32000 …)` — repeatedly — and the new capture contains **no** checkpoint notice at all. So the capture became
checkpoint-free because relief is being *refused*, not because it moved earlier. Two consequences, neither of which I
get to skip: (1) the claim in that commit message is wrong and is corrected here; (2) if `suite`'s journey no longer
exercises compaction, whatever the leg was written to prove about pressure relief is not being proved by it any more —
which needs its own answer, not a re-wording.

Measured facts that do hold: `suite` at `0.5` unpinned captures (5 entries) and replays green twice on this host; the
same leg pinned does not boot at all (two attempts, one log line, no URL) — see #129. Tree restored to the working
regime; plane 1,108/1,108.

### Plot elicitation is load-bearing for multi-turn convergence — suppressing it makes small-model journeys loop (#130, two samples)

I applied the `elicitedPlot: false` lever (the one that fixed `suite` on CI) to the other two aux-sensitive legs and
watched both fail the same way **at record**:

- `arrival` sample 1: exit=1, 13 entries, `model never found the buried token via the artifact tool`.
- `arrival` sample 2: capture never finished — 42 → 63 → 68 → **72** requests in 20 minutes, the model re-reading and
  re-searching instead of converging, killed at the 1500 s ceiling.
- `fanout`: exit=1 after **61** entries, the same shape.

So the aux plot turn is not cosmetic overhead for these journeys — it is the mechanism that carries the operative
note forward and lets a small model keep its thread across many turns. Remove it and they thrash. `suite` is the
exception because its journey is short and its assertion (fork door) does not need the loop to close.

Consequence for acceptance, stated as a constraint rather than a to-do: for `heavy`, `arrival` and `fanout` the fix
cannot be "suppress the aux turn so both machines match", because the turn is what makes those legs work. Either the
corpus must **record** the plot turn on every machine (which means understanding why the runner elicits it and this
host does not, at the same threshold and the same 32K window), or those legs' prompts must be reshaped to converge
without it — and reshaping a leg's prompt changes what it exercises, so that has to be a deliberate decision with its
own docs, not a quiet edit. Both `heavy` and `fanout` currently diverge at `commonPrefix=2` (the first assistant
turn) with relief live, which is the checkpoint-shape family, and `arrival` diverges as a 1-message plot request.

Reverted: both legs back to the committed regime, two samples each, no pin shipped around a loop.

### `arrival` is capture-nondeterministic across regimes — the leg tests retrieval luck, not the mechanism (#130)

Three regimes, same runaway, which is what rules out my two theories in one measurement:

| regime | outcome |
|---|---|
| threshold 0.9, plot elicitation ON (committed) | captured fine repeatedly today: 9, 14, 19 entries |
| threshold 0.9, `elicitedPlot: false` | exit=1 at 13 entries once; then **never finished** — 42→63→68→72 requests in 20 min |
| threshold **0.98**, plot ON | **42 requests at +600 s**, the same runaway; killed at the ceiling |

If the trigger margin and the aux turn were the causes, 0.98-with-plot-on would behave like the committed regime. It
did not. What is actually varying is whether the small model happens to find the buried token: the leg reads a 373,861-
byte `var/e2e-book.md` (3,964 lines) and asks it to locate `EMBED-CENTER-4417` near chapter 21 through the artifact
reference, so success depends on retrieval luck rather than on the mechanism the leg names — *one oversized read
deferring to an artifact at arrival, never prefilled*. When luck fails, the model re-reads and re-searches and the
capture spirals to 40–70 requests; when it holds, the same leg finishes in 9.

The fix is a test-design decision, not a rig knob, and it has to be explicit because it touches what the leg proves:
keep the mechanism (the read must still exceed `toolResultArtifactTokens` so arrival defers it) and make the RETRIEVAL
tractable — place the buried token within the first few chapters of a smaller book, so the artifact query answers a
bounded question instead of a needle-in-haystack one. Then guard the part that must NOT change with a row: the book
still exceeds the deferral threshold on both machines, so the stub pair still happens. Shrinking the haystack is not
weakening the assertion; asking a 32K model to grep 4,000 lines through a stub was.

Not done, deliberately: another re-roll of the same capture (I have three samples now), a raised timeout, or a pinned
`noAuxModel` on this leg. All of them hide the design problem.

### Dropping the injection row shrinks the surface — which is exactly what two legs were secretly relying on (#129)

Campaign on the no-injection build: `arrival` 10, `enrich` 3, `fanout` 14, `rules` 2, `fork` 2, `plans` 3 all captured
green, while `suite` (4 entries) and `heavy` (15 entries) failed. `heavy`'s failure names the mechanism:

    > 131 | }, { timeout: 480_000, intervals: [5000] }, 'engine chapters recorded for THIS session').toBe(true)

The injected `AGENTS.md` block is thousands of tokens of surface. Remove it and both legs stop reaching their pressure
trigger inside the journey — `heavy` never records engine chapters, and `suite`'s fork door (which comes from a real
continuation) never renders. So the row removal is not "free determinism": it is correct in principle (a
machine-varying development artifact must not arbitrate a tape) and it exposes that these two legs were reaching
their threshold **with borrowed bytes**, which is the same defect as depending on a runner's header size, one layer
down.

The honest consequence, in order: `heavy` and `suite` must generate their own pressure — the leg's prompt or fixture
carries the bulk, not an injected document — and the engine must actually PERFORM relief at the ratio the rig pins
(the `relief declined while the surface is over the trigger` line in #130 means a low ratio does not guarantee relief
happens, it may just refuse). Until both are true, the no-injection profile stays and these two legs are re-designed,
not re-rolled. Nothing is committed from a partial campaign.

### What the Autorun-displaces-goal pixel actually requires, from the code as it stands (#113, objective item 3)

Read at 2026-10-28 while looking for the assertion, so the next reader starts from facts:

- `src/client/prompt-dock.ts:380` renders the toggle as `label: state.autorun === 'armed' ? 'Autorun off' : 'Autorun'`
  with glyphs `⟳`/`⟲`, and disables it with a title when the host publishes no idle signal — **that** affordance is
  what `prompt` asserts today (arm-ability, `4 passed`).
- Displacement is a **server fact**, not a dock rendering: `PromptStore.setAutorun(sessionId, on)` returns
  `{ autorun, fired, displaced }` (`src/prompt-state.ts:160-162`, "true when arming this loop also disarmed the
  goal"), and `tests/unit/prompt-goal-interplay.test.ts` covers it. The dock has no element that says "the goal's
  next turn was taken" — so a leg cannot assert displacement by looking at the bar alone.
- What a browser leg CAN assert, in order of directness: (1) the host's own goal control showing `activation:
  disarmed` after the bar's Autorun is clicked while a goal is active; (2) the next turn being driven by the bar's
  suggestion rather than the goal's objective, observable in the session's durable log; (3) `Run` carrying
  `intent: 'goal-edit'` (the dock titles it "Goal edits need a human turn…", `prompt-dock.ts:375-377`) to prove the
  split the design claims.
- Prerequisite that is NOT free: making a goal active inside a rig session. The profile mounts
  `@deepseek-ai/dsh-command-goal`, so `/goal …` in the composer is the route, but goal activation requires a
  **direct human turn** in the host (`prompt-dock.ts:376` says so about edits, and `goal-edit` intent exists for it)
  — so the leg's choreography is: send `/goal`, wait for the host to report active+armed, click the bar's Autorun,
  then assert on the goal control and the durable log. Expect this to need a recorded journey of its own, and to be
  captured alone under `E2E_PROVIDER=harness`.

### Two measured facts about the displacement leg, from the capture that did not finish (#113, objective item 3)

Written instead of shipped, because the leg is red and a red leg on the branch helps nobody. Both facts came from a
live recording run (`E2E_PROVIDER=harness`, `prompt` leg, 44 tape entries) with the test I added and then reverted:

1. **The goal bar's activation control is real and findable.** After a human turn of `/goal Ship the widget and verify
   it in the browser`, the host renders `[data-goal-bar]` AND a page-level control labelled `Pause goal` — the
   assertion `the goal is armed: its own control offers Pause` **passed**. The label must be located page-wide
   (`button[aria-label="Pause goal"], button:has-text("Pause goal")`), not inside the element that carries the
   attribute: the host routes the action through its own `Action` component (`client.js` has `"action.pause":
   "Pause goal"` feeding `label: t("action.pause")`), and scoping to `[data-goal-bar]` found nothing — that mistake
   cost one capture.
2. **The blocker is our own bar, and it is a product question.** The next assertion failed: after clicking Autorun,
   `button:has-text("Autorun off")` never appeared. The dock dispatches `{ t: 'autorun', on: !armed }` locally and then
   `refresh()` (`prompt-dock.ts:390`), so if the server's read comes back `disarmed`, the label snaps straight back to
   `Autorun` and the user sees their own click refused. That is exactly the `state.autorun` split the interface lock
   describes (`server, process-local` like the goal's `activation`, `docs/contract.md:680`) — so either arming needs a
   turn boundary before it reports armed (and the leg must wait for one), or the write is not landing. I do not know
   which, and the capture that would tell me is the next experiment, not this note.

Consequence for the objective: item (3)'s displacement pixel and item (4)'s browser-level interplay remain unshown,
and the reason is now narrow and specific — our bar's armed state does not visibly persist — rather than "the host has
no affordance", which the first fact disproves.

### `auto: false` is too coarse: it turns off arrival deferral along with relief, which is why two legs cannot be pinned (#129, #130)

Re-tested today, **after** #131 was fixed, in case the artifact cycle had been the whole story. It was not: with the
pin applied, `arrival` again fails `at least one arrival stub pair (one oversized read)` and `fanout` again fails
`parent synthesis lost paper A — SYNTHESIS, not delivery`. Identical messages, different build. The reason is in the
module's own header — `src/arrival.ts:7`: the arrival stub pipeline **"Runs at the head of compactIfNeeded/compactNow"**
— so the realm key that suppresses model-involving relief (`auto: false`) also suppresses the size-deterministic
deferral that these legs exist to exercise. `noAuxModel` is therefore one switch for two behaviors.

Why this matters for the CI divergence rather than just for the rig: `fanout`'s machine dependence is now explained
exactly — the child's first message is a checkpoint notice here and the plain delegated prompt on the runner, i.e. the
**parent** relieved at a different moment — and the only two ways to make that agree are (1) split the keys so relief
can be off while deferral stays on (real work: a second realm key and a call-site change in the engine), or (2) let the
legs reach relief at a leg-controlled point instead of a threshold crossing (bulk the leg generates itself, per the
maintainer's "synthetic bulk" rule). Both are design changes with their own risk; neither is a knob I can set tonight,
and the third option — pinning anyway — deletes the behavior the legs test, which measurement has now shown twice.

Reverted: pins and the allowlist row back to the committed set, corpus restored. The rows held the line — both failed
the moment I claimed a regime the capture refutes — and that is the reason the re-test is short rather than hopeful.

### The key-split question, bounded to one fact: which `applyArrivalStubs` site goes silent under `auto: false` (#129, #130)

Checked rather than assumed, because this branch has been fooled by that twice today. `auto` is **not** another dead
key: the host's `BasicCompactionConfig` reads it — `dsh-compaction-basic/lib/index.js` validates it as a boolean and
defaults it to `true` — so `auto: false` really does suppress the host's relief, and the docs' "one realm key, two
behaviors" claim stands.

What is NOT settled is the one fact a split needs: `src/engine.ts` calls `applyArrivalStubs` at two sites — ~862, in
the event-driven arrival listener (`floorTokens: toolResultArtifactTokens`), and ~944, inside the pressure path
(`floorTokens: ceiling`). Under the pin, `arrival` loses its stub pair. Which site went silent, and why? The answer
decides where a second key must live. Getting it requires one pinned capture plus a grep of that run's session log for
arrival markers — a measurement, not another theory.

Stated so the next session inherits a limit, not a license: **do not implement the split before that is known.** A
switch wired to the wrong site is the #130 mistake wearing a new costume — a key the rig writes and nothing consumes —
and there is already a guard-shaped lesson about that in this file.

### Second correction on the same claim: the `arrival` stub-pair failure is NOT caused by the pin (#129)

Two commits ago I wrote that `auto: false` suppresses arrival deferral, "verified" by a pinned capture that failed
`at least one arrival stub pair (one oversized read)`. Checking the same day's other logs before leaving that in the
record, it is wrong in its attribution: the identical failure appears with **no pin at all** —

| run | pin state | outcome |
|---|---|---|
| `camp2` (unpinned) | — | `arrival: exit=0`, 9 entries |
| `camp3` (unpinned) | — | **`arrival: exit=1`, 3 entries** |
| `camp5` (unpinned) | — | `arrival: exit=0`, 14 entries |
| probe just now | `auto: false, elicitedPlot: false` | `arrival: exit=1`, 4 entries, 0 stub markers |

Three unpinned captures of `arrival` failed at record earlier today (one of them while diagnosing #131), so the pin
is not the differentiator and "one realm key, two behaviors" is **not** established by this evidence. What is
established, and survives: the host really does read `auto` (`BasicCompactionConfig` validates it, default `true`),
and `#arrive` is called only from inside the relief path (`src/engine.ts:1024` and `:1083`), matching that module's
own header — so a relief-side switch *can* reach deferral, which is why the split key is still an open design
question. It is not established that flipping it caused these failures.

The ordinary explanation is the one I keep reaching for last: the leg's oversized read depends on what the model asks
for. It fails intermittently, pinned or not, which is exactly the flake class #131's fix reduced but did not remove.
The pinned run adds no information, and I should have looked at the unpinned logs before writing a mechanism.

Method, again, in writing: **before attributing a failure to a change, find the failure in a run that predates the
change.** I have now made this error three times today (the fake `noAuxModel` gate, the coarse-key claim, and this
attribution); the guard against it is cheap and is called a log search.

### Retracted: the margin change did not make `fanout` deterministic — the same build captured 10 entries and, 40 minutes later, 20 (#132)

One-run against one-run, which is the only comparison that means anything (I made the cumulative-sink mistake twice
today and the second time it nearly became a conclusion):

| measurement | this host (one capture) | runner (one capture, run 40648703376) |
|---|---|---|
| `realm:engine:arrive` entries | 24 | 3 |
| `relief declined` | 11 | 1 |
| `decided: compaction` | 6 | 0 |
| tape entries produced | **20** | 10 (committed) |
| capture outcome | exit=0 | (CI replays, never records) |

Two things follow, and both cut against what I claimed an hour ago. **(a)** `fanout`'s *capture* is not stable on this
host: the committed corpus is a 10-entry roll and a fresh roll under the identical regime produced 20. So the "41 → 10
entries is an efficiency win" line was a short roll, not determinism, and I am withdrawing it. **(b)** the runner's
journey is much *shorter* than mine — 3 arrival entries and zero completed reliefs, where one local run does 24 and
six. That is not "the crossing landed one turn later"; it is a different number of model turns in the same leg, which
is what a prefix miss at `messages=14` looks like from the inside.

Therefore the remaining acceptance work is not a rig knob at all. It is the thing the maintainer's rule already says:
these legs must not depend on how many turns a model feels like taking. A leg whose journey length varies will not
replay anywhere, and no margin, threshold, or fold fixes that — the journeys have to be shortened and bounded so the
turn count is a property of the spec, not of the roll. Restoring the corpus to the committed set (my 20-entry roll is
discarded, not "re-anchored" on a coin flip).

### Next-session brief: make the turn count a property of the spec, then re-anchor (#132, #129)

State of the branch when this session ends, all of it measured rather than asserted:

- **Green and committed:** plane 1,114/1,114 with 0 skipped; `typecheck` and `typecheck:client` 0; `typecheck:e2e`
  at its 68 baseline; full one-boot-per-journey chain ten-for-ten (`MG=0`); `coverage:e2e` `CVM=0` at **78.2%**
  on the current corpus; corpus stamped and `corpus:check` agreeing. Products of this session, all with red-first
  rows: **#131** artifact answers no longer arrival-stubbed (two legs' "flakiness" was this), **#113** the Autorun
  control actually arms (it was inert) and **goal displacement is observed in Chromium** (`Pause goal` →
  `Resume goal`, replayed model-free at 5 passed twice), `scripts/chain-replay.sh` (one boot per journey, now what
  `npm run test:e2e:replay` means), `linkPinnedToolPackages()` before spawn (runner assembles 34 tools, was 7),
  per-leg logs + session transcripts + per-port diagnostics in the CI artifact, and the `arrival` prompt fixed to
  ask for the `limit` the host actually accepts (which took that leg off CI's list at least once).
- **Red, and honestly so:** CI acceptance on `heavy arrival fanout`. `arrival` has flipped green→red between
  identical-code runs; `fanout`'s capture is 10 or 20 entries on **this** host minutes apart. So the tapes are not
  portable because journeys are open-ended, and the diagnosis is settled: relief timing was a symptom, **model
  turn count is the cause**.
- **The work, concretely:** bound each affected leg so the number of model turns is fixed by the spec, then
  re-anchor. For `fanout` that means two subagents, one delegated read each, and the parent asked for the
  **shortest faithful synthesis** — assert the stub pair, both markers reaching the parent's answer, and nothing
  about how many queries it took; if a roll can still vary in turn count, the leg should drive the pieces it can
  drive (deterministic fixtures, generated bulk) and stop relying on the model to stop early. `heavy` and
  `arrival` get the same treatment: one bounded read, one bounded artifact query, assertions on the durable log's
  facts rather than on the model's economy.
- **Do not**: pin `noAuxModel` on those legs (it deletes deferral, measured three times); fold injected or
  checkpoint content out of matching (it collapses positional prefixes and mis-serves turns — tried, reverted);
  re-anchor a leg off a single green roll (that is how two fake fixes happened); raise a timeout to pass a leg
  whose subject is timing.

### `heavy` is the last acceptance miss; the runtime-fold theory is already dead, tested against the runner's bytes (#132)

Where this stands, measured rather than narrated. Run 40661878031 fails `heavy` and `prompt`; `prompt` now survives
**nine messages** (`commonPrefix=9 divergeAt=msg9`) where it used to die at 2-4, so the bounded journeys plus the
injection-row removal moved the whole problem deeper into the conversation — which is what those changes were for.
`heavy` still misses at `commonPrefix=2 divergeAt=msg2`.

The obvious-looking explanation was that the runner keeps a residue of the runtime-context / `<system-reminder>`
injections that this host folds to nothing, shifting every index. I took the runner's own transcript (uploaded now by
`scripts/chain-replay.sh`) and normalized those two events through the real fold:

    seq 11 raw chars 484  -> normalized chars 0
    seq 12 raw chars 3285 -> normalized chars 0

Both fold to empty, i.e. both are pure injections and drop from matching on either machine. **Theory dead, in one
command, before it became a change.**

What the runner's transcript does show: `[system, user(prompt), user(runtime), user(reminder), …]` and, at the point
where the tape has an assistant turn reporting `First call returned (output capped at line 600; found
MARKER-ALPHA-7731…)`, the runner's `msg2` is the assistant answering the follow-up probe (`STILL-HERE`). So the two
histories differ in **which assistant turn comes second**, not in message roles or counts. The next read is
therefore structural, not fold-related: line up the runner's event order against the tape's entry order for
`heavy` and find the point where the journeys diverge in *sequence* — the probe turn is the suspect, since its
position depends on when the first turn ends. If the sequence differs only around the probe, the leg's probe
needs to be gated on a durable-log fact rather than on a poll, which is a spec change with its own row.

### My own error, caught by the runner: the prefix-symmetry fix DOES require a re-record (#132)

The commit said "this changes matching only — served bytes untouched — so no re-record is needed: CI either agrees
or it names what's left." CI named what's left: **my own claim**. `normalizeStoredPrefix()` both substitutes *and*
drops empty elements, and dropping changes a prefix's **length**. A tape recorded before it has different effective
key shapes than a live request matched against it — so the corpus and the matcher must be re-anchored together, not
one without the other. The substitution half was length-preserving; the filter half is not, and I reasoned from one
to the other.

Runner evidence, `000.json` in run 40664455803: the live history is `[system, checkpoint-notice,
assistant("STILL-HERE"), user("Reply with exactly the single word: STILL-HERE."), …]` — the follow-up probe arriving
at index 3 where the tape has it later. Under the new filter, the runner's first main request normalizes shorter than
the recorded entry expected, so a legitimate turn is served where the journey hadn't reached it. Not model
behavior, not a fold residue: a matcher change shipped without the re-anchor it implied.

Action: re-anchor the corpus on the symmetric matcher and re-verify. Rule extracted, added to the rig list: **any
change that alters prefix LENGTH is a corpus change, not a matcher change** — length-preserving folds may ship alone,
length-changing ones never do.

### #135 — the goal-off browser leg needs a rig capability, not a weaker assertion

Four capture attempts, four different failure classes; the full account is in `docs/project-state.md` (2026-10-28,
later) and on the issue. What the chase established, measured:

- A goal round **is a turn**, and every turn ends, so rounds cascade — no click timing or polling bounds them (one
  tape reached `Round: 12/256`).
- The product's own bound (`maxGoalRounds`, quiescent at `Round: 1/1`) is the right shape, but the only way a leg can
  set it today is by asking the model to call `create_goal(max_goal_rounds: 1)` — and in capture the model answered in
  prose instead of calling the tool. Setup that needs model cooperation cannot be a tape.
- No HTTP seam exists: grepping every installed `@deepseek-ai/*` lib for a route containing `goal` returns nothing. The
  human `/goal` command takes no rounds argument, and `goal-round-driver` has no config block in `cordis.patch.yml`.

Both candidates were then investigated, and (1) is **not available**: the host's goal state travels in the durable
event stream (`goal/change`, `goal/changed` in `@deepseek-ai/dsh-goal`), so pre-seeding it would mean fabricating a host
event — forbidden by invariant 1. The `goal` row that DOES sit in a boot home's storage
(`storages/session_projcache/sessions/<id>.json`, keys `{seq, val:{current, seenGoalIds, failure}, ver}`) is our own
mirror, with no round budget. There is no plugin-facing goal API (`ctx.get('…goal…')`, `registerCapability`, `provides:`
all empty), no HTTP route mentioning `goal` in any installed lib, no config block on `goal-round-driver`, and no rounds
argument on `/goal`. So today the only way to set a bounded budget is the model calling `create_goal(max_goal_rounds: 1)`
— which capture attempt 4 proved a tape cannot depend on.

Decision: the claim stays **unit-covered**, §28 keeps not claiming the pixel, and the leg stays **unwritten, not
skipped** (the distinction matters). To ever show it in a browser the change belongs upstream — a rounds argument on
`/goal`, or a plugin seam to open a bounded goal. Filed as such on #135 with the greps that establish it.

### #135 follow-up — a rig-reachable round budget does not exist, and staging's displacement leg is timing-fragile

The obvious knob is real: `@deepseek-ai/dsh-goal` ships `config = z.object({ defaultMaxGoalRounds: z.number().default(256) })`,
and `resolveCreateGoal(request, defaultMaxGoalRounds)` uses `request.maxGoalRounds ?? defaultMaxGoalRounds`. But
overriding it from a boot's profile patch **disables the feature the leg needs**: inserting

    - id: goal
      name: '@deepseek-ai/dsh-goal'
      config:
        defaultMaxGoalRounds: 1

makes `/goal` stop creating a goal, and the leg fails at `the host goal bar appears once a goal exists`. Attribution was
by experiment, not by reading: staging's own spec with staging's own 23-entry tape, **pin active → 1 failed / 4
passed**; **pin removed → 5 passed**. Nothing was committed; the transform, its wiring and both rows that pinned it are
gone, and the tree is staging-equal with `corpus:check` agreeing.

Two collateral facts worth keeping, because they are how I got here:

- The first pinned capture reached **326 tape entries in ten minutes**, which is what made me stop and inspect a real
  boot patch instead of trusting a green unit row. My rows had fed the transform a synthetic patch that *contained* a
  `goal` row; a real boot's patch contains none (measured: `preset-chapters`, `agent-preset-registry`, `llm-pi-ai`,
  `agent-default-model`, `llm-gate`, `fetch-timeouts`). Stub-of-the-fictional-shape again, this time mine.
- **The merged `prompt` leg is portable by luck.** A docs-only PR (#137, zero non-docs delta) turned acceptance red with
  `MISS tape=prompt entries=23 … storedCandidates: []` while the runner's history held `<goal_round> … Round: 1/256`
  through `Round: 4/256` in a window my capture recorded with none. Run 40676609079 was green because the runner's
  latency happened to reproduce my machine's round count. The displacement *behavior* is real and was observed; the
  leg that carries it cannot currently be replayed dependably.

What that leaves: making the goal legs portable needs a **host** capability — a rounds argument on `/goal`, or a
plugin-facing seam to open a bounded goal — which is #138. Not a weaker assertion, and not a deleted test: the leg
stays as merged, with its fragility named instead of hidden.
