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
- **The suggestion is a prompt for the model, pasted by you — never an instruction to you.**
  It must be a message the worker model in the session receives and can act on with its own
  tools: telling it to run tests, edit files, execute commands, investigate — all right. A
  sentence only the human could perform (typing a slash command, opening a UI, clicking this
  bar) or one that is about the suggestion system itself is a contract violation, and the
  generation rules name the failure explicitly (#273).
- **And it must be FORWARD.** The offer names a step the session has **not begun** — never a
  restatement of work already in flight. A live sample proposed "Create the #273 echo-adjacency
  issue and run the pre-change sampler" while the issue was already filed and the sampler was
  running: a mirror, not a director. Mid-task, the suggestion is what comes *after* the task
  lands — its verification, its follow-up — or a different line of work the state plainly
  calls for (#279).
- **Click the prompt to expand it** — the row tooltip says so while collapsed. The expanded
  pane shows the complete prompt; the **collapse control (▾ — it folds the pane back down,
  #309) lives in the bar's own action row** (top-right, never over the text — an early build
  floated it inside the pane and the two click targets fought, #295), and folding keeps the
  offer — only a human prompt or **Off** dismisses it (#282).
- **Click it while expanded to send it to the chat input for editing — and the bar folds back**
  to its normal size in the same gesture (#295) — **but only when the chat input is empty.**
  If you are mid-sentence, the bar will not append to or overwrite your text; the tooltip
  changes to say what it would take (*clear the existing prompt first*), and clicking states
  that on the bar instead of acting (#309). Tooltips ride the host's own themed tooltip seat,
  so they look like everything else in the app.
  This handoff is **live-verified in use**: the maintainer's
  2026-11-03 report ("you got the click to chat input working… I love that") supersedes the
  `draftRev` refusal measured in #126/#162 on earlier builds; where the host still refuses a
  dock's write, the bar says so on its face rather than leaving a button that did nothing.
- **While the agent is running, the bar shows that, not a stale offer.** When a turn starts —
  whether from **Run**, autorun, or your own prompt — the bar clears the previous suggestion,
  collapses, and carries a generic running line; the offer comes back through the normal
  post-turn flow (the suggestion generated for the turn that just ended). Acting on a stale
  offer is how a bar lies, and a running agent makes every on-screen offer obsolete (#282).
- **Run** submits the offer as your own turn, through the same follow-up path autorun uses —
  one code path for "run it", whether you clicked it or the loop armed it. **A successful run
  consumes its offer:** the server retires the row's suggestion the moment it submits it, so no
  pull, no second tab, and no repeated click can ever re-run a step that already ran (#285 —
  the self-proving test: click Run twice; the second click has nothing left to run).
- **And a delivered offer is never served again (#289).** An offer whose exact words later
  arrived as one of your own turns has run, whatever path sent it — including rows consumed
  by a version that predates run-consumption. The state read renders it resting, and a Run
  attempt refuses and retires it on the spot. Comparison is byte-exact against the durable
  log (reminder spans stripped, host narration and goal rounds excluded) — never a guess,
  never a model call: the same read-the-log discipline as the archive.
- **Autorun / Autorun off** is the loop: after each completed turn the bar generates the next
  step and runs it, until you stop it, until you send a prompt yourself, or until the goal
  finishes.
- **The bar's ✕ turns suggestions off for THIS session only** (#291). The configured model is
  kept; turning it back on is one action (`/chapters-prompt on`, or set a model again).
- **The command `/chapters-prompt off` is plane-wide** — it clears the model for every session —
  and its reply now says so in those words. It used to be what the bar's ✕ ran: a
  session-scoped label executing a plane-scoped kill, which is how one exploratory click
  silenced every suggestion on the machine while the door kept faithfully reporting `off`
  (#291, found by the maintainer's live test).
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
| `running` (display overlay, not a wire state) | "Agent is running — a fresh suggestion lands when the turn ends" | a turn is in flight (from Run, autorun, or your own prompt): the previous offer is cleared and the bar collapsed, because acting on a stale offer is how a bar lies (#282) |

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
not plugin-writable anyway ([measured](https://github.com/fractalsynapse/dsh-chapters/blob/main/docs/contract.md)):
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
  deliberately withholds. Instead the recommending model prefixes such a step with `GOAL:` — only when an
  ACTIVE goal actually governs the session (#300: with no active goal the prefix is never legal, not even
  for "close out this release cycle"-flavored wording) — and the bar carries the fact in its one message
  slot: the row's label reads **`Goal edit — run it yourself`** in place of `Recommended Next Step`, and
  **Run** stays enabled: your keystroke is exactly what makes it legitimate. (The badge used to be a SECOND
  message beside the label; it overflowed the row and clipped the composer — the dock has room for one
  sentence, and this one earns the slot.) The prefix is stripped before the text reaches anyone, so the
  worker never sees scaffolding.
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
litter is the transport, not a rendering bug. So the schedule is a pure, tested decision,
and it follows the maintainer's rule: **generate or read after the turn ends — never when you
activate a session** (#203). The bar keeps a module-level per-session cache; mounting renders
from it with **zero invocations**, and a mount pulls only when the cache cannot be trusted:
absent (first mount after a page load), older than the quiet interval (a turn could have ended
since — this one guarded pull is what keeps Run honest, because clicking a stale offer would
submit the row's newer text), `analyzing`, or `armed`.

**Not relevant, not visible** (#208): `off` is **terminal for the page lifetime**. A session
that answered `off` never pulls again — no staleness guard, no edge pulls — and when any reply
reports the plane-wide `model: unset`, every dock on the page stops pulling entirely: an
unset-model plane pays **one discovery run per page load in total**, and zero afterward. The
pull transport cannot do better than that one discovery (a client cannot know relevance without
asking); the push transport (#194) removes even it. Revival is honest and stated where the human
acts: `/chapters-prompt model <spec>` and `/chapters-prompt on` say that a hidden bar reappears
at the next page reload — a client that learned `off` keeps no clock, by design.

Beyond mounts: the host's **idle edge** (a turn ending is the moment an offer is born) pulls —
but **debounced and rate-floored** (#211, measured the hard way on the maintainer's host: some
hosts publish `running` at STEP granularity — it flickers at every tool call and every thinking
block — and an edge-per-flicker was a rendered command node per tool call, all of it waste,
because the server row changes ONLY at turn boundaries). So a falling edge schedules its pull
2s out and a rising edge cancels it: step flickers coalesce to zero pulls, a real turn end pulls
once. A rate floor (15s since the last pull) bounds even a host that holds `running` low through
long tool calls. The bar's **own actions** remain their own invocations; and where the host
publishes the running signal, the quiet **clock disappears entirely** for a stable, disarmed bar —
every state change flows through an edge or an action, so a timer could only re-read truth. Hosts
that publish no running prop keep the paced fallback (**10s** while analyzing/armed/running,
**60s** while quiet, **zero pulls in a hidden tab** while quiet — never while armed, because
walking away from a running loop is the point of autorun). An armed bar keeps the flat 10s belt
 on every host: a missed edge must not stall a loop. An **analyzing** bar backs the belt off
 **10 → 20 → 40 → 60s** (#304): short generations never notice (the first wait is eager), while a
 long one costs three pulls instead of nine — and a claim whose generation died with its server is
 **released at boot** (the reservation rule: released, not burned), because the one cadence that
 deserves no back-off at all is a timer polling for something that no longer exists.


**The push transport retires the problem instead of pacing it** (#194, host 0.2.1+): every state
change is appended as a durable plugin record (`ignorable`, never model-visible, rendered by
nothing) and a registered projection delivers it to the bar through the host's own push channel —
the steady state costs **zero command runs**, on any navigation, any tab, any cadence. The bar
renders pushed values through the same reducer the pulls feed, so there is one fold path and no
second implementation to drift. Detection is honest in both directions: the projection is
registered only when the record writer resolved against the host's own module instance (a
plugin-side copy cannot be used even at the identical version — class identity is per instance,
measured), and a client that sees no projection keeps the pull schedule above, unchanged. In push
mode the only pulls left are the bar's own actions and one staleness-confirm per turn-end,
scheduled at +20s and cancelled the moment a fresher record arrives — a silently dead push
degrades to one pull per turn, never to a frozen bar. Hosts before 0.2.1 (`appendPluginRecord`
absent from 0.2.0-rc.2, grep-verified on the tags) get the pull schedule as their steady state —
the fallback is the floor.

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
