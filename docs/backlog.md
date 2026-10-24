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
