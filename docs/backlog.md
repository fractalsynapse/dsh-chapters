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
