# The autorun guide — goal-directed sessions that keep themselves moving

> Status: draft for the maintainer's process review (#186). Promotion to the documentation site
> (a numbered section beside §28) happens after that review. Every command verb, config key, and
> default named here was read out of the shipped source at 0.2.3, not remembered.

## 1. What this system is for

A coding agent stops when its turn ends. Everything in this guide exists to close the gap between
"the work needs forty turns" and "a human is pressing Enter forty times" — without handing the
machine unchecked authority over the objective:

- **The goal** is the standing directive: what done means, and the stopping rules around it. The
  host's goal driver re-prompts the model at every turn boundary until the goal is complete,
  blocked, cleared, or its round budget is spent.
- **The Suggested Next Step bar** is a second model — the *prompt model*, whose whole job is to
  write the ONE next instruction — consulting the session's live tail and its archived-chapter
  summaries after each completed turn.
- **Autorun** is the clutch between them: armed, each suggestion runs itself as a human-authored
  turn, so the session keeps working without you. With a goal armed, arming autorun *displaces*
  the goal driver's own continuation — the goal remains the objective, but the suggestion loop
  becomes the engine. Without a goal, autorun simply keeps iterating suggestions.
- **Chapters** make the loop sustainable: when context pressure arrives, the conversation is
  archived verbatim into chapters and the work continues in a fresh session seeded with nothing
  but a table of contents. A 32K-context model can run a hundred-turn objective because its
  context is renewable.
- **Enrichment and rule distillation** make the loop *learn*: idle-time model passes annotate the
  archived chapters (title, summary, topics — so retrieval works), and mine them for standing
  orders (rules with an honest warrant: `stated` only when a human literally said it, `inferred`
  when the model judged it useful). Rules then assemble into every future task's context.

The two-by-two that orients everything else:

| | no autorun | autorun armed |
|---|---|---|
| **no goal** | ordinary chat; the bar offers suggestions, you press Run (or ignore them) | the suggestion loop iterates on its own, up to its round budget |
| **goal armed** | the host's goal driver re-prompts each turn boundary (rounds cascade until complete/blocked/cleared/budget) | the suggestion loop drives instead — the goal driver's continuation is displaced, the goal stays the objective |

## 2. How it works, turn by turn

1. A turn completes. If a prompt model is set, it is asked for the next step: one imperative
   instruction, at most `promptMaxChars` (default **240** today) characters, composed from a
   `promptContextChars` (default **4000**) budget covering the session's chapter summaries, the
   live conversation tail, and the active goal. An over-cap answer is *refused, never truncated* —
   a suggestion you can't see whole is a suggestion you can't judge.    As of 0.2.4 (#188, shipped): the suggestion cap defaults to **4096** characters, and both caps
   belong to the model — `/chapters-prompt model <provider/model> [maxChars] [contextChars]` stores
   explicit numbers beside the model, and with no explicit numbers the context budget **derives from
   the model's real window** (`window × promptContextRatio`, default 0.5, at 4 chars/token — a 32K
   model and a 1M model get budgets 30× apart from one rule). The input itself became the session's
   memory: the goal whole, the active plan, the core rules, every chapter on the ancestor path as
   title + detailed summary + every plot line, and the last turn whole — with **zero truncation** as
   an invariant: over budget, the oldest chapter drops (announced) until the history fits, and a
   protected set that cannot fit refuses with the numbers instead of sending a starved input.
2. The offer is classified. Plain text = a **worker-step** (autorun may fire it). A `GOAL:`
   prefix = a **goal-edit**: the model is proposing to re-cut the objective itself. Autorun must
   never act on a goal-edit — the host reserves objective changes for direct human turns — so it
   waits in the bar for you to read and Run yourself.
3. If autorun is armed and the offer is a worker-step, the loop fires **at most one turn per
   offer**, submitted through the same path as the bar's Run button: a human-authored user turn.
   Fired rounds count against `promptMaxRounds` (default **24** per session); offers nobody armed
   never spend the budget.
4. Arming autorun while a goal is active calls the host's goal *disarm* seam: the goal driver
   stops re-injecting its rounds while the goal itself stays durable and unchanged (phase,
   objective, revision all intact). You can see it: the goal bar's `Pause goal` becomes
   `Resume goal`. One engine owns each turn boundary — never two.
5. Context pressure arrives eventually; that is the design, not a failure. The host's relief
   compacts the surface, chapters archive the span verbatim (oversized tool results defer to
   content-addressed artifacts), and a continuation opens with the TOC notice as its only seed.
   The goal rides the session tree into the continuation; **autorun does not** — armed state is
   process-local per session and nothing arrives armed after a restart or in a child. Re-arm
   deliberately; a loop that starts turns must never resume itself.
6. While the session is idle, enrichment drains its queue in batches (`enrichmentIdleMs`,
   `enrichmentBatchCap`): one structured call per archived chapter asks for
   `{title, summary, topics, rules[]}` as validated JSON — retry once, and on second failure the
   deterministic values stand (a slow or failing model never blocks or blanks a chapter). The
   chapter's body is never touched; annotations land in frontmatter with a `generated:`
   provenance chain.
7. Mining rides the same call (or a dedicated one when `rules.model` is set — one extra bounded
   call per chapter, which is exactly what you pay a better model for). Each candidate rule
   carries a `quote`; the quote is checked **verbatim against human bytes only** — a quote found
   in assistant prose is the model restating itself, never evidence you said it. That decides the
   warrant: `basis: stated` (your words are behind it) or `basis: inferred` (the model judged it
   useful and nobody said it). With `rulesAutoActivate` on (the default), mined rules govern the
   session tree on arrival and `revoke` is the undo; with it off, they are held `reviewOnly`
   until this machine approves them.
8. Rules close the loop: at the start of every task the model can assemble the standing orders in
   force (`chapters_rules`), and rebuilt heads render the core set — so what the loop learned
   yesterday shapes what the loop suggests tomorrow.

## 3. Before you start

1. **Install/update** the plugin in your harness profile and restart the harness:
   `npm i @treeseed/dsh-chapters@latest` (site §23 covers every path).
2. **Optionally link a knowledge pool** so chapters and project rules are shared across machines:
   `/chapters-link <path-or-url>`. Everything in this guide works without it; with it, project
   rules and the archive travel.
3. **Pick your models** — this is what `/chapters-models` exists for:

   ```
   /chapters-models                      # providers + advertised models as paste-ready ids
   /chapters-models <provider> <model>   # one route: context window, reasoning efforts
   ```

   The footer shows what each of the three settings currently resolves to. Three knobs, three
   different jobs:

   | setting | command | job | default |
   |---|---|---|---|
   | annotation | `/chapters-enrich model <provider/model｜clear>` | summarize archived chapters for retrieval | unset = rides the conversation route |
   | mining | `/chapters-rule model <provider/model｜clear>` | distill standing orders — judgment-heavy | unset = rides the annotation call |
   | prompt | `/chapters-prompt model <provider/model>` | **defines the next work**; setting it IS enabling the bar | unset = the feature does not exist |

   The bar's visibility rule is exactly this setting: with no prompt model, the feature does not
   exist anywhere; the moment one is set, the bar appears docked above the composer (its own dock
   slot, order 30) and lives there per session — `Analyzing…` after each completed turn, then
   `Recommended Next Step`. `/chapters-prompt off` hides it for the session (`on` brings it back),
   and an idle bar stays visible on purpose: "live, nothing to say yet" must not look like
   "disabled".

   Tuning intuition: annotation is volume work — a cheap, fast model is right. Mining reads
   between the lines for instructions worth keeping — this is where a stronger model earns its
   extra call. The prompt model writes the instruction that *becomes the next turn*; under
   autorun it is effectively the loop's director, so give it the best model you can afford.
4. **Decide your review posture.** `rulesAutoActivate: true` (default) means mined rules govern
   on arrival — fast, and `revoke` undoes any mistake per machine. Setting it `false` holds every
   mined rule inert until `/chapters-rule approve <id>` — right for shared pools where a
   mis-generalization would bind teammates. Config keys live on the preset row in your profile's
   `cordis.patch.yml` (site §16).

## 4. The arc: from a need to a completed goal

**Phase 1 — Identify the work.** Either bring a decision you made outside the session ("we're
migrating the auth layer; here's the plan") or think it through with the model by ordinary
conversation. Either is fine; what matters is that the objective ends up stated in words a
stranger could judge completion by. When the model needs a decision from you it should ask with
the question tool — which suspends until you answer — rather than burying a question in prose
and proceeding on a guess.

**Phase 2 — Arm the goal.** Say it plainly: *"Create a goal: <objective>."* The model calls
`create_goal`; the host's goal bar appears with `Pause goal`. Two numbers matter:
`max_goal_rounds` caps the automatic continuation rounds (default **256** — a round is itself a
turn, so rounds cascade until something stops them); ask for a smaller budget when the objective
is bounded. The goal can be edited, paused, resumed, completed, or marked blocked through the
model (`update_goal`) — blocked requires the same concrete condition to persist for at least
three consecutive rounds, so it can't be used to give up early.

**Phase 3 — Hand over the wheel.** With the bar's model set (step 3 above), arm the loop:

```
/chapters-prompt autorun on
```

The reply tells you which engine you got: with a goal armed it reports the displacement ("the
goal remains the objective; its own auto-continuation is disarmed, so the suggestion loop
drives"), and the goal bar flips to `Resume goal`. Autorun needs a prompt model — arming without
one is refused, loudly.

**Phase 4 — The loop.** Now watch it work. The bar is your primary surface here — everything
per-turn happens on it, and the commands you typed in Phase 3 were configuration, not the
workflow. After each completed turn the bar shows *Analyzing…* then *Recommended Next Step*;
expand it to read the offer in full; **Run** submits it as your own turn; **Autorun** arms the
loop so worker-step offers run themselves; **Off** hides the bar for the session. Armed autorun
fires worker-steps as human-authored turns; pressure points become checkpoints and continuations;
idle time annotates and mines. Your role shifts from author to editor — which brings us to the
situations.

**Phase 5 — Steering (everything in between).** See the table in §5. The one rule of thumb:
**typing anything takes the wheel.** A human turn disarms autorun immediately (the offer stays
visible, and the reply says why), so interrupting is always safe and never loses the suggestion.

**Phase 6 — Completion.** The model marks the goal complete only when the objective is actually
achieved, with evidence gathered before the claim; you'll get a closing report. Or it marks
blocked with the concrete persisting condition — and **blocked disarms autorun exactly like
complete does** (0.2.4, #188: both planes stop together; a loop firing offers at a dead goal
outlived its purpose). You can end it yourself any time (`/goal clear`, or Pause on the goal
bar). While a goal is active or paused, the round budget **stands down** — the pursuit is bounded
by the goal's lifecycle, never cut off by `promptMaxRounds`. With no goal (or after one is
cleared), an armed loop keeps iterating suggestions within the budget (default 24): open-ended
iteration is a feature, but know it's there — the last thing you do is usually `autorun off`.

**Phase 7 — After.** The work outlives the session: chapters are searchable (`chapters_search`
for the model, the pool for your team if linked), artifacts remain addressable by hash, and mined
rules persist — session-tier ones stay machine-local and bind that session tree; promote a good
one to the shared tier with `/chapters-rule add <category> "<text>"` (a new project-tier rule)
and `approve` it per machine.

## 5. Situations and possible actions

| Situation | What's happening | Action |
|---|---|---|
| The suggestion is wrong | the prompt model misread the state | Just type your own instruction — a human turn disarms autorun and the offer stays visible. Or Run a different pace: `autorun off`, steer manually |
| The suggestion starts with `GOAL:` | the director proposes re-cutting the objective — autorun will never fire these | Read it. If right, press Run yourself (objective changes need a human turn — that's the host's rule, not a limitation of the loop). If wrong, ignore it; the next turn gets a fresh offer |
| The loop is circling | offers repeat variations; no state changes | `autorun off`, then either re-cut the goal (ask the model to `update_goal` edit) or give one concrete instruction that breaks the cycle |
| The objective is stale | the work changed shape | Ask the model to edit the goal (a revision bump invalidates outstanding offers — last cycle's directive can't fire against a re-cut objective), or `/goal clear` and create a new one |
| It won't stop | rounds cascade by design | Three brakes, finest first: `autorun off` (loop), `Pause goal` / ask to pause (driver), round budgets (`promptMaxRounds` 24, `max_goal_rounds` at create) |
| A mined rule is wrong or over-general | inference happens; that's why the warrant exists | `/chapters-rule list --scope session` → `view <id>` (full text + basis) → `revoke <id>`. Machine-local, one command, file bytes untouched |
| A mined rule is good and general | worth binding beyond this tree | `/chapters-rule add <category> "<text>"` creates a project-tier proposal; `approve <id>` makes it core on your machine; the pool carries it to teammates |
| You keep repeating yourself | say it once, durably | Start a line with `ADD RULE: <text>` in your own message — deterministic capture, zero model tokens, active for your session tree, exactly your words |
| Mined rules worry you | shared pool, high stakes | `rulesAutoActivate: false` in config → REVIEW posture: every mined rule waits inert for `approve`; `/chapters-rule active` shows the posture and what a rebuilt head will render |
| Annotations are shallow | annotation model too weak, or wrong for the corpus | `/chapters-enrich model <better/id>`; re-run with `/chapters-enrich run` |
| Mining misses the point | mining rides a cheap annotation call | `/chapters-rule model <stronger/id>` — one extra bounded call per chapter, the intended lever |
| Enrichment backlog | idle batches haven't drained | `/chapters-enrich report` (status + pending count), `/chapters-enrich run` (drain now) |
| Session feels long/slow | pressure is normal; relief is automatic | Nothing required — checkpoints and continuations are the design. Optionally `/chapters-save` (archive without a child) or the message doors: **Continue with chapters** (same line of work, fresh context) / **Fork with chapters** (branch an experiment; the parent stays untouched) |
| The bar is in the way | you want a quiet session | `/chapters-prompt off` hides it; `on` brings it back. Off is per session |
| Something looks broken | sync, store, or diagnostics | `/chapters-status` (prints the whole diagnostics block in every state); `/chapters-repair` for archive damage (supersedes, never rewrites); `/chapters-rule conflicts` for contradictory standing orders (report-only — it never edits a rule) |
| Restarted the harness | armed state is process-local by design | The goal persists (durable); autorun does not (nothing arrives armed — a loop that starts turns must never resume itself). Re-arm deliberately |

## 6. Command summary

```
Discovery          /chapters-models [<provider> [<model>]]
Suggestions        /chapters-prompt model <provider/model> | on | off | state | autorun on|off
                   /chapters-prompt suggest   (compose a fresh offer now — the pull the bar rides)
                   /chapters-prompt run       (submit the offer on screen — the bar's Run button as a command;
Enrichment         /chapters-enrich run | model <provider/model|clear> | report
Rules              /chapters-rule add <category> <text> | list [--all|--proposed|--category <c>|--scope project|session]
                   /chapters-rule view <id> | active | approve <id> | revoke <id> | pin <id> | unpin <id>
                   /chapters-rule model [<provider/model|clear>] | conflicts
Archive & health   /chapters-status | /chapters-save | /chapters-repair | /chapters-link
                   both are session-scoped: "the offer on screen" is a per-session fact)
Doors (UI)         Continue with chapters · Fork with chapters · the Suggested Next Step bar (expand, Run, Autorun, Off)
Goals (host)       the goal bar (Pause/Resume) · /goal · the model's create_goal / get_goal / update_goal tools
Marker (chat)      ADD RULE: <text>   — at the start of a line in your own message
```

Config keys you're most likely to touch (preset row in `cordis.patch.yml`, site §16):
`promptMaxRounds` (24), `promptContextChars` (4000), `promptMaxChars` (240), `rulesAutoActivate`
(true), `rulesEnrichment` (true — mining on/off), `enrichmentEnabled` (true),
`enrichmentIdleMs` / `enrichmentBatchCap` / `enrichmentMaxTokens`.

## 7. Honest limits (stated, not buried)

- **Run submits as-is.** No current host lets a docked plugin write the composer draft, so
  click-to-edit a suggestion before running it is not available — the bar explains this where you'd
  expect editing, and Run submits (#126 tracks the host ask). To change a suggestion: turn autorun
  off and type your own version.
- **Autorun never fires a `GOAL:` offer** — objective changes are human turns by host design.
- **Nothing arrives armed.** Autorun is per-session, process-local; restarts and continuations
  start disarmed. The goal is the durable half of the pair.
- **A blocked or completed goal renders no strip** in the goal bar — if the bar vanished, the goal
  reached a terminal state; `/chapters-prompt state` reports the whole picture (suggestion, model,
  autorun, intent, goal) in one block.
- **Displacement needs a host seam.** Where `GoalService.disarm` is absent, arming autorun
  degrades safely: the loop yields to the goal driver instead of racing it, and the command's
  reply tells you which behavior you got.
- **The loop is as good as the prompt model.** Under autorun that model is the director of every
  next step — the single most consequential of the three settings. `/chapters-models <provider>
  <model>` shows its context window before you commit.
