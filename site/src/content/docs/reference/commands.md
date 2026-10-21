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
/chapters-rule approve <id> | revoke <id>                  # YOUR machine's curation fact — never a shared rewrite
```

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

## Plus the host's `/compact`

With the `chapters` agent preset mounted, `/compact` runs through the plugin's deterministic engine: checkpoint summary with carried plot, zero inference tokens, append-only shadowing. (The harness's own command surface, ours underneath.)

Next: [16. Agent tools](/reference/tools/).
