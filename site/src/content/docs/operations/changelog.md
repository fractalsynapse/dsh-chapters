---
title: "26. Changelog & release notes"
description: Every version, what it fixed, and the incidents that found them — written the way we'd want to read it.
lastUpdated: true
---

Releases publish automatically from a bare-semver tag via **npm trusted publishing (OIDC)**. The publish itself is gated on the full deterministic suite under the coverage gate; the eight-segment tape-replay acceptance chain runs in CI on every push to `main`, so a release is always cut from a green acceptance run. Each CI-published version carries a provenance attestation tying it back to this repo, that workflow run, and that commit — 0.1.0, the one manual ship, predates attestation.

### 0.2.5 — 2026-10-30 · the bar stops littering your history

A patch with one job. After `0.2.4` the maintainer found session history "littered with multiple `chapters-prompt`
runs, one right after another" — and the mechanism was measured, not guessed: the Suggested Next Step bar talks to its
server through `remote.commands.execute('/chapters-prompt state')`, and the host records **every** command execution as
a `command/run` + `command/done` lifecycle pair that the web UI renders as a history node (`recordInput: false` hides
only the args; no quiet-invocation mode exists on that wire). The bar's unconditional 10-second keep-poll was therefore
writing ~360 visible nodes an hour into every bar-enabled session. The command was never "back" — the bar IS the
surface; its transport was just audible.

**The cadence is now a decision, not an interval** — a pure function in the module that holds every other bar decision,
with a row per arm and a mutation check behind it:

- **10s only while state can plausibly change**: a generation is `analyzing`, autorun is `armed`, or the host says a
  turn is `running`,
- **60s while stable** — an offer on screen changes only at the next turn boundary,
- **zero pulls in a hidden tab** while quiet — a background session writes no history at all — but an **armed** loop
  never pauses for a hidden tab, because walking away from a running loop is the point of autorun,
- **the idle edge pulls immediately** (a turn ending is exactly when a new offer is born), and so does the tab
  returning to the foreground — freshness where it matters *improved* while volume dropped ~6×,
- hosts that publish no running signal keep the old 10s behavior, unchanged.

The structural fix is filed and host-gated (#194): the host's push transport (`appendPluginRecord` + projections) makes
the steady state produce **zero** command executions — measured absent from the pinned host `0.2.0-rc.2` and present in
`0.2.1-rc.2`, so it waits on a host-pin bump with feature detection and pull fallback. The contract's old "0.2.x-only"
claim is corrected to 0.2.1+ with the tag evidence in this release's docs.

Corpus note: client-only — the prompt anchor did not move (`18d634dc4172a389`), the lib digest is identical to 0.2.4's,
and the nine-leg acceptance re-ran green on the fix (one `enrich` boot-ceiling flake on the first pass, proven a runner
flake by a green local replay and a green rerun).

### 0.2.4 — 2026-10-30 · the suggestion director stopped flying blind

`0.2.3` shipped the operating surfaces; this patch makes the model behind the Suggested Next Step bar actually
competent to lead — the maintainer's verdict on the old input was that the feature was "pretty much useless", and the
fix is #188 in full:

**The director reads the session's memory now.** The suggestion input became: the goal directive with the objective
WHOLE (the old 600-character slice was itself a truncation), the active plan, the core rules — rendered by the same
builder a rebuilt head uses, so director and worker can never serve under different rule sets — every chapter on the
**ancestor path** as title + **detailed** summary + **every plot line** (extracted deterministically from the archived
bytes, zero model tokens), and the last turn whole. A continuation mid-goal inherits its lineage instead of an empty
history; an ignorant director leading a stupid worker was the failure mode, and history is the cure.

**Zero truncation is an invariant.** The 500-character per-message slices are gone — a sliced message is a
hallucination invite. Over budget, the OLDEST chapter drops first, announced in the input itself, until the history
fits; the protected set never slices, and when it alone cannot fit the suggestion **refuses with the numbers** rather
than sending a starved assembly. Enrichment's output clamp went loud in the same spirit (` …[truncated]`, inside the
cap), and its summaries are now contracts: decisions, findings, state changes, open threads — the summary IS a
chapter's guidance value for this reader.

**The caps follow the model.** `promptMaxChars` 240 → **4096** (a cap that cannot carry a paragraph cannot carry an
instruction). The context budget derives from the selected model's REAL window — `contextWindow × promptContextRatio
(default 0.5) × 4 chars/token`: a 32K model and a 1M model get budgets 30× apart from one rule — and
`/chapters-prompt model <id> [maxChars] [contextChars]` pins explicit numbers beside the model, with
`/chapters-prompt state` reporting every effective value **and its source**.

**The budget never cuts off a goal.** `promptMaxRounds` governs open-ended iteration only; while a goal is active or
paused the pursuit is bounded by the goal's lifecycle, and `blocked` now disarms autorun exactly like `complete` —
server and client stop together, mutation-checked on both planes.

Corpus note: the prompt-byte anchor did **not** move (no command or tool description changed), so only the two legs
whose aux bytes changed — `prompt` (new assembly) and `enrich` (detailed-summary contract) — were re-recorded, green
on the real provider, and the full nine-leg chain replayed `SF=0` locally and on CI's blocking acceptance job.

### 0.2.3 — 2026-10-30 · the model settings became usable: discover them, read what they govern, and watch all three work

A small release with one theme — the three model-driven activities (enrichment, rules mining, prompt suggestions)
went from *configurable* to *operable*, and the pipeline that guards them stopped having corners.

**`/chapters-models` (#173).** The three keys all take `provider/model` routes and nothing in the product said which
identifiers this host accepts. Now: providers → advertised models as paste-ready ids → one exact route's context
window and reasoning efforts, with each key's current value and its setter in the footer. Two honesty rules it never
drops: catalog membership is advisory (the host routes unlisted ids; an empty catalog means "no selection offered",
not "nothing works"), and unadvertised capabilities are reported absent, never guessed. It is also the first feature
to move the prompt-byte anchor — `corpus:check` refused at build time exactly as #157 designed, and the nine-leg
corpus was re-recorded against the new bytes rather than smuggled past the gate.

**`/chapters-rule view <id>` (#174).** `list` shows titles — the first sentence cut at 60 characters — so a mined rule
could never be read on the command surface, and `approve` asked for a verdict on unseen text. `view` renders one rule
completely: full body, identity, this machine's effective status, pin, and the session-tier warrant (`active`,
held-for-`REVIEW`, and `basis: stated` vs `inferred` — with the caveat that an inferred rule is the model's, never
yours). A registry-only rule whose file hasn't synced says so instead of rendering an empty body.

**All three activities verified live (#175).** A new live-class leg runs against the real provider and asserts durable
artifacts: a mined rule with an honest `stated` basis (the quote gate checked the model's quote against human bytes
only), enrichment frontmatter written by a real completion with the verbatim body byte-identical, `view` reading the
mined rule back in full through the durable log, and a `/chapters-models`-printed identifier surviving the round trip
into the enrichment setter. The leg is excluded from the model-free acceptance chain by design, and every claim says
which class covers it.

**The suite corpus stopped racing the machine (#178).** Its journey's turn count had been a function of model latency:
the spec's fork click cut live tool-rounds mid-flight, so recordings held dangling `tool_calls` tails (audit: 5 of 17
entries) that instant replay then outran — CI's msg-5/15/17 misses, each fixed layer revealing the next. The opening
turn is now single-round by construction, two matcher folds landed from CI's own miss-dump bytes (embedded
runtime/time-context injection residue, and an elapsed-duration fold that ate `assistant:` segments inside plot-note
excerpts), and time-context snapshots joined the presence-volatile drops. **The acceptance job is blocking again** —
#92 made it advisory "until its evidence landed"; the evidence landed, and the interim's cost was measured: a poisoned
corpus failed acceptance while the run-level conclusion still read `success`.

### 0.2.2 — 2026-10-29 · the stable channel gets relief back, and the release line learns to check itself

The stable of the `0.2.2-dev` line: everything in `0.2.2-dev.2` — relief restored for models under 65,536 tokens (the
`headroomTokens` realm fix) and compile deps equal to the pinned runtime — plus sixteen commits that made the pipeline
*verify* what it had been trusting. It publishes when the maintainer tags `0.2.2` on `main` (npm trusted publishing; the
tag must equal `package.json` — `0.2.2-dev.1` is the permanent record of what happens when it does not), and `latest`
then moves off `0.2.1`.

**The relief note speaks now (#152, #153).** The note a compaction pass leaves on the surface carries per-pass numbers —
shadowed nodes, tokens removed, what remains — and its `window` comes from the adapter rather than a config key that
never existed, so a note cannot state a context size that is not true.

**The corpus anchor measures the only bytes that matter (#156, #157).** `CORPUS_HOST` pins a digest of the
model-facing prompt bytes, `npm run corpus:check` runs in CI's blocking job, and a prompt drift fails the build instead
of silently invalidating nine tape legs. The build digest still moves for non-prompt changes — the advisory says so —
but only the prompt anchor gates.

**A live mechanism is bound by its invariants, never a tally (#154, #155).** The `heavy` leg asserts what relief must
do — shadowing decisions, surface state, the note's content — with its count demoted to a runaway guard. It is
live-class, so the model-free acceptance job names nine legs, not ten (#149), and every claim says which class covers it.

**A dead boot explains itself (#165, #166).** A rig boot that misses its announce window now fails with the child's own
log tail attached — and names an exhausted inotify watch budget when that is the cause — instead of a bare timeout that
reads like a plugin defect. The message is bounded, and the boot URL, which carries a session token, is never copied
into logs or CI annotations again.

**The docs retract what was wrong (#162, #163, #164, #142).** The composer draft refusal is recorded as measured —
identical on both host runtimes, `draftRev` living in `ui-commands` and not `ui-conversation`, a host bump *not* the path
to #126; `coverage:e2e` states what it can promise (a report, not a verdict; its ceilings stay untouched); and the
workflow gains the rule that a decision needing the human goes through `ask_user_question`, because a question in prose
never blocked a running goal.

### 0.2.2-dev.2 — 2026-10-28 · relief came back for 32K models, and a dead tag taught the release line a rule

Published on npm as `@treeseed/dsh-chapters@0.2.2-dev.2` (dist-tag `dev.2`; `latest` still `0.2.1`, correctly, because a
prerelease must not claim the default channel).

**The defect this fixes was a product failure, not a pipeline one.** `dsh-compaction-basic@0.2.0-rc.2` validates
`contextWindow − reservedCompletionTokens − headroomTokens` for each routed target and throws
`TargetPressureConfigError` when it is ≤ 0. Its default `headroomTokens` is 65,536 — a reservation sized for a routed
summarize call, which this plugin's engine never makes, because `summarize()` is overridden and deterministic. Our realm
never bounded it, so **every model under 65,536 tokens got relief as an exception instead of compaction** — and 32K is
this project's own stated hardware. The realm now sets `headroomTokens: 8192`, and a fixable configuration is reported as
a note on the diagnostics sink with an abstention rather than escaping as a crash, while provider failures still
propagate. Seven rows reproduced the throw the moment the repo began type-checking against the host it actually boots.

**Why nobody had seen it for two host minors:** the repo's `@deepseek-ai/*` devDependencies sat at `^0.1.5-rc.2` while the
e2e rig boots `0.2.0-rc.2`. Both halves are fixed together, because they are one delivery — the `0.1.5-rc.2` tarball
contains no `headroomTokens` key at all, so a realm that set it against the old types would simply fail config
validation. Guards now make the drift loud: compile deps must equal the lock's pin exactly (and the *installed* copy must
match too), and four one-off auxiliary `llm.stream` call sites stopped carrying `source.kind: 'plugin'`, which session
format v4 retired and host 0.2.x refuses at row admission.

**The release rule this branch earned.** `0.2.2-dev.1` is a **dead tag**: its bump commit moved `package.json` only, while
a row pins `PLUGIN_VERSION === pkg.version`, so the publish blocker failed it. A pushed tag is never moved or deleted, so
`dev.1` stays in place unreleased and `dev.2` supersedes it — and every version bump now moves `package.json`,
`src/version.ts`, and the lockfile's two version fields in a single commit. Catching that also required
merging `main` back into `staging` (the previous release had squashed in, leaving the branches divergent), which is why
the release line is verified to have `main` as an ancestor before a tag is pushed.

**What is deliberately not claimed.** The `heavy` leg — one turn outgrowing the window, relief converging in bounded
passes — is now a **live-provider** leg rather than a tape leg: six captures of one commit produced 5, 7, 12, 23 and 24
recorded requests, because once relief auto-continues the session the child does work the spec never asked for, so the
count belongs to the run. The model-free acceptance set is nine legs, all green. And that live leg currently **fails its
own bound**: 38 compaction passes where the leg asserts ≤ 30, on a pinned 32K window. So this release ships *"relief
neither throws nor crashes on a 32K window"*; it does **not** ship a browser-level claim that relief *converges* there.
That is tracked as #143, whose first criterion is per-pass numbers, and the bound is not being raised to make it green.

### 0.2.1 — 2026-10-24 · published; recorded here for completeness

On npm as `@treeseed/dsh-chapters@0.2.1` (`latest`). Follows 0.2.0 on the host-0.2.x line; the release records for the
behaviour it carries are the 0.2.0 entry below and the concepts pages it points to. This entry exists because the site is
the release record and had none for it — a gap found while writing the 0.2.2-dev.2 note.

### 0.2.0 — 2026-10-24 · the host-0.2.x line begins; declaration rows and format v4

First release on the `0.2.x` host line: preset **declaration rows** become the supported way a plugin ships its
composition, and session **format v4** retires the bare `kind: 'plugin'` message wrapper — a continuation notice must use
a producer-owned kind such as `plugin:dsh-chapters` or the host refuses it at row admission. Both facts were measured
before they were written down, and the drift rows in `tests/unit/host-seed-contract.test.ts` and
`tests/unit/preset-declaration.test.ts` are what keep them honest after a host upgrade. Published on npm as
`@treeseed/dsh-chapters@0.2.0`.

### 0.1.18 — 2026-10 · the preset became a row you can see, like the host's own

0.1.17 made the preset exist again; it did that by *registering* a declaration row from inside the
plugin's startup. That fixed the bug and left a smell: a preset nobody can see is a preset nobody can
manage. It was absent from the plugin list and the config editor, could not be disabled from a profile
patch, and the one thing that should be configuration — the composition itself — was TypeScript.

- **The preset is now a declaration row in our own bundle patch**: `preset-chapters`, in
  `cordis.patch.yml`, carrying the same `config` shape as `@deepseek-ai/dsh-agent-preset` rows
  (`id`/`name`/`description`/`order`/`plugins`). Like the host's `preset-standard` / `preset-ptc` it is
  a visible Loader entry — inspectable, overridable from your profile patch, disable-able with
  `disabled: true`.
- **Its row module is ours** (`@treeseed/dsh-chapters/preset`), mirroring the host's plugin line for
  line (`inject: ['agentPresets']`, `static [EntryGroup.key] = true` so child `!!js` expressions are
  preserved until the child that owns them activates, and `[Service.init]` **yielding** the registry
  disposer so Cordis owns the registration's lifetime), plus one addition: rows this host cannot
  import are dropped and named. Why not the host package directly is measured in the repo's
  `docs/contract.md`: an unresolvable row aborts the plugin tree of a host predating declaration rows,
  and `dsh.bundle.patch` as an array will not even parse past one — so the row rides the single string
  layer we already ship.
- **The lifetime lesson, because it is the subtle one**: registering from `apply()` and handing the
  disposer to `ctx.effect` *un-registered the preset the moment activation finished* — measured as
  `register()` reporting success while the roster came back without `chapters`. A row's own init is the
  only place with the right lifetime. (Same family as r35's apply-fiber trap on the storage domain.)
- **The boot line now says whether the ROWS are active**, not just whether the preset is declared:
  `preset "chapters" is in the host roster — 30 mounted rows all active`. Declared-and-unusable was the
  failure mode this release shipped into on the first try, and one line distinguishes them.
- `installChaptersPreset` and `compactionThresholdRatio` became **accepted-and-inert**, with the reason
  in the patch header: deleting a config key can make an existing profile patch fail to *parse*, and a
  bundle that will not mount is worse than a key that does nothing. The engine threshold is
  `thresholdRatio` on the preset's own realm row now, retuned where the host retunes its presets.
- **Verified by real boots of the packed artifact on three hosts**: 0.2.0-rc.2 → present, 30 rows all
  active, `dsh-tool-schedule` dropped (unpublished at that release); 0.2.1-alpha.4 → present, 31 rows,
  nothing dropped; 0.1.5-rc.1 (pre-floor) → **boots**, logs `this host cannot register preset
  declaration rows (before 0.2.0)`, tools keep working. And the drift gate grew to 16 rows, each
  confirmed to fail on the mutation it guards — ralph re-disabled, an extra pruner key, `toolFilter`
  restored, `{{cwd}}` restored, the durable id renamed.

### 0.1.17 — 2026-10 · the preset had to be *created*, not merely installed — and the old delivery broke the old host

Reported by a user: the plugin is installed, enabled, and running, and the `chapters` preset is simply not
there. Sessions that had chosen it refused to **open** (`agent-preset/not-found`) while their logs and
chapters sat intact — so the archive looked corrupted when what was missing was composition. Nothing
crashed to say so: the plugin boots, its tools register, Settings says "enabled and running".

- **Why it happened.** Hosts from 0.1.7-alpha.1 stopped reading `$DSH_HOME/.agent-presets/` — a preset is
  now an `@deepseek-ai/dsh-agent-preset` *declaration row*. Our boot-time copy kept "succeeding", writing
  files no host reads, and reporting itself as installed. That is the defect this release closes.
- **The obvious fix is a boot-breaking one, and it was measured before being refused.** Shipping that row
  as a bundle patch layer means `dsh.bundle.patch` becomes an array, and on every host before 0.1.7 that
  array throws `ERR_INVALID_ARG_TYPE` while the profile is being read — the harness never starts. Putting
  the row in the layer a legacy host *does* read aborts that boot too (`Cannot find package
  '@deepseek-ai/dsh-agent-preset'`), and it cannot be capability-gated with `disabled: !!js`, because the
  Loader evaluates `disabled` before any service is mounted, so the row is disabled on the new host as
  well. The pinned test host (`0.1.5-rc.1`, frozen for tape bytes) hit all three.
- **What ships instead.** The plugin registers the `chapters` row itself at activation, through the host's
  own `agentPresets.register()` — the same call the host's declaration-row plugin makes. A host with no
  `register()` gets the legacy directory copy, unchanged. The mechanism is chosen by the service's shape,
  never by a version string, so one artifact serves the current release and the upcoming one.
- **Rows this host cannot import are dropped and named, not mounted.** One unresolvable row makes the
  *whole* preset `broken` (`mountPreset` throws), which is the same user-visible failure as a missing
  preset — and that is exactly what a static copy of the newer host's plugin list does on the current
  stable release: `@deepseek-ai/dsh-tool-schedule` is not published at `0.2.0-rc.2` at all. The mount line
  now says `delivery: registered the chapters preset (1 row(s) this host cannot resolve, dropped)`.
- **A disposer that must not be an effect.** `register()` hands back an unregister function; wiring it
  through `ctx.effect` un-registers the preset the instant our activation finishes — measured as
  `register()` reporting success while the roster came back *without* `chapters`. The same apply-fiber trap
  bit the storage domain in r35; it is held instead of called.
- **Health is the roster, asked after activation, and now it is loud.** `present` / `DECLARED BUT BROKEN` /
  `NOT in the host roster` (with the other ids) / `could not verify`, each in the warn channel, because a
  warn nobody could read is what made the original hours-long. The dev witness additionally reports the
  host's own `compositionInventory()` rows, which distinguish *declared* from *actually active*.
- **Verified on both mechanisms with real boots**, not by reasoning: on `0.2.0-rc.2` the witness reports
  `roster: present`, `inventoryRows: 28`, `unusableRows: []`; on `0.1.5-rc.1` it reports `registers:
  false`, `roster: present` with `.agent-presets/chapters/` restored by the copy.
- **The drift gate now RUNS here instead of skipping.** `tests/unit/preset-declaration.test.ts` is 13 rows
  over `src/preset.ts` (100% coverage): the composition's shape; the id as durable state; that
  `dsh.bundle.patch` is still a **string** (a pinned row against the boot-breaking array, because the next
  person will be tempted by the declarative route); every module resolving against the installed host;
  our list differing from the host's own standard list *only* by the four declared deltas; no
  `{{variable}}` the installed host does not register; the persona suffix still matching the plot-echo
  guard **by behaviour**; and every registration and roster arm classified.
- Also documented: the **workspace directory-picker modal crash** — a host packaging bug this plugin cannot
  fix, reproduced, named in the log (`slot entry crashed in 'sidebar.workspaces.directoryFlow'`, React
  error #130), with the two steps that unblock a user ([§4](/operations/install/)).

### 0.1.8 — 2026-10 · a plan's heading stops being allowed to be unbounded

Found by reading 0.1.7's own carriage for what a hostile input does to it: a plan whose `# heading` is a
4 KB paragraph was printed **in full** in every chapter that carries the plan *and* again in every child
notice built from that path — unbounded, and un-costed until the budget gate refused the continuation.

- `PLAN_TITLE_MAX` (120 chars, `src/plans.ts`): the **display** title is bounded; the artifact keeps the
  heading whole, which is the same distinction `planInlineChars` draws for the body. Closed ATX headings
  (`# Title #`) lose their trailing hashes in the title only, never in the bytes. Two unit rows pin both.
- Same class, one scale down: the outline line is now a bounded **index** — twelve headings at 60 chars
  each, with a trailing `+more (chapters_artifact 'toc' lists every heading)` when entries are dropped. An
  outline that silently stops listing would be the exact lie this store exists to avoid, so shortening is
  always announced, and the complete map is one query away. Four unit rows pin the cap, the note, and the
  no-note-when-under-cap case.
- The `plans` tape's PROVENANCE.md now records the two live re-record attempts that failed — the local
  model container reported *healthy* and dropped the stream mid-turn, once after 15 minutes with no tool
  call and no tape entries — so the next person checks with a real ~17K-header completion instead of
  `/v1/models`, which answers even when the server cannot finish a turn.
- Browser-plane ledger for the eight-project chain (`npm run coverage:e2e`): 79.92 / 64.64 / 76.28 —
  reported, not tuned; the ≥85 gate is the deterministic one.

### 0.1.16 — 2026-10 · a half-deleted preset can no longer fail silently forever

Reported from a real installation: after an accidental uninstall/reinstall of the harness, the
`chapters` preset had "disappeared", existing chapter sessions looked **corrupted**, and the settings panel
still said the plugin was enabled and running.

The cause was one line of over-trust. The preset ships as **two** files — `preset.yml`, and
`agent.cordis.yml`, the one that actually names the chapter engine realm row — but the never-clobber guard
checked for `preset.yml` **alone**. So a partially wiped home produced a preset directory that passed the
guard on every boot forever: nothing was ever repaired, sessions choosing the preset failed to *compose*
(their logs and archives were untouched — the break was in composition, which is exactly why it looked
like data corruption), and the plugin still logged that it had mounted. Three separate wrongs in one
mechanism: undetectable, unrepairable, and actively reporting health.

- **Completeness is now measured against the shipped file set**, not a single filename — so a preset gains
  a third file and stays covered.
- **The repair is additive.** Missing shipped files are restored; any file the user already has is left
  byte-for-byte alone, so a hand-tuned preset survives. Restoring a file that is absent is not clobbering
  a file that exists.
- **The result is returned, not just logged** (`installed / repaired / complete / failed / no-source`), the
  mount line carries it, and `failed` logs **UNHEALTHY** — because a plugin whose only compaction engine
  did not install is not healthy, and "enabled and running" cost someone hours of debugging.
- **The witness diagnostic got the same fix**, since it carried the identical one-file blindness: it now
  reports `presetComplete` and `presetMissing`.
- The installer is now **testable** — it used to resolve its own paths into the developer's real
  `~/.dsh`. Seven rows over temp directories cover the incident itself, user-edit preservation, nested
  preset files, a destination that cannot be created, and a source that would install a broken preset.

Immediate recovery for anyone in this state: stop the harness, `mv ~/.dsh/.agent-presets/chapters
~/.dsh/.agent-presets/chapters.bak`, start again — the fresh copy lands and, because nothing in the session
logs or the archive was rewritten, the sessions that name the preset compose again. Diff your tuning back
from the `.bak` if you had any. This release makes that recovery automatic for future partial wipes.

### 0.1.15 — 2026-10 · the documentation site can no longer name a version that does not exist

No behaviour changed in the plugin; what changed is that the **site can no longer tell you to install
something stale**, and it turned out to be doing exactly that.

- **A real bug, found while removing hand-typed versions**: the version the homepage displayed had a
  build-time fallback that resolved `package.json` from inside the bundler and landed on
  `site/package.json`. With the npm registry unreachable, the site printed **`dsh-chapters@0.0.1`** — a
  version that has never existed. The fallback is gone: `site/src/data/plugin-version.mjs` reads the repo
  manifest and validates it by package *name* before trusting it, and the build makes **no network
  request at all**, so it is hermetic and offline-safe (proven by rebuilding with every proxy pointed at a
  dead port).
- **Instructions now say `@latest`, everywhere a human is told what to run** — an instruction that cannot
  go stale beats one that needs editing after every release. The only place that *names* the current
  release is the homepage, interpolated from the manifest, which the release pipeline already pins
  (tag must equal `package.json` version).
- **A guard refuses regression**: `site/scripts/check-stale-versions.mjs` runs first in the site build and
  fails on a pinned install command or a "latest is X" claim outside the changelog. Negative-tested — a
  probe page produces exit 1, the real tree produces 0.
- Numbers with no dynamic need were **removed rather than pinned**: `bare (0.1.3)`, `(since 0.1.3)`,
  `464 tests`, `7 segments`. The changelog, field study, security and archive-anatomy pages keep their
  literal numbers on purpose — they are records of what was true on a date, not instructions.
- Pages were brought in line with what actually ships: **one deterministic door with two intents** (the
  fork and continue buttons are the same builder, archive-identical by test), all six commands, the
  findability door in `chapters_search` answering from the workspace store and naming which door answered,
  `kind: plan` documents searchable as plans, the `## Finding things` notice block, and the tool
  `chapters_fork` finally distinguished from the command `/chapters-fork`.
- Install documentation now states **the path that works** (npm inside the profile, then restart) and notes
  honestly that `dsh plugin add` has never been observed working in this environment — citing only the
  recorded pnpm-forwarder fact, with no diagnosis and no claimed fix, because nobody reproduced it.

### 0.1.14 — 2026-10 · a door the user cannot see is a door they will not trust

Caught in real use, not in a test: a user ran `/chapters-continue`, the plugin archived 17 chapters and
created the child — correctly, and registered in the workspace index — and they reported "I don't see a
new session." Nothing had failed. The fork button had always driven the UI to the child it created; the
continuation had **no button at all**, so its only feedback was a session id inside command text, and
the sidebar list was never refreshed. A deterministic door whose result is invisible is a door nobody
pulls twice.

- **New: a 'Continue with chapters' action in the assistant row**, beside the fork button, doing the same
  thing the fork button does for its own intent.
- The fix is a table plus **one** runner (`src/client/doors.ts`): `makeForker` generalised over
  command/noun/label, both rows registered from `DOOR_ACTIONS`, `src/client/index.ts` reduced to thin
  chrome. This codebase has been bitten repeatedly by two implementations drifting apart, so the test
  suite now refuses a second runner body outright — and the change is **net −75 lines** while adding a
  feature.
- The title regex was the only branch-specific piece (`BRANCH_TITLE`) and is now noun-derived; the
  child-id pattern already parses both doors' reply shapes, verified against the server templates rather
  than assumed, with a drift pin that reads `src/tools.ts` so client parsing cannot silently fall out of
  step with server wording.
- Honest limit, stated rather than papered: the browser journey proves **both buttons render and the
  fork one still clicks through**. Nothing yet *clicks* Continue — doing that inside the fork project
  would spawn a second child and break that spec's child-count assertion, so it needs its own boot and
  tape (the standing "one journey, one boot" lesson). It is recorded as an open row, not claimed.
- Also learned: `tsconfig.json` excludes `src/client/`, so `npm run typecheck` has never typechecked the
  client plane. A strict one-off `tsc` over `src/client/*.ts` was run for this change and is clean, but
  the gap is real and pre-existing.

Ledger: 616 rows, 5 failing and exactly those 5 are the TreeDX live rows (container down by request),
coverage gate satisfied (97.7 / 86.31 / 93.46 / 97.7); `plans`, `fork` and `suite` browser projects
replayed green.

### 0.1.13 — 2026-10 · the continuation gets a door a human can pull

Live attempt 5 settled it, with two findings that pointed at the same place:

- a **tape cannot carry a model-authored range** — the recorded `chapters_continue` said `endSeq: 30` and
  the runner's own ceiling was 29, so `validateRanges` refused it *correctly*; no pin fixes a number
  frozen in a recording;
- and a small local model **will not reliably chain two tool calls** — live, it called `chapters_segment`
  and then answered in prose. Asking it harder is not a fix.

The cure was already in the codebase. `/chapters-fork` derives everything itself — no model turn, no
proposed ranges — but it was hard-wired to `intent: 'branch'`, and a branch by design asserts **nothing**
about plans. So every property of the *continuation* shape could only be proven through the model's door,
which is exactly the door that cannot be tested repeatably.

- **New: `/chapters-continue [title]`** — the same deterministic door with the continuation intent.
  Archive semantics are identical by decision (everything since the watermark); what differs is that the
  child extends the same stream, so its notice carries `## Active plan` with the verdict, chapter, blob and
  `kind: plan` document — and if the session is still planning, the child is really *in* plan mode (seeded
  with its own `plan/mode` fact). Both doors come from **one builder**, and a test pins that the two doors
  **archive identically** (same ranges, titles and plan facts) so the factoring cannot drift into two
  implementations. The tool stays for the model's own use; it is simply no longer the only way to prove
  what a continuation carries.
- **The continuation leg is back in the acceptance chain**, replayed on every push with no GPU and no
  frozen numbers — asserted from the child's durable log, without the UI switching to it. The browser plane
  now covers **both intents**, which is where the fork-vs-continue decision actually lives.
- Fixed a latent trap found on the way: the command loop overwrote `disposeCommand`, which would have
  leaked the first registration and unregistered only the last; and a pre-existing comma operator in the
  disposer list (`disposeArtifact(), disposeRulePropose()`) — behaviour was right, the reading was a trap.
- Measured, not assumed: from attempt 5's own log, the turn containing a plan submission does **not** end
  until the review is answered (`turn/end` at 41, after the verdict at 21). So a session whose only turn is
  pending has no archive ceiling and `/chapters-continue` refuses with its first guard. The seeded case is
  reachable in a browser only once an earlier turn closed — which needs a second distilled session. It is
  pinned deterministically (seed `['user/message','plan/mode']`, the live-and-un-stored wording) and is
  **not yet observed in a browser**, stated as the remaining piece rather than claimed.

### 0.1.12 — 2026-10 · an index nobody can reach is not an index

The request was not "add search" but *"make sure a new session can find the plans, rules and other
important details when it's asked."* Auditing that sentence found the index itself was sound and the
**access path** was not, in two separate ways. Both are now closed, tested, and recorded as an amendment
to the knowledge record.

- **Search answers at home now.** With no pool linked, `chapters_search` returned `[]` plus "go link a
  remote" — while every chapter, every `kind: plan` document and every rule sat in the workspace store.
  It now reads that store through **the same scorer** the mirror uses (`rankEntries`), falls back to it
  when the pool has no match, **names the door it answered from** (so "this machine only" is never read
  as "the whole project"), and separates *nothing matched* from *nothing archived here* — two facts with
  two different next actions. Deferred blobs are deliberately **not** indexed: they answer to
  `chapters_artifact`, and a second index is what the design record forbids.
- **A child is told the verbs.** The notice taught `read` and nothing else, so `chapters_search` and
  `chapters_artifact` — installed, pointed at nothing — effectively did not exist for a small model. The
  notice gains a three-line `## Finding things`, including the one thing a session cannot infer: that
  plans are searchable **as plans** (`kind: plan`) and that rules arrive from other machines.
  `retrievalHints` (default on) is the switch; off, the notice is byte-identical to the previous shape.
- **A kernel-drift gate for the seeded continuation.** Seeding `plan/mode` depends on two host facts: the
  type is known, and it is not surface-eligible. Those are now read from the **kernel's own exported
  predicates** (`KNOWN_SESSION_EVENT_TYPES`, `isSurfaceEligibleType`, `isAppendSurfaceEvent`), not
  reimplemented — so a host upgrade that would leave a continuation silently *ungated* shows up as a red
  row naming the intent that moved.
- **Two pinned rows were amended, not deleted.** They asserted the old `no mirror ⇒ honest empty`
  contract and failed loudly — the only reason this entry can claim the flaw was found. The diff carries
  the reason, because a silently-passing expectation is how a feature ships broken and green. One of them
  also caught a genuine wording bug in the new answer: a project that *is* linked but not yet pulled was
  being told to link one.
- Measured, not assumed: no committed tape prefix contains a seeded notice (checked entry-by-entry across
  all eight projects), so the notice change costs no re-record and the chain replays green. That is
  coverage luck — no journey yet makes a *continuation child speak* — and it is recorded as an open row
  rather than quietly rounded up to a claim.

### 0.1.11 — 2026-10 · the plans journey cannot ask the model anything

0.1.10 pinned the threshold and still went red on hosted CI — with the new annotations making the cause
unambiguous: the miss was the **plot-elicitation** request again, i.e. the engine had decided to compact
mid-journey on the runner no matter what the threshold said. Tuning a threshold to beat a token count I
cannot observe is not a fix; **removing the machinery is**. The acceptance boot now takes a per-project
pin (`E2E_NO_AUX_MODEL=1`) that writes `auto: false` and `elicitedPlot: false` into the engine row of the
throwaway profile, so for this journey:

- pressure compaction is not registered at all — no threshold, and no runner's header size, can make it
  fire;
- the plot-elicitation call that produced the two missed requests **cannot be issued** — which is the
  difference between "unlikely on this machine" and "impossible on any machine";
- and the spec still asserts `compaction/*` is absent, so if someone re-enables the machinery under a
  journey that depends on its absence, the test says so locally, in words.

The pin is additive and per-project: every other journey keeps the 32K/15K stress regime and its
compaction behaviour, because for those the point *is* compaction. Verified: the plans project replays
green with the pin, the eight-project chain passes, and a boot with both rows patched starts cleanly (the
base config accepts them — an unknown key would fail the boot loudly, not silently).

### 0.1.10 — 2026-10 · a tape that only passes on the machine that made it stops being acceptable

0.1.9 shipped with a red hosted acceptance chain: `[plans]` missed a tape entry that replayed green on
every local run. The annotations finally said why — the miss was a **plot-elicitation** request, meaning
the runner had crossed `0.9 × the pinned 32K window` and compacted mid-journey while this machine never
did. Two truths follow, and both are now enforced:

- **The plans journey pins its own precondition.** Its threshold is `0.99`, so pressure compaction cannot
  interrupt it on any hardware; and the spec now *asserts* that nothing compacted
  (`compaction/*` events = 0, with the reason written where the assertion lives). If a future change makes
  pressure arrive mid-journey, the journey fails locally, in words — not as an unmatchable request on
  someone else's machine. The tape was re-distilled under the pin; the eight-project chain replays green.
- **The acceptance chain reports like the gate.** `scripts/ci-replay.sh` tees the run and, on failure,
  emits `::error::` annotations naming the failing project and tests, the tail of the proxy's tape-miss
  journal (the prefixes it compared), and the tail of `var/e2e-engine-errors.log` — the engine's own
  diagnostics, which every boot already writes. Before this, a red chain left a maintainer with
  "Process completed with exit code 1" and a 5 MB artifact behind a token; that cost three CI cycles on
  0.1.9 and it is not a cost worth repeating.

No plugin behaviour changed in this release; what changed is the guarantee that the acceptance plane
means the same thing everywhere it runs.

### 0.1.9 — 2026-10 · plans become directives the agent keeps, searches, and never overwrites

The four deferred questions about plan carriage came back answered, and the answer that
changed the design was a distinction: **a continuation extends the same stream of work, a fork
splits one off.** Everything below follows from taking that seriously.

- **Plan mode now survives a continuation.** A child created by `chapters_continue` from a session
  that was still planning is seeded with its own `plan/mode {active:true}` event, so it genuinely IS
  in plan mode — gated, not merely told. This was measured before it was built: the installed kernel
  accepts a two-event seed in the exact production header shape (`0:user/message → 1:plan/mode →
  2:session/end-seed`, log-only, surface unchanged), and the host's own plan projection folds it to
  `active: true` where the one-event control does not. It is deliberately NOT seeded for a branch,
  and NOT seeded after an approval — approving a plan exits plan mode, so that child's job is to
  implement, not to keep planning. `planSeedMode` (default on) is the switch.
- **The notice reads the intent.** A continuation gets `## Active plan` — the operative directive, its
  verdict, its chapter, its artifact and its document — plus `## Previous plans on this path`, explicitly
  marked as history rather than orders. A branch gets **zero bytes**: its plans are already in the chapters
  the table of contents cites.
- **A plan is now a document of a third kind.** Each submission is written as `kind: plan` beside its
  chapter (`plan-NNN-<slug>.md`), carrying its status, the chapter that cites it, and the blob sha of the
  same bytes. It sits in `chapters/` on purpose: the pool transport, the mirror rehydrate and the corpus
  index pick it up unchanged, so `chapters_search` answers *"what did we plan about X"* with the plan
  itself rather than the transcript that happens to quote it. Its numbering has its own registry counter,
  so a plan can never consume a chapter number or reorder the TOC, and superseding never overwrites: the
  v1 document stays, with its history intact.
- **Directives are never paraphrased.** The enrichment ladder skips `kind: plan` documents — the guard
  reads the file's own frontmatter, so renaming cannot disarm it. A summary of an order is the drift this
  store exists to prevent.
- **The operative plan is carried into every compaction checkpoint**, the way the plot is, bounded and
  with the truncation announced — because shadowing can hide the chapter that holds it, and a directive
  that survives only in a file the agent may never open is a directive it drifts from. Session-wide,
  newest-first: "what am I building" is not a property of the region being condensed.
- **One named exception to the injection screen.** The harness's own *"The user switched this session to
  plan mode."* is archived verbatim — it is a fact about this session, not another project's private
  instruction file. Matched by plugin AND form, so it cannot widen by accident; instruction files, runtime
  snapshots and skill catalogs still screen, and the strict predicate that drives topic signatures and the
  `(N msgs)` counts is untouched on purpose.
- **The browser journey now has two legs**, because a distinction that is only described is not tested:
  one session plans, approves, then (1) *continues* via `chapters_segment` → `chapters_continue` — that
  child's single seeded message carries `## Active plan`, the plan's document path, and deliberately **no
  seeded gate**, since approving a plan exits plan mode and gating that child would block the work it was
  told to do; then (2) *branches* via the fork button — that child carries **no** directive section at all
  while still citing the archive. The scripted upstream reads the ceiling from the real tool's own result
  rather than from a hard-coded number, so the ranges are the tool's.
- Ledger: **582 deterministic rows, zero skips**, 98.05 / 86.44 / 93.67 against the ≥85 gate; verify.md
  rows P12–P17; the knowledge record carries the corpus amendment (`Amendment 2026-10-10 — plans are
  documents of a third kind`), and the design record its §§ 9–13.
- And one lesson worth its own line, because it is the reason the acceptance layer exists: distilling the
  journey caught a bug in **our own test reader** — session logs are JSONL, so a payload's quotes arrive
  escaped and a regex over the raw line silently never matches. An assertion that cannot match is worse
  than one that fails: it looks like a pass. The spec now parses the event before asserting on it.

### 0.1.7 — 2026-10 · the plans journey joins the acceptance chain, and the browser corrects three beliefs

0.1.6 shipped session-plan carriage with the browser plane written but never executed. It executes now, as
**the eighth project in the tape-replay chain** (`tests/e2e/plans.spec.ts`, project `plans`, ~13 s in
replay): `/plan <message>` → a real `exit_plan_mode` tool call → the host's plan-review card opened and
answered by a real click → fork → the child's single seeded event calling the plan out, with the plan's
full bytes on disk. The eight-project chain passes end to end (`CHAIN_EXIT=0`, 9 tests) on committed tapes,
no LLM present.

**Provenance, stated plainly:** the box's local model server dropped the stream mid-journey
(`turn/end` `code:"TRANSPORT"`), so this tape was distilled through `tests/e2e/stub-model.ts` — a scripted
OpenAI-compatible upstream whose SSE shape is copied form-for-form from recorded llama.cpp traffic. What
that proves is everything on our side of the seam in a real browser against the real review channel; what
it does NOT prove is a model choosing to plan. `tests/fixtures/model-tape/plans/PROVENANCE.md` says so in
the directory itself (the recorded `model` field names the request's route, so it cannot carry
provenance) and carries the command that retires the stub.

**What running it corrected** — the reason the layer exists, and every one of these was a belief the
deterministic plane had encoded:

- approving a plan **exits** plan mode, so a chapter's folded `planMode:` after an approval is `inactive`,
  not `active`; both flips print and the fold takes the last logged value. The archived chapter was right,
  my assertion wrong.
- the toolbar chip is an **exit-only** control (`plan.pending ? !plan.active : plan.active`); the entry door
  is the `/plan` command. Worth a 40-minute timeout to learn.
- the review question is a **region's accessible name**, not matchable element text — `text=…` hangs,
  `getByRole('region', …)` finds it.
- a seeded event read back out of the zstd log is **JSON-escaped**: parse the event and assert on its
  text, never on the raw line.
- a scripted upstream that string-matches its own message array **lies confidently** — `exit_plan_mode`
  and `approved` both appear in the system prompt, so the first version never opened a review. The honest
  signal is the transcript's shape (a `role:'tool'` message exists only once a tool has run); the stub's
  turn policy now has its own rows (`tests/unit/stub-model.test.ts`), because a wrong stub records a tape
  of a session that never planned.
- acceptance assertions are scoped to **the session tree the run created** — scanning the whole store lets
  a previous run satisfy the next one.

Also in this ship: the plan blob's publication leg is pinned (a chapter's plan must be planned for the
pool, not just written locally), the site's anatomy page states the mode-fold truth instead of guessing it,
and a red deterministic gate now annotates its own diagnosis (`scripts/ci-gate.sh`, since the 0.1.6 run
that failed with nothing readable left behind). Deterministic ledger: **557 rows, zero skips**, coverage
98.11 / 86.44 / 93.8 against the ≥85 gate.

### 0.1.6 — 2026-10 · session plans survive the continuation

A plan submitted through DSH's plan mode lived in the archive as the first 400 characters of a tool-call
line, and a created child cannot inherit plan mode — so the continuation of a planned session either
implemented something nobody approved or re-planned from recall. Now the plan is a first-class citizen of
the archive (design record: `docs/plans-carriage.md` in the repo).

- **Every plan's full text is artifact-backed, always.** A chapter carries a `## Plans in this chapter`
  block AFTER the verbatim transcript — verdict, outline, bounded head (`planInlineChars`, default 900),
  and the content-addressed path — and the bytes are queryable with `chapters_artifact` `toc | search |
  read`, the same recursive drill-down that serves oversized results. The chapter's frontmatter declares
  `plans: [seq:status:sha8]` and the folded `planMode:`; the registry record carries the structured facts.
- **Six statuses, read the way the host writes them.** `approved` (`{approved:true}`), `rejected` (the
  "keep planning" feedback survives), `dismissed` (the user took the wheel), `pending` (no verdict event —
  printed as never-approved, and the notice tells the child not to implement it), `superseded` (same H1,
  later submission), `failed` (the review never opened — not a human verdict, so not labelled as one).
  Redelivered results keep the LAST copy. `plan/mode` events stopped being silently-unrendered holes.
- **The child's notice calls the operative plan out** under `## Plans on this path`, cited to its chapter
  and its artifact, with superseded drafts listed chronologically underneath. A plan whose review is still
  open sits in an unfinished turn — above the archive ceiling, in no chapter, in no artifact — and is
  carried marked `NOT ARCHIVED — parent log seq N` rather than dropped.
- **A plan is a chapter boundary.** Both segmenters close the chapter that carries a submission at the
  next turn boundary, and the plan's own H1 titles it. `chapters_segment` returns `plans`, `livePlans` and
  `modeActive` so the model places ranges on facts instead of guessing what the review said.
- **Nothing is exempted from the meter.** The block is counted by the same `preflight` as the rest of the
  notice, and over-budget still refuses with numbers. The economy is carriage, not blindness.
- **Tape-neutral by construction:** every piece above renders ZERO bytes for a path with no plans —
  verified, not assumed: the seven-segment replay chain passed unchanged (no re-record), and no fixture
  contains an `exit_plan_mode` turn. New knob `callArgArtifactTokens` therefore ships OFF (0) because
  turning it on *would* change chapter bytes for sessions with large `write` arguments.
- **Fixed on the way, and it was never about plans:** a chapter's `artifacts/aa/<sha>.txt` citation could
  not be resolved by `chapters_artifact` when the blob sat in the ancestry tree (where `writeArchive`
  writes) rather than at the store root (where arrival stubs write) — so every deferred result since 0.1.0
  pointed at a path its own reader could not open. The resolver now searches store root → session trees →
  pool mirror, and the refusal text names all three.
- **Ship note, kept honest:** the `0.1.6` tag published (Release job green — it runs the same
  deterministic gate) and Pages deployed, while the parallel `CI` job on that commit went red at
  `coverage:ci` with no surviving diagnosis: stdout only, the summary step skipped on failure, the one
  artifact behind a token. Every local reproduction of the pushed SHA — a fresh `git clone` + `npm ci`,
  TreeDX env removed so the live rows skip exactly as they do on the runner — came back
  544 pass / 5 skip / exit 0, and the very next commit `50453c9` is green on both hosted jobs. So the
  0.1.6 red run was a flake we could not name, and the pipeline got fixed for that instead:
  `scripts/ci-gate.sh` annotates metrics, tallies and failing tests, and the summary now always runs.
- Tests: 80 new rows across `plans`, `render-plans`, `continue-plans`, `plans-segmentation`,
  `plans-tools`, `plans-engine`, `log-shape` (unit) and `plans-carriage` (integration, real fs + real
  registry + the `chapters_artifact` retrieval loop), verify.md rows P1–P11. The browser journey is
  written (`tests/e2e/plans.spec.ts`, project `plans-dev`) and self-skips without a live model — it awaits
  its tape on the GPU box.

### 0.1.5 — 2026-10 · the store heals: sync rehydrates deleted chapters from the pool

A user deleting the workspace's `.dsh-chapters/` (a natural instinct when testing a re-link) exposed a real hole: the registry and continuation TOCs keep citing store paths, the pool keeps every byte, but nothing flowed back — 56 of 57 chapter references dangling silently, and `read` on an archived chapter would simply miss. Worse, migrating to a *new* pool sources from the store, so relinking after such a wipe published nothing while looking idle.

- **`runSync` rehydrates before it publishes**: the freshly cloned mirror's `chapters/<projectKey>/…` and `artifacts/<projectKey>/…` are copied back into any *absent* store paths (present files are never overwritten — the store stays ground truth; other projects' prefixes are out of scope; idempotent).
- **The recovery is loud**: `rehydrated N file(s) from the pool into the store` lands in `/chapters-status` steps.
- Tests: direct rehydrate semantics (fill / no-overwrite / key-scope / idempotence) + a runSync-after-store-wipe integration proving the steps line and byte return.

### 0.1.4 — 2026-10 · the shared-pool audit fixes: artifacts travel, results dedupe

Found by a real 12-session run against a linked git pool (parent + 10 sub-agents at two depths, plus a search probe): the pool was **publishing zero artifact blobs**. The cause was a layout disagreement — the arrival stubber writes content-addressed blobs to the store **root** (`artifacts/aa/<sha>.txt`), while the publisher scanned a per-session path that never existed. Every pool chapter's `⟦see artifacts/…⟧` reference dangled on other machines.

- **Publisher** now walks the store-root artifacts directory into `artifacts/<projectKey>/…` (legacy per-session layouts still plan; rel collisions dedupe — one blob, one entry).
- **`chapters_artifact` reads the pool**: a local store miss falls back to the linked workspace's mirror, so a teammate's deferred 40K-line log is retrievable with the same toc/search/read windows. Misses name both roots searched and point at `/chapters-status` — the loud-not-silent contract, extended to the cross-machine leg.
- **Renderer dedupes host redeliveries**: the host can emit two `tool/result` events for one callId (measured: 25 in that run — read ×17, web_fetch ×2, chapters_artifact ×3); chapters now archive keep-last, so verbatim bodies never bloat with the same text twice.
- Same run's good news, for the record: **26/26 checkpoints carried genuine plots** (0.1.3's elicitation budget in production), the dead-link → relink degrade/rebuild path worked end to end, and cross-session search returned ranked hits minutes after the first publish.

### 0.1.3 — 2026-09 · plot elicitation goes loud and gets a real budget

- `extractPlot` fixed after the first real-world multi-agent run exposed **8 of 9 checkpoints inheriting the persona instruction's own quoted `'PLOT:'` text** as the "plot" (the substring scan scraped the prompt; non-null garbage then *suppressed* the bounded elicited fallback — the mechanism designed for exactly that case). Contract-shaped now: marker must start a line, system-role messages never yield a plot, template echoes rejected.
- Elicit budget 220 → **600** tokens (reasoning tokens compete with content; reproduced live at 155/220 for a *short* excerpt), and every refusal path — no-route, malformed reply, throw — now logs **why** to the `DSH_CHAPTERS_ENGINE_ERRORS` diagnostics sink. Loud-not-silent, in the last silent spot.
- Regression tests pin the verbatim corrupted frames from the wild, not paraphrases of them.

### 0.1.1 / 0.1.2 — 2026-09 · the first real runs' harvest

- `@treeseed/dsh-chapters` joins its npm org scope; plugin identity, bundle patch, and preset engine row move with it (measured: the host resolves by package name; the client bundle self-registers a build-time id — both now scoped).
- **Push of an unborn mirror is an honest no-op**, not `local-only` (a pristine-store link to an empty remote reported blame-worthy transport for having nothing to send).
- Elicit excerpt screens host-injections — machine-independent plot requests.
- Release pipeline switched to OIDC trusted publishing (no deploy tokens) with provenance on every version.

### 0.1.0 — 2026-09 · first release

The full platform: zero-token deterministic compaction, citation continuations with cumulative TOCs, arrival-time artifacting, the knowledge pool (git + TreeDX transports), enrichment ladder, per-machine rules ledger, the fork button, and an acceptance suite that replays browser journeys from committed model tapes with zero LLM calls in CI. 450→464 deterministic tests, the ≥85% all-axes coverage gate held from day one (today: 97.98% statements / 85.61% branch / 93.62% functions). (Shipped manually before trusted publishing was wired — the one version without a provenance attestation.)

> **On naming.** The package was `dsh-chapter-fork` once — and "fork" in DSH means *copy the parent's history*, the one operation this plugin must never perform. It now names the artifact instead; the reasoning, including the candidates that lost, is in the repo's architecture record.
