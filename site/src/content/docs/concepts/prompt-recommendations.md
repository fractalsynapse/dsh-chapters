---
title: "28. Prompt recommendations"
description: A second model reads the context and defines the work — a Suggested Next Step bar above the composer that analyses the session after every turn and offers the prompt, with Run, Autorun, and Off.
lastUpdated: true
---

Every feature so far answers *what did we do*. This one answers *what should we do next*.
One model reads the context and **does** the work; a second model reads the context and
**defines** it: after each completed turn it proposes the next prompt, in a bar docked
directly above the chat input.

It is **off by default** and there is exactly one knob: a model. Setting one —
`/chapters-prompt model <provider/model>` or the `promptModel` config — makes the bar appear
and keeps it there; clearing it (`model clear`, or `off`) removes the bar and stops every
call. No second boolean to drift against the first.

## What you see

A bar in the composer's dock stack — the same strip family that holds your todo list, an
active goal, and queued requests — sitting under them all, immediately above the input. It
has an icon, a status label, the suggested prompt, and three actions:

- **`Analyzing situation…`** while the second model is working, then **`Recommended Next
  Step`** with the prompt in one line. The label is the state; you are never guessing whether
  it is thinking or stuck.
- **Click the prompt to expand it.** The row opens in place and shows the complete prompt.
- **Click it again while expanded to put it in the input box for editing.** This is the part
  the host does not yet support: a dock can *reach* the composer verbs — `insertText`, `setDraft`,
  `submit` are all present and callable — but the write path dies on a missing revision object
  (`Cannot read properties of undefined (reading 'draftRev')`, composer text still empty), and **the bar says so on its face**
  instead of leaving you with a button that did nothing. Reading and committing stay two
  gestures, and the second one becomes available the day the host fixes or exposes a path a dock can call:
  measured on **both** `0.2.0-rc.2` and `0.2.1-rc.4`, with the `rc.4` draft machinery rebuilt in ways that looked like
  the fix (`mirrorFn` gone, a `cancelCommandRestore()` added, the method's own comment now claiming "programmatic
  writes") — and the refusal is byte-identical on both, because `draftRev` is not read in that module at all
  ([#126](https://github.com/treeseed-ai/dsh-chapters/issues/126)).
- **Run** submits the offer as your own turn, through the same follow-up path autorun uses —
  one code path for "run it", whether you clicked it or the loop armed it.
- **Autorun / Autorun off** is the loop: after each completed turn the bar generates the next
  step and runs it, until you stop it, until you send a prompt yourself, or until the goal
  finishes.
- **Off** turns suggestions off for this session. The configured model is kept, so turning it
  back on is one action.
- **Nothing shows when there is nothing to recommend.** "Not yet" is not an error, and an
  error is never a blank — a failure stays labelled, with its reason.

The prompt names the model that wrote it. That matters: the whole point is a *different*
model defining the work, and you should know which mind suggested it.

## What the bar's states mean

| state | what you see | what it means |
|---|---|---|
| *(nothing)* | no row at all | switched off: no model configured, or you pressed **Off** |
| `idle` | "No suggestion yet — I will recommend one after your next turn" | enabled, and there is no completed turn to read yet |
| `analyzing` | "Analyzing the session…" | a generation is running for the current turn |
| `ready` | **Recommended Next Step** + the prompt | an offer is on screen, yours to run or ignore |
| `failed` | the reason, in red | the call did not work — the bar keeps the last offer rather than pretending |

`idle` exists because an earlier build collapsed "enabled but nothing to say yet" into `off`, and the bar
rendered nothing while the feature was in fact working. A disabled feature and a waiting one must not look
alike.

## Why a docked bar and not a ghost over the placeholder

The first version of this feature was a ghost layer inside the composer's overlay slot. It
was removed, for reasons worth stating: it re-fired inside a single turn, it reported "nothing
to offer" as an error on a fresh session, and its overlay sat on top of the host's placeholder
text — where it read as a sticker and could not be styled out of the way.

The dock fixes the geometry rather than restyling it. A docked row reserves its own space, so
it **cannot** cover the placeholder or collide with the send buttons; and the placeholder is
not plugin-writable anyway ([measured](https://github.com/treeseed-ai/dsh-chapters/blob/main/docs/contract.md)):
the host computes it from its own states and locale dictionaries, and no config key, slot, or
projection feeds a plugin value into that chain. The bar next to the input is the honest
surface; the text inside the input was never ours.

## How it composes with a goal

A goal is autorun with a fixed directive: the same objective, re-injected every turn, until
the model decides it is done. This bar is autorun with a **fresh directive every turn** — it
re-reads the session and specifies the next step rather than repeating one. Same shape,
different purpose, and they are built to run together:

- if a goal is active, its objective and revision are stated to the model **before** the
  conversation slice, with the instruction that the recommended step must *advance* it — and
  that if the objective is already met, the right recommendation is to close the goal out
  rather than take another round;
- arming the loop takes the next turn away from the goal's own auto-continuation: the goal stays the objective, its
  driver pauses (the bar reads `Autorun off`, the goal control reads `Resume goal`), and autorun **disarms itself when
  the goal completes**, because the loop existed to serve that purpose;
- a prompt you send yourself disarms autorun immediately. Generation keeps going on later
  turn boundaries — suspending the loop is not disabling the feature — and re-arming is
  always your action.

That is the working pair this feature is for: a **director** that keeps defining the next
move, and a **worker** that executes it, potentially on different models.

### Who is allowed to start the next turn

This is the part that has to be exact, because the host splits the authority and the feature has to live
inside that split rather than around it:

- **A goal that is active *and* armed owns the boundary.** The goal driver queues its own round when the
  session goes idle, so if this loop also followed up, two turns would start at once and race the driver's
  own reservation. When that is the case the bar **yields**: it keeps generating offers — the director's eye
  stays open — and runs none of them. Autorun resumes the moment the goal is paused, blocked, completed,
  disarmed, or absent.
- **A step that re-cuts the goal is never auto-run.** The host reserves goal edits for a turn that contains a
  direct human message. An autorun message is authored by the plugin, so it could not perform the edit even
  if it ran — and faking a human message to make it work would hand an automated loop authority the host
  deliberately withholds. Instead the recommending model prefixes such a step with `GOAL:`, the bar labels it
  *edits the goal · run it yourself*, and **Run** stays enabled: your keystroke is exactly what makes it
  legitimate. The prefix is stripped before the text reaches anyone, so the worker never sees scaffolding.
- **A goal edit invalidates the offer made against the old revision.** Revisions bump by one per accepted
  change, so an outstanding offer written against the previous objective is dropped rather than pushed into
  the objective you just re-cut.

So the pair divides cleanly: the **goal** is what you own and re-cut, the **suggestion** is what the director
re-derives every turn. Autorun drives the worker; your keystroke drives the objective.

## What the model reads

The director cannot research — no tools, no session, one bounded call — so the input IS its whole
world, and an ignorant director leads a stupid worker. The assembly (deterministic: same facts ⇒
same bytes) carries, in order:

- **the goal directive** when a goal is active — objective **whole**, because nothing the model
  reads is ever truncated,
- **the active plan**, if one governs the session,
- **the core rules** in force — the same block a rebuilt head renders from,
- **the chapter history**: every chapter on the **ancestor path** (a continuation mid-goal inherits
  its lineage's history, not an empty list), each as **title + detailed summary + every plot line**
  its span carries. Plots are the historical trajectory, extracted deterministically from the
  archived bytes (`PLOT:` lines — zero model tokens), and the summaries are detailed because
  enrichment writes them for exactly this reader (#188),
- **the last turn**, whole: the human's request through the final response,
- nothing else. Host-injected context is defused before assembly; command results, notices, and
  your private instruction files are not silently fed to a second model.

**Zero truncation is an invariant.** A sliced message is a hallucination invite, so the budget
(`promptContextChars`) is enforced purely by a **drop ladder with announcements**: over budget, the
OLDEST chapter drops first, and onward until the history fits — recent trajectory leads. The
protected set (skeleton, goal, plan, rules, last turn) is never sliced; if it alone exceeds the
budget the suggestion **refuses with the numbers** and the bar shows the reason. A refused
suggestion costs one turn; a truncated one poisons the next.

The model is also told the `GOAL:` protocol above, so it can mark a step that changes the objective.
The answer must be a single imperative prompt of at most `promptMaxChars` characters. An
oversized or empty answer is retried **once** with the cap restated, then **refused** — this
project does not truncate to fit.

## The cost, honestly

This is the **one place the plugin spends model tokens at human cadence**. Everything else in
dsh-chapters is zero-inference (rendered from the log, indexed without a model). Here:

- **one recommendation per completed turn per session** — one auxiliary completion, or two
  when the first fails validation and gets its single restated retry. Turn-keyed, not
  step-keyed: a long turn with many tool calls still costs one call;
- concurrent pulls for the same session share one in-flight request, and a cached suggestion
  is reused while its turn watermark is current, so revisiting a session costs nothing until a
  new turn completes;
- the completion runs under the existing `enrichmentMaxTokens` budget (one auxiliary budget,
  now three consumers: annotation, mined rules, recommendations);
- **autorun multiplies the turns, not the calls**: each round is a real turn, so it costs what
  you would have spent running that prompt yourself, plus the one call that proposed it.
  `promptMaxRounds` bounds how many rounds one arming may start **when no goal is active**, and
  re-arming does **not** refresh the budget — arming cannot become an infinite loop. With a goal,
  the budget stands down: the pursuit is bounded by the goal's own lifecycle (complete, blocked,
  cleared) and never cut off by the suggestion budget (#188). A blocked goal disarms autorun on
  both planes, exactly like a completed one.

## Where it never goes

- **Never into the system prompt.** The header is process-global; a suggestion is per-session,
  per-turn, and append-only.
- **Never as you.** A prompt you Run yourself is your message. A prompt the *loop* starts is
  authored under the plugin's own producer kind, so it is captured as conversation — you can
  read what drove each response — while never counting as human input for anything that gates
  on a human turn.
- **Never across a restart armed.** Like the goal loop, autorun is process-local: it starts
  disarmed, and a restart cannot resurrect it. An unattended loop is impossible by
  construction, not by promise.
- **Never eager.** Headless and subagent sessions have no composer, so they neither show the
  bar nor pay for it.

## Commands and config

Syntax is at [§15 Commands](/reference/commands/), keys at
[§17 Configuration](/reference/configuration/). The short form:

| Key | Default | Meaning |
|---|---|---|
| `promptModel` | `''` | the defining model; **empty ⇒ the feature does not exist**. Setting it is the enable |
| `promptContextChars` | derived | budget for the assembled input. **Model-derived by default**: `contextWindow × promptContextRatio` at 4 chars/token when the prompt model's window resolves; this key is the fallback when no window is known, and `/chapters-prompt model <id> [maxChars] [contextChars]` stores an explicit pair beside the model |
| `promptContextRatio` | 0.5 | share of the model's context window the derived budget takes — a 1M-window model and a 32K model get budgets 30× apart from one rule |
| `promptMaxChars` | 4096 | cap on the accepted answer (was 240 — a cap that cannot carry a paragraph cannot carry an instruction); over-cap ⇒ retry once ⇒ refuse with numbers |
| `promptMaxRounds` | 24 | how many turns one arming of autorun may start **with no active goal**; re-arming does not refresh it. An active goal bounds the loop by its own lifecycle instead (#188) |

To look at the state rather than the bar: `/chapters-prompt state` prints the status, the
model and where it came from, the autorun flag and rounds spent, the turn the offer belongs
to, and the prompt itself. `/chapters-status` carries the same line, in every state including
unlinked.

## Transport (for future maintainers)

The client **pulls**, on purpose and within known limits. A plugin can own a reactive
observable inside its own slot registration — that is how the goal bar gets its
`armed/disarmed` — so the bar is *push-shaped*: state arrives as a hook the component
selects. But a plugin **cannot publish a projection**, and the only plugin-reachable call
path is `remote.commands.execute`, so that observable is *fed* by a pull of the `state` verb.
One output serves both the human typing `state` and the component parsing it, and a row feeds
the printed block back through the parser so a reworded line that would break the client goes
red instead.

**A pull is not free where the human can see it** (#193, measured in the host's command
service): every execution appends a `command/run` + `command/done` lifecycle pair to the
session log — never model-visible, but the UI renders each pair as a history node, and
`recordInput: false` hides only the args text, not the node. An unconditional 10-second
keep-poll therefore wrote ~360 visible nodes per hour into every bar-enabled session — the
litter is the transport, not a rendering bug. So the cadence is a pure, tested decision
(`pollSpacingFor`): **10s while state can plausibly change** (generation `analyzing`, autorun
`armed`, host-published `running`), **60s while quiet**, and **zero pulls in a hidden tab**
while quiet — never while armed, because walking away from a running loop is the point of
autorun. The host's idle edge, when published, triggers an immediate pull so a new offer is
seen the moment the turn that produced it ends.

A real push retires the problem instead of pacing it: the plugin appends its recommendation as
a durable plugin record and a registered projection delivers it — zero command runs in steady
state. Measured gate: `appendPluginRecord` is **absent from host 0.2.0-rc.2 and present in
0.2.1-rc.2** (`git show dsh-v0.2.0-rc.2:packages/core/session/src/index.ts | grep -c
appendPluginRecord` → 0), so the swap needs a host-pin bump plus feature detection with pull
fallback — tracked as #194.

## What proves it, in which class

The pixels (dock order 30, Analyzing → suggestion, expand, Run submitting a human-authored turn,
Off hiding the bar) are asserted by the tape-backed `prompt` and `prompt-off` legs — and the
suggestion text in that corpus was written by a REAL model: the 2026-10-30 re-record ran the leg
against the live provider with the browser asserting, and the committed tape entry decodes to the
real completion. The goal/suggestion interplay runs live-only (`prompt-goal-live`, real provider,
wall-clock bound) because an armed goal has no tape-able rest state. `/chapters-models` — the
discovery surface for the setting this page's feature rides — is proven live by
`model-activities-live` (#175): an identifier the command prints is passed to a setter and echoed
back as the stored override. The live legs are absent from the model-free acceptance job by
design; every claim on this page names the class that covers it.
