# Plans in the Archive — design record

Written 2026-10-09. **Read before writing code.** Human decisions for this feature are recorded at
§ Decisions Taken and are binding; anything marked *deferred* is a human call, not ours.

DSh ships plan mode (`@deepseek-ai/dsh-plan-mode`) and our own preset mounts it
(the `plan-mode` row of the registered preset: `PLAN_MODE_SECTION` in `src/preset.ts`; before the 0.2.0 floor it lived in `presets/chapters/agent.cordis.yml`). Today a session plan survives an archive only as the
first 400 characters of a tool-call line. That is the worst possible outcome for the one artifact in a
conversation that is *deliberately* decision-complete — and the reason the plugin exists at all: a
continuation that cannot see the approved plan either re-plans from recall (lossy) or implements
something nobody approved (worse).

## Facts to re-verify on any DSH upgrade

| Fact | Where | Consequence for us |
|---|---|---|
| The plan is a **tool-call argument**, field `plan`, type string, required | `dsh-plan-mode/lib/index.js:230-236` | Detection is one predicate: `tool/call && name === 'exit_plan_mode'`. There is no plan document event. |
| The host validates `/^#\s+\S/` on the plan text | `index.js:256` | We can rely on a leading `#` H1 for the title. |
| Approval result is the canonical `{ approved: true }` + fixed render text | `index.js:237-251` | Verdict is derivable from the paired result, not from prose. |
| Rejection = failed call carrying review feedback; dismissal = failed call naming the takeover | `index.js` execute arm + package README § Model Experience | Three distinct non-approval shapes to classify, plus a fourth we must not invent. |
| State is one log-only whole-value event `plan/mode { active }`, appended at the next **accepted in-turn pre-step** | `index.js:374, 389` | An approved exit may not have its mode event yet at archive time → the *result* is the primary signal, the mode event secondary. |
| Mode state is recovered by **folding the log** (projection `apply`, `stateVersion: 3`) | `index.js:83-94` | Last logged value wins; we mirror that rule, we do not cache a verdict. |
| The mode-switch notice rides with `form: 'notice'` — v3 `source { kind: 'plugin', plugin: 'plan-mode' }`, v4 `{ kind: 'plan-mode' }` (measured dsh-plan-mode/lib/index.js:395-410 on 0.2.0-rc.2; issue #43) | `index.js:392-410` | The screen treats injected context as NOT conversation **except** this one sentence, which is archived verbatim (the named exception, `src/injections.ts:55-68`; both arms narrow by producer AND form). Amended 2026-10-10 — this row originally said "omits". |
| `/plan <message>` steers a real user message, `source.kind 'user'`; bare `/plan`, `/plan off` and their terminal results stay outside model history | `index.js:220` + README § Human Command | The instruction a human typed under plan guidance **is** conversation and is archived verbatim today. Nothing to change. |
| Freshly created agents begin plan mode **inactive**; `plan/mode` is per-session and not inheritable | README § Known Limitations | A `chapters_continue` / `chapters_fork` child cannot know it was mid-plan unless we carry that text. |
| `tool/call` data shape is `data.{callId, name, arguments}`, `arguments` an object **or** a JSON string | `src/types.ts:8`, precedent `src/render.ts:253` | The extractor must accept both, exactly as the renderer already does. |

## What the pipeline loses today

| Loss | Line | Fix below |
|---|---|---|
| Full plan bytes never reach the store (400-char head only) | `src/render.ts:250-257` | § 2 + § 3 |
| Artifacts are written for `tool/result` payloads only | `src/render.ts:258-277`, `:126-156` | § 3 |
| `plan/mode` events fall to `default:` → `unrenderedSeqs` (a disclosed hole, no prose) | `src/render.ts:284-285` | § 2 |
| Nothing in the TOC names a plan or its verdict | `src/continue-core.ts:111-141` | § 4 |
| `chapters_search` resolves chapters + rules; artifacts travel (`src/sync.ts:160-215`) but are not index entries | `src/search.ts:76, 104-105` | § 8 |
| A plan in an **open** turn is above the archive ceiling (completed turns only, `src/tools.ts:186-189`) and is never archived | `src/tools.ts:194-198` | § 5 `livePlans` |

## Decisions taken (human, 2026-10-09)

1. **Home for plan bytes: artifact pointer + chapter block.** The verbatim plan goes to the
   content-addressed artifact store; the chapter carries status, outline, a bounded head, and the path.
   *Not* a first-class `kind: plan` corpus document — that stays deferred (§ Deferred), because it
   widens the corpus and needs a `docs/knowledge-repo.md` amendment.
2. **Mode carriage: notice-only.** The child is *told* about the active plan. We do not seed a synthetic
   `plan/mode` event into the seed: the seed contract is pinned as one event at `seq 0`
   (AGENTS.md invariant 2, `spikes/probe/FINDINGS.md`), and flipping the child's mode also changes the
   composed `plan:policy` header section. Both belong to a measured spike, not to this feature.
3. **Record before code.** This file is the reviewable artifact; implementation starts after it lands.

## Design

### 1. `src/plans.ts` — pure detector (no cordis, no fs, L0-testable)

```ts
export type PlanStatus = 'approved' | 'rejected' | 'dismissed' | 'pending' | 'superseded' | 'failed'
export interface PlanDoc {
  seq: number; resultSeq: number | null; callId: string
  title: string; status: PlanStatus; text: string
  sha256: string; bytes: number; estTokens: number
  outline: string[]           // H2/H3 headings, in order, verbatim
  artifactPath: string        // artifacts/<aa>/<sha>.txt
  archived: boolean           // false when seq > archiveCeiling
}
export function detectPlans(events, ceiling, opts): { plans: PlanDoc[]; modeActiveAt: (seq: number) => boolean }
```

*Status-vocabulary amendment (2026-10-09, at implementation).* A fifth class appeared in the host's own
`execute` arm and is not a human verdict at all: the review could never open (no user-questions channel;
the plan-mode service reloaded mid-review; the call ran outside plan mode; the markdown had no `#`
heading). Labelling those `rejected` would credit the user with a decision they never made, so the union
carries `failed` and prints the host's own text as the verdict line. The four shapes the record named are
all still there.

Rules, each pinned by a unit row:

- **Pair by callId** using the existing `sameCall` logic (`src/render.ts:158-164`) — extract it, do not
  duplicate it.
- **Verdict precedence**: paired `tool/result` first (`{approved:true}` → approved; `isError` +
  "Keep planning" feedback → rejected; failed call naming takeover → dismissed); **no result event →
  `pending`**, which must never be rendered as approval. The `plan/mode` fold is secondary evidence and
  only breaks a tie.
- **`superseded`**: same H1 title, different sha256, later seq ⇒ newest is operative, earlier ones are
  `superseded`. Deterministic; no model judgement.
- **Screen the body**: run `stripReminderSpans` over the plan text. A plan is model-authored bytes, but
  an injected span riding inside it is host state (same reasoning as `src/injections.ts:62-70`).
- **Redaction rides for free**: build the doc through `artifactRef`, so the `render → redact → write`
  chokepoint applies (`src/render.ts:179-182`). Never write an unredacted plan blob.
- Title = the first heading, H1 preferred; keep the 72-char cap that `deriveIdentity` already uses
  (`src/engine-core.ts:251-262`).

### 2. Chapter body: a labeled section **after** the transcript

`renderChapter` appends one block, after the verbatim transcript and before the closing of the body —
never interleaved, so the transcript stays exactly what the log said:

```
## Plans in this chapter

### Plan — "Carry session plans into chapters" — APPROVED (call seq 412, result seq 419)
- full text: `artifacts/8f/8f3a1c….txt` (18.4 KB ≈ 4.6K tok) — chapters_artifact 'toc' | 'search' | 'read'
- outline: Goal · Success criteria · Changes by subsystem · Tests · Assumptions · Rollback
- head (first 900 chars, verbatim): `# Carry session plans into chapters …`
- mode: plan mode ACTIVE from seq 118 (log event plan/mode, seq 118)
- superseded by the same-titled plan at seq 455 — that one is operative
```

Frontmatter gains `plans: [412:approved:8f3a1c9d]` — one `seq:status:sha8` triple per plan — and
`planMode: active|inactive|unknown`, BOTH emitted only when the chapter really carries a plan or a mode
flip. *Why the compact triple instead of the nested list this record first specified:* the only reader of
frontmatter is `indexing.parseFrontmatter`, which understands `key: value` and flat `key: [a, b]`. Nested
YAML maps parse as nothing at all — an index that looks populated and reads empty, the worst kind of lie
here. So the machine-readable home for the full facts is the **chapter record** (`ChapterRecord.plans`,
zod-validated in the registry, `src/store.ts`), which is what the notice builder consumes; the
frontmatter line is the human-visible claim of the same fact, and the prose lives in the body block.

Display bounds, added at 0.1.8 (two of them — the second is the same mistake one scale down):

- the OUTLINE line is an index, not the document: `PLAN_OUTLINE_MAX_ENTRIES` (12) at
  `PLAN_OUTLINE_TITLE_MAX` (60) chars each, and when entries are dropped the block says
  `+more (chapters_artifact 'toc' lists every heading)`. A silently shortened index is the lie this store
  exists to avoid, so truncation is always announced and the full map is one query away.
- the TITLE is printed at most 120 characters
(`PLAN_TITLE_MAX`, `src/plans.ts`) — a 4 KB H1 would otherwise have been repeated in every chapter carrying it
AND in every child notice built from that path, unbounded and un-costed until the budget gate refused the
continuation. The artifact keeps the heading whole; only the display is bounded, which is the same
distinction `planInlineChars` draws for the body. Closed ATX headings (`# Title #`) lose their trailing
hashes in the title, not in the bytes.

The sha256 anchor convention must hash what `parseChapterFile`
returns — body **including** the trailing newline (`src/engine-core.ts:297-302`; the T9 lesson: a
mismatch silently blocked enrichment for an era).

`plan/mode` gets an explicit `case` so its handling is *stated* rather than a silent skip: it renders as
the `mode:` line above and does not enter `unrenderedSeqs`.

### 3. Invocation artifacts, generally (the honest fix for "always inline")

Any `tool/call` whose serialized arguments exceed `callArgArtifactTokens` gets the same treatment:
full blob to the artifact store, bounded head + path inline. Plans are simply the case that earns the
mechanism. In the same commit, correct `docs/architecture.md:73` and `:97`, which claim invocations and
arguments "always stay inline" while the code caps at 400 (`src/render.ts:255`). The real rule:

> Invocations are always inline; a bounded head is always artifact-backed. Every byte of an
> invocation and its result remains retrievable.

### 4. The notice: `plansSection`, built exactly like `rulesSection`

`assembleNotice` takes an optional `plansSection: string` (`src/continue-core.ts:111-141` precedent).
Empty or absent ⇒ **zero injected bytes**, which is what keeps this tape-safe (§ Tapes). Placement:
between the project line and the preamble, so it is above the fold:

```
## Plans on this path (3: 1 approved, 1 rejected, 1 pending)
- ACTIVE PLAN: "Carry session plans into chapters" — APPROVED (ch. 4, seq 412, sha 8f3a1c…, ~4.6K tok)
  full text: .dsh-chapters/artifacts/8f/8f3a1c….txt — read it with chapters_artifact before implementing;
  do NOT re-plan from recall.
- REJECTED v1 "…" (ch. 4, seq 388) — user feedback is archived in that chapter
- pending "…" (seq 501) — the review was never answered. NOT approved; do not implement it.
```

Cost is counted, never exempted: the section is part of `noticeTokens` and flows through the same
`preflight` (`src/continue-core.ts:146-162`) — `tocTokens + handoffNoteTokens ≤ ratio × (window − header)`.
Over budget ⇒ refuse with numbers. **Do not "remove the token measurement" for plans.** The measurement
is the only thing that keeps the refuse-with-numbers rule true; exempting a multi-K-token prose form
would make the 8K chapter target and the child's cold head meaningless on exactly the 32K hardware this
project targets. Economy comes from *carriage* (artifact + bounded head), not from blinding the meter.

### 5. `chapters_segment` reports the facts

Add to the output (`src/tools.ts:186-205`): `plans: [...]` (every field a model needs to choose ranges,
minus the text), `modeActive`, and `livePlans` — plans whose `seq > archiveCeiling` (an open turn:
precisely the mid-review case), explicitly labelled *not archived, parent log only*. Ranges stay the
model's call and chapter text stays the plugin's (invariant 4); the model never guesses a verdict again.

### 6. Composition and titles

- Forced split points: an `exit_plan_mode` call seq is a topic boundary — feed them to
  `composeChapters` (`src/compose.ts:78`) so a plan is never buried mid-chapter.
- `deriveIdentity` prefers the plan H1 when a span opens with a submission (`src/engine-core.ts:251`);
  `HARNESS_PROSE` (`:248`) stays as-is — a plan is not harness prose.

### 7. Config register (Schemastery `Config`, `src/index.ts:53-110`) — no hardcoded tunables

| Key | Default | Meaning |
|---|---|---|
| `planInlineChars` | 900 | Verbatim head in the chapter block. The artifact holds the rest. 0 = pointer only. |
| `callArgArtifactTokens` | **0 (off)** | Above this, a tool-call argument is artifact-backed. |
| `plansInNotice` | true | Renders zero bytes when the path holds no plans. |

*Two amendments, both made by measurement rather than taste.*

- **`planModeEvents` was cut.** A `plan/mode` event is either printed in the Plans block or it is a
  silently dropped byte, and silently dropped bytes are the one thing this store does not do. There is no
  honest second value for that knob, so the rule is unconditional: the flip prints, and the folded state
  lands in `planMode:`.
- **`callArgArtifactTokens` ships at 0, not 600.** Turning it on changes chapter bytes wherever a `write`
  call carried a whole file — and the recorded model tapes are full of such turns (§ Tapes). Plans are
  unaffected: their carriage is unconditional and named. A deployment that wants argument blobs opts in
  deliberately, knowing it owes a re-record.

### 8. Search, and why no new index

A plan is discoverable through the **chapter that cites it**: the chapter's `topics` frontmatter is
already the index unit (`src/indexing.ts:140-152`, `src/search.ts:104`), so `chapters_search` returns
the chapter, whose body hands over the artifact path, and `chapters_artifact` (toc / search / read) does
the recursive descent — a Markdown plan has headings, so `action:'toc'` yields a line-numbered map for
free. **No second index** (hard rule; the TOC is the only index). Making plans corpus documents
(`kind: plan`, indexed like rules — the `sync.ts:203` "rules are chapters of a different kind, same
transport" precedent) stays deferred to § Deferred.

Registry note: **do not** use `state.plans` — that name is the compaction manifest
(`src/registry.ts:37`, `src/store.ts:67`). If a cross-session lookup is ever needed, name it
`submittedPlans`.

## Invariant audit

| Invariant | This design |
|---|---|
| 1 — never rewrite the durable log | Read-only over the log; artifacts and chapters are appends. Original plan events stay in the parent forever. |
| 2 — never seed from parent events | Unchanged: still one synthetic notice event at `seq 0` (decision 2 — no `plan/mode` seed). |
| 3 — never contribute a system-prompt section | The plans section is per-continuation notice text, not a header contribution. We only *read* plan mode's contribution. |
| 4 — never let the model author chapter bodies | The plan text is copied from the log by the plugin; the model supplies ranges and gets facts back. |
| Hard rules | No new index; no renumbering (plan blobs are content-addressed, chapters untouched); ranges still validated (`validateRanges`, `src/render.ts:96-123`); never truncate to fit — the head cap is a *display* choice with the full bytes retrievable, and the budget still refuses. |

## Tapes and e2e impact (measured, not assumed)

- `grep -rlo "exit_plan_mode\|plan mode\|plan-mode" tests/fixtures/` → **no hits** (2026-10-09). No
  recorded scenario submits a plan, so a conditional plans section renders zero bytes in every replay:
  **no re-record required** for the notice or renderer changes. Re-confirm after implementation — if a
  product prompt *is* edited (personas, tool descriptions, notice text), the rule stands: re-record
  **whole projects**, never one spec of a shared boot.
- New e2e project `plans` (own boot, own `E2E_PORT`, throwaway home `var/e2e-home-<port>`, one journey =
  one boot — the fork- and fanout-carve-out lesson), recorded once then replayed. Prompts must be
  tool-free **in words the model obeys** (the RR2 OOM lesson). **LANDED 2026-10-10 as the eighth chain
  project** — but NOT from the live model: the box's `:8080` server closed the stream mid-turn
  (`turn/end` `reason {kind:"error", code:"TRANSPORT"}`), so the tape was distilled through the scripted
  upstream `tests/e2e/stub-model.ts` (wire format copied form-for-form from recorded llama.cpp traffic).
  `tests/fixtures/model-tape/plans/PROVENANCE.md` states what that proves (the whole carriage, in a real
  browser, against the real review channel) and what it does not (a model choosing to plan), and carries
  the re-record command that retires the stub.
- **The threshold is pinned to 0.99 for this project (0.1.10), and the journey asserts its own
  precondition.** At the stress regime's 0.9 the hosted runner crossed the compaction trigger and issued
  a plot-elicitation call that no locally-distilled tape had ever seen — a MISS that only CI could
  produce, after three local greens. So this journey pins its own determinism: no compaction may interrupt
  it, and the spec fails if `compaction/*` appears, with the reason written where the assertion lives.
  Determinism that only holds on the machine that recorded the tape is not determinism.
- **0.1.11: the pin is structural, not numeric.** 0.1.10's threshold pin did NOT stop the hosted runner
  compacting (same annotated miss), so the journey now boots with `auto: false` + `elicitedPlot: false`
  (`E2E_NO_AUX_MODEL=1` in the chain, applied by `boot.ts` into the throwaway preset). No auxiliary model
  request can exist for a tape to be missing. The `compaction/*`-absent guard stays, to catch someone
  undoing it.
- **The replay chain reports its own failure** (`scripts/ci-replay.sh`): project + failing tests, the
  proxy's tape-miss journal tail, and the engine diagnostics tail that every boot already writes.

### What the browser plane corrected (this is why it exists)

Every item below was an assumption the deterministic plane had encoded — and the live run said otherwise:

- **`planMode:` at a plan's chapter end is `inactive`, not `active`.** Approving a plan EXITS plan mode,
  and the host appends that flip at the next accepted pre-step — inside the same turn, before
  `turn/end`. My expectation said `active`; the archived chapter said `inactive`, and both mode flips
  printed. The fold was right; my belief was wrong.
- **The toolbar chip is an EXIT control only.** `PlanModeControl` renders when
  `plan.pending ? !plan.active : plan.active` (`dsh-client-ui-plan/lib/client.js:39-41`), so there is no
  "press to turn plan mode ON". Entry is `/plan <message>` in the composer, which appends
  `plan/mode {active:true}` before the turn and steers the text as one real user message. Learning that
  cost one 40-minute timeout on a locator that could never appear.
- **`text=Approve this plan…` hangs; `getByRole('region', {name: /Approve this plan/})` does not.** The
  question is the review REGION's accessible name, not matchable element text — read off the failure
  snapshot, which is the only honest way to find this out.
- **A seeded event read out of the session log is JSON-escaped.** `expect(raw).toMatch(/ACTIVE PLAN: "x"/)`
  can pass as a substring and fail as a regex; parse the event and assert on `data.content[0].text`.
- **`expect.poll(..., {intervals: 3000})` throws a TypeError** — intervals is an array. Trivial, but it
  killed the first two recording runs.
- **A scripted upstream that string-matches the message array lies confidently.** The stub's first
  `decide()` searched all messages for `exit_plan_mode`/`approved` — both words live in the SYSTEM PROMPT
  (tool catalog + plan policy), so every turn answered as if the review were done and the review card
  never opened. The honest signal is the transcript's SHAPE (`role:'tool'` exists only once a tool ran).
  Pinned by `tests/unit/stub-model.test.ts`, because a stub that answers wrongly records a tape of a
  session that never planned.
- **Acceptance assertions must be scoped to the session tree the run created.** Scanning the whole store
  lets a previous run's plan satisfy the next run — a green that proves nothing.
- Coverage: `npm run coverage:ci` gate (≥85 all four) must stay green; `src/plans.ts` is pure and gets a
  full-branch row like the other planners, and the new `render.ts` arms need the success/refusal
  surface covered the way the 2026-09-23 sweep did it.

## Verification rows to add to `docs/verify.md`

| # | Claim | Evidence |
|---|---|---|
| P1 | Verdict classification is right for all four shapes + superseded | `tests/unit/plans.test.ts` over host-shaped fixtures (mirror the real nesting the way `tests/unit/render.test.ts:18-22` mirrors tool-result shape) |
| P2 | A plan with no result is `pending`, and `pending` never renders as approval | unit + a notice golden test |
| P3 | Full plan bytes are retrievable: archive → artifact exists → `chapters_artifact` read returns them byte-identical (modulo redaction) | integration, same style as `corpus-hygiene.test.ts` |
| P4 | `plan/mode` no longer lands in `unrenderedSeqs`, and no other event type silently vanishes | `tests/unit/render.test.ts` rows (the `mystery/event` row at `:124-129` must stay) |
| P5 | The plans section is counted by `preflight` and an over-budget archive refuses **with numbers** | unit on `preflight` + integration on `runContinue` |
| P6 | A plan above the ceiling is reported as `livePlans` and carried, marked not-archived | integration on `chapters_segment` |
| P7 | Injected spans inside a plan body are screened; a plan quoting `AGENTS.md` in prose survives verbatim | `injections.test.ts` rows (H1 family) |
| P8 | Zero bytes when the path has no plans (tape neutrality) | notice golden test, both directions |
| P9 | Both carriage paths agree (continuation AND in-place engine compaction) | `tests/unit/plans-engine.test.ts` |
| P10 | A chapter's `artifacts/…` citation resolves whether the blob sits at the store root or inside the ancestry tree | `tests/unit/artifact-query.test.ts` + the integration row |
| P11 | The browser journey, once its tape is recorded | `tests/e2e/plans.spec.ts` (project `plans-dev`, self-skips without the live model) |

`docs/verify.md` § Plans Carriage is the ledger; this table is the design's own list of what it claims.

## Landing stages

| Stage | Deliverable | Status (2026-10-09) |
|---|---|---|
| 0 | This record lands; no code | done — reviewed, decisions 1–3 held |
| 1 | `src/plans.ts` + `src/log-shape.ts` (the shared pairing readers) + unit rows | done — P1/P2/P7 |
| 2 | `render.ts` Plans block + frontmatter + invocation artifacts; `docs/architecture.md` wording fix | done — P3/P4/P8 |
| 3 | `chapters_segment` facts + composer split points + `deriveIdentity` preference | done — P6 |
| 4 | `plansSection` in `assembleNotice` + wiring + config register | done — P5/P8/P9 |
| 5 | Site docs (§9 anatomy, §16 tools, §17 configuration, §18 notice) | done in the same release |
| — | Seven-segment tape replay | green WITHOUT re-recording (2026-10-09, `npm run test:e2e:replay`, EXIT=0) |
| — | `plans` browser journey | LANDED as the eighth chain project (2026-10-10) and immediately **extended to two legs** so § 12's continue-vs-branch distinction is tested, not described: a `chapters_segment`→`chapters_continue` continuation (asserts `## Active plan`, the plan's document path, and NO seeded gate because approving a plan exits plan mode) and a fork-button branch (asserts **no** directive section, archive still cited). Replays in 17 s on a committed tape; the eight-project chain re-runs for the 0.1.9 ship. Its tape is scripted-upstream distilled — see § Tapes and `PROVENANCE.md` |
| 8 | `/chapters-continue` — the deterministic door for continuations (§ 15): continuation leg back in the tape chain, both intents covered in the browser, no frozen ranges |
| 7 | Journey made hardware-independent (0.1.10): 0.99 threshold pin + `compaction/*`-absent guard; replay chain annotates its own failure and ships the engine diagnostics | built — tape re-distilled under the pin, eight-project chain `CHAIN_EXIT=0` locally, hosted acceptance green at the 0.1.10 tag |
| 7 | Findability round (§ 14): local search door over a shared scorer, `## Finding things` in the notice (`retrievalHints`), kernel-drift gate on the seed contract | built — verify.md P18–P20; two pinned contract rows amended with reason; eight-project chain re-run |
| 6 | Second-round decisions (§§ 9–13): intent-aware notice, seeded plan mode for continuations, `kind: plan` documents, checkpoint carriage, the one injection-screen exception | built 2026-10-10 — verify.md P12–P17; 582 deterministic rows green, gate 98.05 / 86.44 / 93.67 |
| — | Follow-up, not blocking | re-record the `plans` tape from the live model — ATTEMPTED TWICE on 2026-10-10 and both times the model container dropped the stream mid-turn (`TRANSPORT`), one after 15 minutes with zero tool calls; `PROVENANCE.md` says what to check first. The carriage evidence does not change, only the claim about model behaviour |
| — | Browser-plane ledger | `npm run coverage:e2e` over all EIGHT replays: **79.92 stmts / 64.64 branch / 76.28 funcs** — the non-gated plane, reported rather than tuned (the deterministic gate is the enforced one) |

Deterministic ledger at landing: **549 unit+integration rows, zero failures** with the TreeDX container
up (80 of them new, across `plans`, `render-plans`, `continue-plans`, `plans-segmentation`, `plans-tools`,
`plans-engine`, `log-shape` and the `plans-carriage` integration), `npm run coverage:ci` **98.11 % stmts /
86.44 % branch / 93.8 % funcs** — the gate (≥85 on all four) green, branches *up* from the 85.61 % the
record started at. The seven-segment tape replay then ran against the BUILT artifacts: EXIT=0, 8 tests,
with no tape re-recorded.

### Two things the implementation found that the record had not predicted

- **`renderChapter` cannot pair a verdict inside its own range.** A composed chapter boundary can fall
  between an `exit_plan_mode` call and the `tool/result` that answers it, so a range-local scan printed
  APPROVED plans as PENDING — the exact inversion this feature exists to prevent. The scan therefore runs
  over the whole event list the caller passes (`buildFinalizedChapters` now hands it the full shadowed
  span instead of one chapter's slice) and only the *display* is range-filtered. Pinned by P9.
- **An ancestor path's plans cannot be ordered by `seq`.** Every session numbers its own events from zero,
  so a root chapter's seq 40 and a child chapter's seq 3 are incomparable numbers, and sorting the notice
  rows by seq would crown the wrong plan as operative — the exact failure mode the block exists to remove.
  The rows therefore travel in **causal order**: the registry walk's root-first chapter sequence, plans
  within a chapter by seq, then the caller's unarchived tail, and `buildPlansSection` prints that order and
  takes the last row as operative without re-sorting. (This is the same flattening rule the chapter list
  already follows — reading order IS causal order — applied to a new record type; pinned by a unit row.)
- **Deferred artifacts were already unreachable, for every blob, not just plans.** `writeArchive` writes
  to `<storeRoot>/<rootSession>/artifacts/…`, the arrival stubber writes to `<storeRoot>/artifacts/…`, and
  `resolveArtifactWithMirror` looked only at the second place plus the mirror — so a chapter's own
  `artifacts/aa/<sha>.txt` citation, the standard form the body prints, could 404 on the machine that
  wrote it. The resolver now walks the session trees between the store root and the mirror (P10), which
  is what makes "every byte remains retrievable" true rather than intended.

## 14. Findability: a plan nobody can reach is a plan nobody follows

The four decisions made plans *carried*. The audit that followed ("make sure a new session can find the
plans, rules, and other important details when asked") found the index was already correct and the
**access path** was not — two separate defects, both now pinned:

1. **`chapters_search` needed a pool mirror.** Unlinked, it answered `[]` plus "link a remote" — while
   every `kind: plan` document sat in the workspace store two directories away. Search now has a local
   door over the **same scorer** (`rankEntries`), falls back to it when the pool has no match, names
   which door answered, and distinguishes an empty workspace from a missed query. Artifacts stay out of
   the index on purpose: they answer to `chapters_artifact`, and indexing them twice is the second index
   the record forbids.
2. **The child was never told the verbs.** The notice taught `read` and nothing else; `chapters_search`
   and `chapters_artifact` were installed but unmentioned — so for a small model they did not exist. The
   notice gains `## Finding things` (three lines) and says the one thing a session cannot infer: that
   plans are searchable **as plans**.

Measured before believing: **no committed tape prefix contains a seeded notice anywhere** (checked
entry-by-entry across all eight projects), so the notice change costs zero re-records and the chain
replays green with it. That is coverage luck, not design — no current journey makes a *continuation
child* speak — which is why the child-facing prose now has golden rows, why the live-model leg exists,
and why "a child answers a findability question in a browser" is on the open list rather than claimed.

Two rows in the suite pinned the OLD contract and failed loudly, which is the only reason this section
is honest: `no mirror ⇒ honest empty` became `no mirror ⇒ the local answer, with the door named`. Amended
in place with the reason in the diff, because a silently-passing old expectation would have meant the
feature shipped broken and green.

## 15. The deterministic door: `/chapters-continue`

Attempt 5 settled an argument that had cost three releases. Two facts, both measured:

1. **A tape cannot carry a model-authored range.** The continuation leg broke on the runner because the
   recorded `chapters_continue` arguments said `endSeq: 30` while the runner's own ceiling was 29.
   `validateRanges` refused — correctly. Nothing about pinning a threshold can fix a number frozen in a
   recording.
2. **A small local model will not reliably chain two tool calls.** Live, it called `chapters_segment` and
   then answered in prose. So the leg could not be made green by asking the model harder.

Both have the same cure: the plugin already knew how to create a child without a model. `/chapters-fork`
derives everything itself — *"no model involvement — `deriveRanges` is deterministic, so a click needs no
agent turn and no proposed ranges."* The gap was that this door was hard-wired to `intent: 'branch'`, and a
branch by decision 3 asserts **nothing** about plans. So every property of the *continuation* shape
(`## Active plan`, `## Previous plans on this path`, the seeded `plan/mode`, the `plan document:` citation)
was provable only through the model's door.

**`/chapters-continue` is that same builder with the other intent.** Archive semantics are identical by
user decision (everything since the watermark). It is one `deterministicCommand(door)` producing both
defs — name, verbs, intent, and the no-directive prose are the only differences, and
`tests/unit/continue-command.test.ts` pins that the two doors **archive identically** (same ranges, same
titles, same plan facts) so the factoring cannot drift into two implementations. Consequences:

- the continuation leg is **back in the tape chain**, replaying on every push with no GPU and no frozen
  number (it needs no model request at all — the child is created by the command, and asserted from its
  durable log without the UI switching to it);
- the browser plane now covers **both intents**, which is where decision 3 actually lives;
- and the tool `chapters_continue` keeps existing for the model's own use — it is simply no longer the
  only way to learn whether a continuation carries its plan.

### The seeded-gate case: measured, and why there is no browser row for it yet

The open question was whether the host gives a completed turn to archive while a plan review is still
pending. Answered from attempt 5's own log (no speculation): `plan/mode` active at seq 4,
`exit_plan_mode` at 20, the verdict at 21, `plan/mode` inactive at 23, `turn/end` at **41** — the turn
containing a submission does not end until the review is answered. So:

- a session whose *only* turn is pending has **no ceiling**, and `/chapters-continue` refuses with its
  first guard (`nothing to archive yet — the conversation has no completed turn`);
- the seeded case is reachable in a browser only when an earlier turn already closed — which means a
  second distilled session (a plain turn, then `/plan`), not a rewording of the current one;
- the plugin-side behaviour for that shape **is** pinned at L0: a pending-review fixture yields
  seed `['user/message', 'plan/mode']`, the notice line `Plan mode is ACTIVE in this session`, and the
  plan marked PENDING/un-stored (`continue-command.test.ts`).

So the honest statement is: the seeded continuation is covered deterministically and structurally, and
NOT yet observed in a real browser. An attempt at that browser row on 2026-10-11 was built and then
REVERTED, unshipped, for two reasons worth recording so the next person does not re-derive them:
(a) the scripted upstream had to learn to answer PLAINLY in plan mode, and its decision rule first keyed
on the LAST user message — but the harness appends its own injected user messages (instructions, runtime
snapshot, skill catalog) AFTER the human's, so the ask was invisible and the journey hung on a review card
that could never appear; that ordering trap is now pinned by a unit row; and (b) a stale stub process
serving pre-edit logic made the failure look like a product problem. Neither is a product defect. The
shape is sound — `plan/mode {active:true}` logged, turn completed at seq 21, no tool call — so a future
leg needs the plain branch plus a fresh distillation, and nothing else. Building that row needs new stub rules and a fresh distillation; it is
recorded as the remaining piece rather than quietly claimed.

## Deferred (human decisions, not ours)

- ~~`kind: plan` corpus documents~~ **decided and built** (§ 11).
- ~~Seeding `plan/mode`~~ **decided and built** (§ 10), for continuations only.
- ~~Whether the mode-switch notice stays screened~~ **decided and built** (§ 13).
- **Per-message anchoring** — still open, and decision 3 clarified rather than settled it: a fork
  splits the task, so the interesting anchor is *"branch from THIS plan"*, which `deriveRanges`
  already supports mechanically but the button still forks at conversation end. Needs the UI
  affordance and an answer on how the child is told what it did not inherit.
- Whether the `plan-mode` mode-switch *notice* should stay screened out of chapters (decision 2026-09-21
  says injected context is not conversation; a human-initiated mode flip arguably is). Small text, but
  it is the one place the blanket screen drops something a reader might want.

## Proposed AGENTS.md lines (deliberately NOT applied yet — it is the unimplemented-feature rule)

```
- `docs/plans-carriage.md` — **read before writing code in this area**: how a session plan reaches the
  chapters, the TOC, and the artifact store; and why the token meter is never exempted.
```
plus a find-fast row `plans in chapters / active plan in TOC → docs/plans-carriage.md (+ site §§ notice, archive anatomy)`.


## Decisions taken (second round, 2026-10-10) — all four deferred items resolved

The human answered the deferred list, and #2 came with a distinction the first round
had not drawn: **a continuation extends the same stream of work; a fork splits it.**
That single difference decides what each child is told about the operative plan, and
it is now the axis the whole carriage hangs on.

| # | Decision | What it means in code |
|---|---|---|
| 1 | **`kind: plan` documents — yes** | each plan becomes its own indexed document (§ 11) |
| 2 | **Seed plan mode into children — yes, but only for continuations** | `plan/mode {active:true}` as the child's own second seed event (§ 10), `intent === 'continue'` only |
| 3 | **Fork = split the task; compaction/continuation = keep it** | `PlanIntent` selects the notice shape: `## Active plan` + `## Previous plans` for a continuation, NOTHING for a branch (§ 12) |
| 4 | **Targeted exemption for the mode-switch notice — yes** | `isSessionStateNarration` archives it verbatim; the general screen is unchanged (§ 13) |

Plus, from the same message: *"I support anything that is going to keep the agent anchored to
the current task"* — which is why the operative plan is now carried into every **in-place
checkpoint** as well, the way the plot is (§ 9).

### 9. The checkpoint carries the operative plan (the plot mechanism, applied to directives)

`extractPlot` proved the pattern: state that must survive a shadowed region travels *inside*
the checkpoint text, bounded, with its provenance. `carryActivePlan` does the same for plans —
with one deliberate difference in **scope**: the plot reads the region being condensed, while
the operative plan is chosen **session-wide, newest submission first**, because "what am I
building" is not a property of the region being hidden. `planSummarize` prefixes it on both the
composed and the legacy path.

Two honesty notes recorded rather than smoothed:
- **No sha is cited in the checkpoint.** At summarize time the chapter does not exist yet, and
  an unverifiable citation is worse than none — the carry says "the archive chapter holding
  this plan cites its complete text" instead.
- **Truncation is announced** (`carried truncated — …`), never silent, even though the
  bound (`planCheckpointChars`, 1600) is a display economy choice and the archive holds all.
- The pre-existing asymmetry that `plot` is prefixed only on the legacy path was **left
  alone**: changing it would rewrite checkpoint bytes for every plot-carrying session, i.e. the
  committed tapes. Plans are new, so carrying them on both paths costs no re-record.

### 10. Seeding plan mode — measured against the installed kernel, not assumed

The claim needed proof, because invariant 2 pins the seed as *one synthetic event at seq 0*.
Probed directly against the shipped `Session` (`0.1.5-rc.1`) in the exact production header
shape (`isSeeded:false`, `inheritedEventCount:0`):

| probe | result |
|---|---|
| is `plan/mode` a kernel-known event type? | **yes** — it is in `KNOWN_SESSION_EVENT_TYPES` (56 types) |
| seed `[notice@0, plan/mode@1]` accepted? | **yes** — log becomes `0:user/message → 1:plan/mode → 2:session/end-seed` |
| is it surface-visible? | **no** — surface nodes stay `[0]`, matching the host's own log-only `plan/mode` |
| does the HOST's own projection fold it? | **yes** — `planProjectionDefinition.apply` over the child's log yields `active: true`; the one-event control yields `active: false` |

So the seeded child is genuinely gated, not merely told. The surface validator narrows by type
rather than whitelisting (`assertSessionEventEnvelope` checks the envelope and continuity),
which is why this works without touching the kernel. **Invariant 2 is intact in substance**: the
seeded event is a synthetic fact this plugin authors about the boundary, never a slice of the
parent's log — the rule's letter ("exactly one event") is amended here and in AGENTS, and the
amendment is only safe because it was measured.

Seeding is refused — correctly, not defensively — when the fold says inactive, which is the
normal case after an approval: **approving a plan exits plan mode**, so a continuation whose plan
was approved gets `## Active plan … APPROVED` as a work order to implement, and no gate.

### 11. Plans as `kind: plan` documents

A plan is now also a file of its own: `<storeRoot>/<rootSession>/chapters/plan-<NNN>-<slug>.md`,
frontmatter leading with `kind: plan`, then `status`, `planSeq`, the citing `chapter`, `sha256`
(the blob's hash — the same bytes, so the two handles cannot drift silently), `bodySha256`,
`tokens`, `topics`. The body is the plan and nothing else: no transcript, no wrapper.

Choices worth their reasons:
- **In `chapters/`, not a new tree.** The pool transport, the mirror rehydrate (0.1.5) and the
  corpus index then carry plan documents with zero special casing. `loadCorpus` no longer
  flattens a file's own kind back to the directory's, so `kind: plan` survives indexing and
  `chapters_search` can answer *"what did we plan about X"* with the directive itself.
- **Its own registry counter** (`nextPlanNumber`, allocated through `reservePlan` under a
  distinct attempt key). A plan never consumes a chapter number or reorders the TOC, and names
  are still allocated through the registry rather than by scanning a directory — so a
  concurrent sibling cannot pick the same file. `plan-NNN-` (not `NNN-plan-`) so a listing
  never reads as two chapters claiming 001.
- **The blob stays.** Two handles, one purpose each: the content-addressed blob is what a
  chapter cites without knowing any number, and what `chapters_artifact` takes (it accepts a
  bare sha); the document is what the index searches and what a human browses. Same bytes, and
  the record ties them with one sha.
- **Enrichment skips plan documents.** The ladder annotates narrative; a directive's body is
  approved text, and paraphrasing an order is precisely the drift this store exists to prevent.
  Guarded on the frontmatter `kind`, not the filename, so renaming cannot disarm it.
- **Superseded plans keep both documents.** Evolution is history: the v1 file says
  `status: superseded` and is never rewritten, the v2 file says `approved`.

### 12. The notice is intent-aware

`buildPlansSection(…, { intent, modeActive, seeded })`:
- **`continue`** → `## Active plan` (the operative directive, with its verdict, chapter, blob
  and document paths) and, only when earlier submissions exist, `## Previous plans on this
  path` marked *history — cited for evolution and status, not directives*. If plan mode was
  seeded, the block says the directive is live and implementation waits for an approval; if
  it was not, the child is told plainly that it starts outside plan mode.
- **`branch`** → **empty string, zero bytes.** A fork splits off a new direction; re-asserting
  the parent's directive into the branch would be an order nobody gave. The plans are still
  fully present — in the chapters the TOC already cites, and as searchable `kind: plan`
  documents.

### 13. The one exception to the injection screen

`isSessionStateNarration` matches `source.kind === 'plugin' && plugin === 'plan-mode' &&
form === 'notice'` — the harness's own "The user switched this session to plan mode." — and
`screenConversation` archives it verbatim instead of marking it omitted. Named by plugin AND
form, so it cannot widen by accident; an instruction file or a runtime snapshot arriving under
any other shape still screens. `isHumanAuthored` deliberately stays strict, because the topic-
signature layer is what decides chapter boundaries and the r28 lesson was that injected text
poisons that signal. The archive gains a fact about the session; the index gains nothing it
should not have.
