---
title: "15. Commands"
description: The full composer surface, exact syntax, and what each answer means.
lastUpdated: true
---
## The command reply row (#590)

Every `/chapters-*` command you type gets its reply **on screen, every time** — including in a
session that was restarted and resumed, where the host's timeline deliberately does not re-render
command events (the #545 cause, closed on the host's `SURFACE_EVENT_TYPES`). A single compact row
mounts in the input dock, closest to the composer: the command line, the reply's first ~200
characters, and the outcome color. Click it for the full text; dismiss it with **X**; the next
command replaces it. The row reads the session's **raw durable journal** through the host's own
`session.follow` API — the same bytes the timeline filters out — so it costs zero model calls,
zero polling (the follow stream pushes live), and it suppresses itself when the host has already
rendered the reply as a timeline card. If you ever see a command "do nothing" again: it didn't.


## Reload self-check (#319)

Every continuation child checks its own event stream against the host's fold rule at its FIRST
completed turn — the same rule that, on host 0.2.0-rc.2, refuses seeded children at cold load (the
#314 deadlock: the engine records its header as a mid-surface `system/message`; the validator
admits that event only as the protected first head). If the check predicts a future refusal, it
announces itself **the moment it becomes true, while the session is alive**: a stderr warning naming
the exact seq, a `hostReload: refused` fact on the registry row, and a line in `/chapters-status`.
The action it tells you is the plugin's own — `chapters_continue` (or restore, once shipped) —
before any restart. Nobody should ever again discover a refused session by restarting into it.



Run in the composer **inside a session** (draft screens send text as a message — [FAQ](/start/faq/)). The operator commands are registered in `src/commands.ts` on the host plane — including `/chapters-repair` and `/chapters-restore`, which must stay reachable from any session to fix a broken chapters archive. The three continuation doors (`/chapters-fork`, `/chapters-continue`, `/chapters-save`) mount with the tools **inside the chapters preset realm** (0.2.32, [#330](https://github.com/fractalsynapse/dsh-chapters/issues/330)) — sessions on other presets do not carry them.

## Command planes: what resolves where (#372)

The commands do NOT all live on the same plane — and since 0.2.39 the UI says so as plainly as the
server does:

| Plane | Commands | Where they resolve |
| --- | --- | --- |
| **host plane** (registered for every session) | `/chapters-status`, `/chapters-link`, `/chapters-anchor`, `/chapters-models`, `/chapters-enrich`, `/chapters-prompt`, `/chapters-rule`, `/chapters-remove`, `/chapters-repair`, `/chapters-restore` | any session, any preset — repair/restore MUST stay reachable from everywhere: they are how you fix a broken chapters archive from a session that cannot run the doors |
| **chapters preset realm** (mounted with the tools) | `/chapters-fork`, `/chapters-continue`, `/chapters-save` and the two conversation buttons *Fork with chapters* / *Continue with chapters* | only sessions composing the `chapters` preset (0.2.32, #330 — a realm-scoped command asked for from another preset resolves to nothing) |

The dock now reads the composed preset from the host's own per-session projection
(`projectionValues.agentPreset` on the session row — the same fact the host's preset label renders)
and does **not render the two realm-scoped buttons in a session whose preset resolves to something
else**. When the projection is not readable the buttons stay visible — presence of an unknown preset
is UNKNOWN, not absence — and a click then answers with a refusal that names the preset requirement
instead of a generic "the branch call failed". No inference, no hardcode: either the host says the
preset or the door says it is needed.

## `/chapters-link` — the knowledge upstream

| Form | Effect |
|---|---|
| `/chapters-link` | show current upstream + mirror status |
| `/chapters-link <local-path>` | bind a shared local git repo (bare or worktree; `file:///`, `~`, and relative paths all resolve) — a bare pool repo is created on demand, no credentials needed |
| `/chapters-link <https-url> <token>` | bind a smart-HTTP pool; the token is required **unless the host is loopback** (`127.0.0.1` / `localhost` / `::1`), and is stored **0600 under the DSH home**, never in the project |
| `/chapters-link treedx+<url>/<repo> <token>` | bind a TreeDX service (token always required — bearer API); the managed repository is created server-side if absent |

The no-args answer is a git-status-like block: `Provider`, `Upstream`, `Bound` (slug · project key · since),
**`Identity`** (§7.8 fail-loud, pool-aware since #546: which source derived the project key here —
`remote` / `config override` / `PATH`; a pool linked as its OWN repository reports `pool-keyed … rides
this bound key` — by design, never an alarm; the loud ⚠ is reserved for real drift, the SAME remote
canonicalizing to two different keys), the diagnostics line, `Mirror` (branch/head, plus an
origin-drift note when it will rebuild), `Sync` (last run + detail), `Pending` (files not yet mirrored, plus
the no-credentials nudge), `Harness` (this machine's id). Relinking to a different target — or a push that
finds the mirror diverged — rebuilds the mirror from the store (the store is the truth).

## `/chapters-status`

The project's whole health surface, one command — printed in **every** state, unlinked included (#61: an
absent block used to hide the health lines behind a one-sentence refusal). In order:

```
Version: <x.y.z> · loaded from <path>       # #260: the copy THIS process booted — the honest answer to "did my update take?" (other homes/servers not visible from here, each with its own restart and its own /chapters-status)
Project / Remote / Provider                 # when linked; Identity line names the project KEY SOURCE and warns LOUDLY when this checkout resolves a different key than the bound one (§7.8)
Sync / Last sync                            # pending-debounced or last mode, with the step trail (cloned → published N → pushed)
Enrichment: <status line>                   # model, pending count, and since #529 whether a backlog chase is running
Prompt suggestions / plane block            # #225: the model, transport, door sightings, and THIS session's last persisted verdict — "why did hundreds of pulls not offer?" is answerable, not archaeology
retrieval: N search · N artifact · N rules  # #531: is the agent actually consulting the archive? per-session and per-process live counts (pool-vs-local line when linked)
diagnostics line                            # where failures self-report, with the warning counts
Auto-save line                              # the #47 behavior's live state
Findings (registry-level) + "NOT checked here"   # what a status CANNOT verify without the durable log is named, not silently counted clean — coverage holes, orphans, dead citations belong to /chapters-repair audit
Removals + missing-access ledger            # #255: removed stubs are a STATE, printed even when nothing is linked
This session: N events, N turns, N chapters # a long session that has archived nothing is told so, in words, with the remedy (/chapters-save)
```

Pending counts, vocabulary notes and failure details are all printed — no silence, and no block omitted
because it was empty: an unwired surface is STATED, not omitted.

## `/chapters-models`

```
/chapters-models                        # every registered provider + its advertised models, as paste-ready ids
/chapters-models <provider>             # one provider's advertised models
/chapters-models <provider> <model>     # one exact route: context window, reasoning efforts
```

The discovery surface for the three model settings — `enrichment.model`, `rules.model`, and the prompt
model — because a setter you cannot feed correct identifiers is a setter you cannot use. Every model
line is the exact `provider/model` string those setters accept, and the output ends with what each of
the three is **currently** set to (and the command that changes it). The exact-route form resolves
through the host's `llm` service and adds what only resolution knows: the context window and the
selectable reasoning efforts, when the adapter advertises them.

Two honesty rules this command never drops: catalog membership is **advisory** (the host routes
unlisted ids too — an empty catalog means "no selection offered", not "no models work"), and a
provider or capability the host does not expose is reported as absent, never guessed. Like every
`/chapters-*` command it renders as a command flow node — zero model-context cost (#173).

## `/chapters-enrich`

```
/chapters-enrich run                          # drain ALL pending in capped passes (maintainer decision #565 — batches of `enrichmentBatchCap` chain until empty; a failing pass stops the drain; a second run while draining says so)
/chapters-enrich run <n>                       # or drain at most n chapters (user-specified limit)
/chapters-enrich model [<provider/model> | clear]  # show the annotator route, override it, or reset it to the conversation route
/chapters-enrich report                       # enrichment status line + pending chapter count
```

The drain runs in the BACKGROUND — the command returns the pending it started with, and `report` follows the count down. The safety shape is inherited from #529 unchanged: per-pass caps (memory discipline), failure stops the pump, one drain at a time (single-flight), dispose ends it. The archive-moment chases stay
as they were. Since
#529 every archive moment (continue, fork, save, compaction finalize, subagent settlement,
forced child archive, operator repair) drains the WHOLE pending backlog in capped passes: a
full `enrichmentBatchCap` pass schedules its own follow-up 5 s later until a pass comes back
short, a failing pass stops the chase, and the idle sweeper is now only the fallback.

## `/chapters-rule`

```
/chapters-rule add <category> "<text>"                     # write-once proposal; binds nothing yet
/chapters-rule list [--all|--proposed|--category <c>]      # review surface
/chapters-rule view <id>                                   # ONE rule, completely — full text, status, basis
/chapters-rule approve <id> | revoke <id>                  # YOUR machine's curation fact — never a shared rewrite
/chapters-rule model [<provider/model> | clear]       # #506: dedicated mining model at runtime; bare `model` shows it; clear ⇒ rides the enrichment call. Effective value in /chapters-models
```

`list` shows titles, and a title is the first sentence of the body cut at 60 characters — enough to
find a rule, never enough to judge one. `view` is the reading surface: the FULL untruncated text plus
everything known about the rule on this machine (status, pin, and for session rules whether they are
active, held for review, and whether their basis is `stated` — your own words — or `inferred` by the
model). Approving a rule you have not read is approving nothing; `view` is what makes `approve` a
judgment instead of a guess (#174, at the maintainer's direction).

The session tier and the audit surface, so automatic capture is never opaque
([#50](https://github.com/fractalsynapse/dsh-chapters/issues/50)):

```
/chapters-rule list --scope project|session               # which tier a rule belongs to
/chapters-rule active                                     # exactly what a rebuilt head will show, + withheld counts + the mining posture
/chapters-rule approve <id>                               # the one action that turns a held mined rule on
/chapters-rule pin <id> | unpin <id>                       # the always-rendered class (human-set only)
/chapters-rule model [<provider/model> | clear]            # a dedicated model for mining; costs one call per chapter
/chapters-rule conflicts                                  # report contradictory pairs — never edits a rule
/chapters-reply last                                # the last recorded command reply — the dock row's channel (#590); human commands are recorded, the bar's own state pulls are not
/chapters-rule reprocess [n]                        # HUMAN REPAIR ONLY (#578): re-run RULE MINING across every
                                      # existing transcript chapter through the resolved mining route — annotations
                                      # untouched, dedupe honored, lease/backoff/single-flight shared with enrichment.
                                      # The end heartbeat names processed/written/deduped/skipped.
```

`ADD RULE: <text>` at the start of a line in your own message is the deterministic capture path —
zero model tokens, active for your session tree, exactly the words you wrote. It is deliberately
**not** a command: nothing to remember, no review step before it takes effect. Everything the model
mines instead is labelled `stated` or `inferred` in the head, so the two paths are never confused.
See [Rules & governance](/knowledge/rules/).

## The deterministic door: `/chapters-fork [messageSeq] [title]` and `/chapters-continue [messageSeq] [title]`

**One door, two intents — not two mechanisms.** Both commands come from the same builder
(`deterministicCommand`, `src/tools.ts`), and a test pins that given the same events they archive
**identically**: same ranges, same titles, same plan facts. Both buttons on the assistant row execute these
same commands through the host's command wire, from one shared client runner (`src/client/doors.ts` — a
table of two rows, deliberately not two implementations).

What the door does, either way: everything after the last archive watermark up to the last completed turn is
archived verbatim, ranges derived by the plugin itself — **zero model involvement** — and a titled child
opens whose entire inherited history is the cumulative TOC. If nothing new was said since the last archive,
both degrade to a pure citation child: created, citing the existing chapters unchanged, nothing written.

A **bare integer first argument anchors the door** (#221): `/chapters-continue 412 pick up the parser`
archives up to the last completed turn at or before seq 412 and titles the child after the rest. Clicking
*Continue* on an earlier assistant row sends exactly that number; typing one works too. Parsing is strict —
a non-numeric first token stays the title — and an out-of-range anchor **refuses with the numbers** rather
than silently archiving more or less. No argument keeps the end-of-session behavior.

The **only** difference is what the child is told about plans:

| intent | command | button | what the child's notice carries |
|---|---|---|---|
| branch | `/chapters-fork` | *Fork with chapters* | **zero plan bytes** — this child splits a new direction; its plans stay reachable as history, in the cited chapters and as searchable `kind: plan` documents |
| continue | `/chapters-continue` | *Continue with chapters* | `## Active plan` + `## Previous plans on this path` (marked history) with the verdict, chapter, blob and plan-document paths; and if the session was **still planning**, the child is genuinely *in* plan mode because it is seeded with its own `plan/mode` fact. A plan already approved is not seeded — approving exits plan mode, and that child's job is to implement |

Why commands and buttons, when the `chapters_continue` tool exists: a tool call must be authored by the
model, which means (a) it has to chain `chapters_segment` → `chapters_continue` with correct ranges, and (b)
any recorded test of it **freezes those machine-specific numbers**. The door removes both dependencies —
which is how the continuation became testable in a browser at all, and why a click works on a small local
model that may not chain two tool calls.

Continue with chapters also got its button late: the fork button had always driven the UI to the child it
created, while the continuation's only feedback was a session id inside command text — a created child the
user could not see read as a broken door. Both rows now switch you to the child (with a sidebar fallback and
an inline note if the switch cannot be made).

One visible side effect, stated plainly because users notice it: the plugin hides the host's native
*Branch into a new conversation* action in that same message row (`src/client/index.ts`), the two chapter
doors replacing it. It is a cosmetic rule matched on the button's accessible label, so if a future host
rewords that label the native button simply reappears — fails open, visibly, never silently.

## `/chapters-save` — archive without creating a child session

```
/chapters-save                  # archive completed turns into searchable chapters
```

The command takes **no arguments** — chapter titles come from the deterministic derivation
([plan → first human line → goal objective](/concepts/archive-anatomy/), #530), not from a typed
string, and the span is always the watermark tail. (The hint used to advertise `[messageSeq]
[title]`; the handler never parsed either — #540 caught the ghost, and #541 tracks implementing
a real anchored save if the maintainer wants the affordance.)

Archives everything after the last archive watermark up to the last completed turn into
verbatim chapters on disk, updates the search index, and triggers enrichment — **without**
creating a child session or triggering compaction. The parent session remains fully functional.

This is the side-effect-only half of the deterministic door: same archive pipeline as
`/chapters-fork` and `/chapters-continue` (`composeChapters` + `writeArchive`, zero model
involvement), but stops before `agents.create`. Useful for sharing session context with
parallel sessions via `chapters_search` without disrupting the active conversation.

Idempotent: re-running saves only what has not yet been archived (respects the watermark).
If nothing new was said since the last save, reports "nothing to save" without error.

## `/chapters-restore <sessionId> [dry-run|apply]` — continue past a host-refused session (#319)

When the host cannot cold-load a session at all (the #314 shape: its log folds a
`system/message` its own validator refuses), this door does what the host can no longer do:
it reads the session's **durable log directly** (the same multi-frame decode the repair
CLI proved on the maintainer's real bytes), runs the repair engine over it so every
completed span is archived and cited, and creates a fresh continuation whose TOC carries
the target's full ancestry. The poisoned original is untouched — Invariant 1 holds; the
target's registry row is repaired through the SAME `runRepair` core as `/chapters-repair`
(journalled, reversible), and the new child is created through the same sanctioned
`createChild` seam every continuation uses (until part 2's empty-seed birth ships, the new
child is born in the CURRENT shape — and the reload self-check flags it honestly, exactly
as it flags every other child). Dry-run is the default: it reports what would be re-derived
and which session would be created; `apply` is the only word that writes. Ambiguous or
unknown ids are refused with the candidate list — never guessed.

## `/chapters-repair` — re-derive the archive from the durable log

The durable session log is append-only and complete (invariant 1), which is the only reason any of the
defects in issues #58/#59 are recoverable at all. `/chapters-repair` audits the three things that can
disagree — **the log**, **the store's files**, and **the registry's records** — and repairs what the
current code can now produce correctly.

```
/chapters-repair status                     # last journal, findings count by class
/chapters-repair audit [--json]             # read-only; reports every finding and its remedy
/chapters-repair dry-run [class]            # the exact mutations a run would make, with numbers
/chapters-repair apply hollow|gaps|citations|bookkeeping|all
/chapters-repair journal [<id>]             # list applied journals / print one
/chapters-repair restore <journal-id>       # undo a whole applied run, newest action first
```

What it fixes, by class:

| class | what it was | remedy |
|---|---|---|
| `hollow-payload` | a chapter that rendered nothing (`**unknown**` / `0 B`), from a payload-less read (#58) | re-render the span from the log under a NEW number; supersede the old record |
| `unsiged-completed-turn` | a completed turn inside no chapter, from a lost signature (#59) | archive the gap span through the normal save core |
| `never-archived-subagent` | a settled child that tripped no archive moment | archive it from its durable log, with subagent lineage |
| `dead-citation` | a checkpoint that cites a chapter file never written (#59) | **materialize the file at the cited path and reserved number** — the lie becomes true, no text is edited |
| `ghost-plan-manifest` / `unreleased-reservation` | a manifest with no body; a retry key that can never land | expire/release, keeping every spent number spent |
| `orphan-file` / `duplicate-number` / `countervalue-drift` | files no record cites; a number spent twice; a counter behind its own max | classify, supersede, raise the counter **upward only** |
| `test-litter` | chapters written into a real store by the acceptance rig | quarantine, never delete |

### The repair contract (why it never edits a chapter)

Damage is superseded, never repaired in place, and a body-hash guard is the only sanctioned mutation of
a chapter file — the one deletion class is operator removal of bad data, [`/chapters-remove`](#chapters-remove--delete-a-bad-chapter-for-real),
and repair itself never deletes. So repair **supersedes**: it writes a new chapter number carrying
`repairs: <n>`, marks the old registry record `status: 'superseded'`, and **copies** the corrupt file into
`<tree>/.repair-quarantine/`. Nothing is deleted, nothing is rewritten, and every applied run is journalled
to `<tree>/repairs/<utc-stamp>.json` — one record per move, with hashes, so `restore` can walk it backwards.
Derived layers (TOC, index shards, vocabulary, plan status, counters) are re-derivable and repair may
rewrite **those**; verbatim bytes are read-only input.

Refusals, deliberately: it will not merge, split or renumber existing chapters; will not touch a session
log or a checkpoint's text; will not re-cite a file it cannot verify byte-for-byte; and will not run
against a workspace whose registry row it cannot serialize through the #59 write discipline.

## `/chapters-remove` — delete a bad chapter for real

The mistake this door exists for: a prompt meant for another project, typed into this project's session.
The contaminated turns archive, and from that boundary on every TOC, every search, and every enrichment
result carries the wrong project's context. `/chapters-repair` *supersedes* damage and keeps the bytes;
**removal** is for bytes that should not exist at all — another project's content, junk, a secret. The
rule it ships with: *bad bytes leave the memory; the durable log is what lets you admit you were wrong.*

```
/chapters-remove list                       # the session's active TOC with removable ids
/chapters-remove find <query>               # search this project's pool; names ids
/chapters-remove <id ...>                   # dry-run: the exact deletion set, nothing written
/chapters-remove apply <id ...>             # delete for real — journal first
/chapters-remove report                     # missing-access log: who still cites removed chapters
/chapters-remove restore <journal-id>       # re-derive the removed chapter from the durable log
```

What `apply` deletes, and what it deliberately keeps:

| layer | removed chapter's fate |
|---|---|
| chapter file | **deleted** from the store **and** from the pool mirror — the deletion is committed and pushed, so index shards regenerate without it |
| artifacts & plan documents | **deleted when orphaned** — a content-addressed blob survives if any *active* chapter still names it |
| registry record | a **stub** stays: number, seq span, path, hash, artifact manifest, `status: 'removed'` — the archive watermark reads it, so no auto-archive moment can re-capture the poisoned span |
| derived surfaces | TOC notices, index shards, `chapters_search`, enrichment: gone from the next build onward, through the one `isActiveChapter` predicate |
| the durable session log | **never touched.** Removal is a store operation; the log stays append-only and complete |
| already-seeded child TOCs | still name the chapter (recorded text is never rewritten) — the dangling-reference report names them, and later misses land in `removals/missing-access.log` |
| git history of the pool | unchanged — the deletion is a new commit, not a rewrite |

Identifiers: the canonical id is the registry path printed by `list`; `find` results, `<sessionId>:<number>`,
and a bare TOC ordinal from `list` all resolve through the same door. An unknown id refuses and names near
candidates; an ambiguous one refuses rather than guessing; an id pointing outside **this project's** store
refuses — removal is same-project only, from the contaminated session or any other session of the project.

Reversal is re-derivation, not resurrection: `restore <journal-id>` re-renders the journaled span from the
session's durable log through the same save core every door uses, under a **new** number — so a removed
number stays spent forever, and a restore that would render nothing refuses rather than writing a husk.
Safety order is the #60 discipline: the journal under `<tree>/removals/` is written **before** the first
unlink; if it cannot be written, nothing is deleted.

Cross-machine removal is tombstoned (#256). `apply` on the removing machine appends one
**removal fact** per deleted chapter to the pool's already-synced, append-only per-session
collections file (`collections/<projectKey>/<sessionId>.jsonl`, the channel §15's design record
named for exactly this):

```json
{"type":"chapter-removed","tail":"<session>/chapters/<file>.md","span":[startSeq,endSeq],"by":"<harnessId>","at":"<iso>"}
```

Every machine consumes the facts on its next sync pass, in two places. Publishing skips any store
chapter whose tail a fact claims — a second machine that never removed anything re-publishes
nothing after pulling the deletion, and its `chapters_search` stops returning the chapter with that
pull, because the pool copy is what search reads. Rehydration skips those tails too, even on a
machine whose local registry has no stub for them. Facts are parse-tolerant: a malformed line is
skipped, and it never blocks a pass.

The local registry is deliberately NOT rewritten by someone else's judgment: on a machine that did
not perform the removal, the row keeps its prior status (active rows read as missing at TOC build,
and `report` names them). That is the conservative half of the decision in #256 — a remote
operator's delete stops the bytes travelling, but the local operator decides what their own
registry says. Dry-run is the default: `list` and `find` write nothing, and the `apply` word is the
only thing that deletes.

## Auto-save when a subagent settles

No command. With `subagentAutoSave` on (the default), every subagent run that carries the
`chapters` preset is archived the moment it ends: the plugin subscribes to the host's
`subagent/end` lifecycle event, reads the child's completed turns, and runs the **same**
save pipeline as `/chapters-save` — `composeChapters` + `writeArchive`, zero model
involvement — with enrichment **queued** rather than run (a ten-child fanout must not
hammer the annotator). A continuable child that is woken again archives again: the
watermark makes the repeat save only its new turns.

The child's chapters live under **its own** session tree, exactly like every other session —
searchable and pool-published on its own. Its frontmatter says where it came from:
`subagent: true` plus `parentSession: <id>`, read from the child's own durable session header
(the host stamps `parentSession`, `origin: subagent`, `delegationDepth`, and `agentPreset`
at creation — measured, `spikes/subagent-end/FINDINGS.md`). Nothing links a subagent into its
spawner's ancestry; parent and children share a workspace, not a TOC.

Honest limits, stated because silence here would be the kind of unstated loss this project
refuses: only **completed turns** are archived (the anchor is the child's last `turn/end`, so
an interrupted tail is skipped, never half-saved); a child on a different preset is left
alone; and if a child's log can be read neither live nor from disk at settlement, the archive
is skipped with a loud diagnostic rather than guessed at.

## Auto-archive when a continuation child lags behind

A `chapters_continue` child is not a subagent, so the settlement door above does not cover it. As of
issue #61 a `turn/end` listener archives it through the same save core when its session is a
`chapters`-preset session with lineage — read from the registry row, the header, or the `ch-` id our own
continue door mints — and either it has never archived at all, or `childAutoArchiveMinTurns` completed
turns have piled up past its watermark. It creates no session and compacts nothing, so nothing happens
mid-step; a session that never trips a moment is unretrievable, and the field case was 2,363 events with
zero chapters. Close it with `childAutoArchive: false`.

## `/chapters-prompt` — the recommending model ([§28](/concepts/prompt-recommendations/))

```
/chapters-prompt                             # usage — the verb list above
/chapters-prompt model                       # show the effective model and its source (override or config)
/chapters-prompt model <provider/model>      # set it — setting a model is what ENABLES the feature
/chapters-prompt model <provider/model> [maxChars [contextChars]]  # #188: pin the caps beside the model (positive integers; omitted numbers derive from the model's window)
/chapters-prompt model clear                 # drop the override; falls back to `promptModel` ('' ⇒ off)
/chapters-prompt on                          # per-session re-enable after the bar's ✕ (needs a model set; the model is the plane switch, this is the session one)
/chapters-prompt off                         # disable for the WHOLE PLANE — clears the model for every session (#291 says so in its reply)
/chapters-prompt off-session                 # the bar's ✕ verb: suggestions OFF for THIS session only, model kept (#291)
/chapters-prompt state                       # the k:v heartbeat the client bar renders: status, model+source, autorun flag and rounds fired, turn, intent, goal revision, heartbeat, LIVE rounds cap
/chapters-prompt run                         # the bar's Run button verb: submits THIS session's current offer as your turn (refuses a delivered/consumed one, #289)
/chapters-prompt suggest                     # machine verb: the composer bar pulls this; ≤ one bounded call per turn boundary; writes the offer to the bar
/chapters-prompt autorun on|off              # the loop: run each turn's offer automatically (arm/disarm are accepted aliases); `on` refuses with no model and says why
/chapters-prompt rounds [n | unlimited | show | clear]  # #505: the autorun round cap, live — the default is UNLIMITED; a goal-active run was never capped (#188); `clear` drops the override back to config
```

All ten verbs ride the same settings spine as the model override: stored, plane-wide, survives
restarts, and printed live by `state` with its source — never the file's stale number. The brakes
against a runaway loop are structural and named: one round per offer, a **typed human prompt**
disarms instantly (the loop's own `[auto]`-fired prompts do not — #532 fixed that self-disarm),
`off` stops the door, and a goal-bound run answers to the goal's lifecycle (#188).

`suggest` is the client's door: it answers `{kind:'success', text:<one prompt>}` when a
recommendation is current or computable, and refuses with the remedy (`off`, no route, model
failure, over-cap answer) when it is not. A refusal latches the ghost hidden for the turn
boundary — the disabled state shows nothing, ever. `/chapters-status` prints the feature's
state beside enrichment and rules. A unit row (#540) pins every verb above against the handler
that parses it — an option may not ship unadvertised in the typing hint.

## Plus the host's `/compact`

With the `chapters` agent preset mounted, `/compact` runs through the plugin's deterministic engine: checkpoint summary with carried plot, zero inference tokens, append-only shadowing. (The harness's own command surface, ours underneath.)

Next: [16. Agent tools](/reference/tools/).
