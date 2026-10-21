# Open items — 2026-10-11

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
2a. **On 0.2.x, creating a child session is REFUSED — the acceptance chain stops here.**
   Captured verbatim from the UI of a live 0.2.0-rc.2 boot, after one clean assistant turn,
   clicking the fork door: `chapters-fork refused: child creation refused: format v4 message
   requires a producer-owned source kind`. The child directory is created (a 0-byte
   `session.lock`) and NOTHING is written into it: no durable log, no projection-cache entry,
   no sidebar row even after a full reload. Every journey that asserts on a child's seeded
   notice — `rules`, `fork`, `plans`, the knowledge-loop's carry check — is therefore blocked
   by this, and none of them is telling you anything about rules or plans.
   **What this is NOT** (each was my working hypothesis and each is dead on evidence):
   - NOT a client-plane door problem. Both door rows mount and are visible (`28x28`,
     `inDocument: true`, inside the host's own `EvIC1a_flowItem > TS9iAW_actions`); the earlier
     "door not visible" failure was the *consequence* of a turn that never completed
     (see the fork prompt fix), and the probe reached the refusal only after clicking successfully.
   - NOT our notice's shape. `buildTocNotice` emits
     `source.kind: 'plugin:dsh-chapters'`, and the installed kernel's own
     `assertV4RowAdmission` ADMITS it — `tests/unit/host-seed-contract.test.ts` runs 6/6, 0 skips,
     including "the v4 kernel REFUSES the retired plugin wrapper we no longer emit".
   - NOT a version skew: the repo's `@deepseek-ai/dsh-session-format-v3-to-v4` is `0.2.0-rc.2`,
     the same line as the pinned host.
   So the refusing row is one the HOST adds to the child's first rows (its own setup/injected
   messages) and the plugin's create call inherits the blame. Next step: reproduce it outside
   the browser by creating a session through the host API with our seed and nothing else — if
   it still refuses, the seed is not the problem and the host is; if it admits, the difference is
   one of the rows the host appends, and the fix is to file it upstream with the reproduction.
   The plugin's diagnostic sink (`DSH_CHAPTERS_ENGINE_ERRORS`) captured NOTHING for this path,
   which is itself a gap worth closing: a refusal this consequential should leave a trace the
   next agent can read without a browser.
2. **The browser plane is blocked, not skipped.** `npm run test:e2e:replay` refuses by name because
   the pinned host predates preset declaration rows (`tests/e2e/boot.ts:130`). When
   `dev/dsh-host-lock` moves to 0.2.x, the tapes need **one** whole-project re-distill — this round
   added a tool (`chapters_rules`), which changes the header of every recorded session. Extending
   `rules.spec.ts` with the checkpoint-carriage and continue-vs-fork assertions is part of that job;
   writing spec assertions that cannot execute would be a false witness.
3. **R10 is only partly proven.** Marker rules re-derive off the durable log and dedupe against
   disk, but there is no end-to-end wipe-and-replay row yet.

Two local truths to save the next agent an hour: the suites need **Node ≥ 24** (on 22 every file
fails for a reason that looks like your diff), and `coverage:ci` intermittently reddens
`git-auth-classification`/`sync-remote` on this box under parallel load — **verified pre-existing** by
running it in a worktree at the last docs-only commit. Re-run before blaming the change.
