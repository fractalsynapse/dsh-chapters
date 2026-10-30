---
title: "15. Commands"
description: The full composer surface, exact syntax, and what each answer means.
lastUpdated: true
---

Run in the composer **inside a session** (draft screens send text as a message — [FAQ](/start/faq/)). Registered in `src/commands.ts`; the two deterministic archive doors (`/chapters-fork`, `/chapters-continue`) in `src/tools.ts`.

## `/chapters-link` — the knowledge upstream

| Form | Effect |
|---|---|
| `/chapters-link` | show current upstream + mirror status |
| `/chapters-link <local-path>` | bind a shared local git repo (bare or worktree; `file:///`, `~`, and relative paths all resolve) — a bare pool repo is created on demand, no credentials needed |
| `/chapters-link <https-url> <token>` | bind a smart-HTTP pool; the token is required **unless the host is loopback** (`127.0.0.1` / `localhost` / `::1`), and is stored **0600 under the DSH home**, never in the project |
| `/chapters-link treedx+<url>/<repo> <token>` | bind a TreeDX service (token always required — bearer API); the managed repository is created server-side if absent |

The no-args answer is a git-status-like block: `Provider`, `Upstream`, `Bound` (slug · project key · since), `Mirror` (branch/head, plus an origin-drift note when it will rebuild), `Sync` (last run + detail), `Pending` (files not yet mirrored), `Harness` (this machine's id). Relinking to a different target — or a push that finds the mirror diverged — rebuilds the mirror from the store (the store is the truth).

## `/chapters-status`

Per linked project: `Project` / `Remote` / `Provider` lines, then `Sync: a push is pending (debounced)` or the last sync mode; then `Last sync: <time> — synced` (or `local-only: <reason>`) with the step trail behind it — `cloned → published N new file(s), M already mirrored → pushed` — and the enrichment status line. With no project and no history it says so in one line and points at `/chapters-link`. Pending counts, vocabulary curation notes, and failure details are all printed — no silence.

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
/chapters-enrich run                          # process one batch now (up to `enrichmentBatchCap` chapters)
/chapters-enrich model                        # show the current annotator route
/chapters-enrich model <provider/model|clear> # override it, or reset to the conversation route
/chapters-enrich report                       # enrichment status line + pending chapter count
```

## `/chapters-rule`

```
/chapters-rule add <category> "<text>"                     # write-once proposal; binds nothing yet
/chapters-rule list [--all|--proposed|--category <c>]      # review surface
/chapters-rule view <id>                                   # ONE rule, completely — full text, status, basis
/chapters-rule approve <id> | revoke <id>                  # YOUR machine's curation fact — never a shared rewrite
```

`list` shows titles, and a title is the first sentence of the body cut at 60 characters — enough to
find a rule, never enough to judge one. `view` is the reading surface: the FULL untruncated text plus
everything known about the rule on this machine (status, pin, and for session rules whether they are
active, held for review, and whether their basis is `stated` — your own words — or `inferred` by the
model). Approving a rule you have not read is approving nothing; `view` is what makes `approve` a
judgment instead of a guess (#174, at the maintainer's direction).

The session tier and the audit surface, so automatic capture is never opaque
([#50](https://github.com/treeseed-ai/dsh-chapters/issues/50)):

```
/chapters-rule list --scope project|session               # which tier a rule belongs to
/chapters-rule active                                     # exactly what a rebuilt head will show, + withheld counts + the mining posture
/chapters-rule approve <id>                               # the one action that turns a held mined rule on
/chapters-rule pin <id> | unpin <id>                       # the always-rendered class (human-set only)
/chapters-rule model [<provider/model> | clear]            # a dedicated model for mining; costs one call per chapter
/chapters-rule conflicts                                  # report contradictory pairs — never edits a rule
```

`ADD RULE: <text>` at the start of a line in your own message is the deterministic capture path —
zero model tokens, active for your session tree, exactly the words you wrote. It is deliberately
**not** a command: nothing to remember, no review step before it takes effect. Everything the model
mines instead is labelled `stated` or `inferred` in the head, so the two paths are never confused.
See [Rules & governance](/knowledge/rules/).

## The deterministic door: `/chapters-fork [title]` and `/chapters-continue [title]`

**One door, two intents — not two mechanisms.** Both commands come from the same builder
(`deterministicCommand`, `src/tools.ts`), and a test pins that given the same events they archive
**identically**: same ranges, same titles, same plan facts. Both buttons on the assistant row execute these
same commands through the host's command wire, from one shared client runner (`src/client/doors.ts` — a
table of two rows, deliberately not two implementations).

What the door does, either way: everything after the last archive watermark up to the last completed turn is
archived verbatim, ranges derived by the plugin itself — **zero model involvement** — and a titled child
opens whose entire inherited history is the cumulative TOC. If nothing new was said since the last archive,
both degrade to a pure citation child: created, citing the existing chapters unchanged, nothing written.

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
/chapters-save              # archive completed turns into searchable chapters
/chapters-save [title]      # optional title prefix for the saved chapters
```

Archives everything after the last archive watermark up to the last completed turn into
verbatim chapters on disk, updates the search index, and triggers enrichment — **without**
creating a child session or triggering compaction. The parent session remains fully functional.

This is the side-effect-only half of the deterministic door: same archive pipeline as
`/chapters-fork` and `/chapters-continue` (`composeChapters` + `writeArchive`, zero model
involvement), but stops before `agents.create`. Useful for sharing session context with
parallel sessions via `chapters_search` without disrupting the active conversation.

Idempotent: re-running saves only what has not yet been archived (respects the watermark).
If nothing new was said since the last save, reports "nothing to save" without error.

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

Append-only has no exceptions, and a body-hash guard is the only sanctioned mutation of a chapter file.
So repair **supersedes**: it writes a new chapter number carrying `repairs: <n>`, marks the old registry
record `status: 'superseded'`, and **copies** the corrupt file into `<tree>/.repair-quarantine/`. Nothing
is deleted, nothing is rewritten, and every applied run is journalled to
`<tree>/repairs/<utc-stamp>.json` — one record per move, with hashes, so `restore` can walk it backwards.
Derived layers (TOC, index shards, vocabulary, plan status, counters) are re-derivable and repair may
rewrite **those**; verbatim bytes are read-only input.

Refusals, deliberately: it will not merge, split or renumber existing chapters; will not touch a session
log or a checkpoint's text; will not re-cite a file it cannot verify byte-for-byte; and will not run
against a workspace whose registry row it cannot serialize through the #59 write discipline.

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
/chapters-prompt                             # usage + the current state (ON with model / OFF)
/chapters-prompt model                       # show the effective model and its source (override or config)
/chapters-prompt model <provider/model>      # set it — setting a model is what ENABLES the feature
/chapters-prompt model clear                 # drop the override; falls back to `promptModel` ('' ⇒ off)
/chapters-prompt off                         # disable regardless of config (stores the empty override)
/chapters-prompt suggest                     # machine verb: the composer ghost pulls this; ≤ one bounded call per turn boundary
```

`suggest` is the client's door: it answers `{kind:'success', text:<one prompt>}` when a
recommendation is current or computable, and refuses with the remedy (`off`, no route, model
failure, over-cap answer) when it is not. A refusal latches the ghost hidden for the turn
boundary — the disabled state shows nothing, ever. `/chapters-status` prints the feature's
state beside enrichment and rules.

## Plus the host's `/compact`

With the `chapters` agent preset mounted, `/compact` runs through the plugin's deterministic engine: checkpoint summary with carried plot, zero inference tokens, append-only shadowing. (The harness's own command surface, ours underneath.)

Next: [16. Agent tools](/reference/tools/).
