# The Host Compaction Seam — and Why It Shrinks the MVP

Found in Phase 0b by reading `examples/deepseek-harness/packages/compaction/`, before writing any plugin
code. The plan in `docs/architecture.md § Phases` assumed we would build pressure detection, surface
replacement, and a TOC-delivery mechanism. **The harness already has all three.** Cited so this can be
re-verified on upgrade.

## What already exists

| Capability | Where | Consequence for us |
|---|---|---|
| Automatic pressure compaction with a configurable ratio | `compaction-basic/src/index.ts:126` `if (this.config.auto) this._registerAutomaticCompaction()`; `thresholdRatio` default **0.8**, `retainRatio` **0.16** | Do not build `pressure.ts`. **Delete it from the plan.** We set `thresholdRatio: 0.9` in config. |
| **Provider-confirmed context-overflow recovery** | `index.ts:220-221` (`context overflow recovery`), `maxOverflowRetries`, returns `{ kind: 'retry' }` | The user's "compact when it runs out in the current conversation" is already implemented, including retry. |
| Between-step trigger, replayed at step boundaries | `_registerAutomaticCompaction`, `compactIfNeeded` "dynamically dispatched so subclass overrides are honored" | Correct trigger timing is inherited, and safe: never mid-step. |
| Per-model policies | `modelPolicies: z.array(modelPolicy)`, `resolveTargetPolicy(config, target)` | 32K models get their own ratios without code. |
| **One sanctioned extension hook** | `index.ts:215-217`: "`summarize()` is the **sole subclass customization hook**; the replay and durable mutation strategy stays fixed" | Our entire integration surface: subclass `BasicCompactionEngine` (exported, `export default BasicCompactionEngine`, `:434`) and override `summarize()`. |
| Cache-aware auxiliary call shape | `:224-227`: the summary call's "prefix reuses the conversation's own system prompt, tools, and messages so the provider's KV cache is not invalidated" | The pattern to imitate if we ever need a model call — already solved for us. |
| Transactional result contract | `ManualCompactionError` codes `busy / cancelled / changed / summary / commit / persistence` (`summary` = shrink floor refused; observed live in r12); `compaction/summary` event records summary inputs, route, model, usage, `shadowedSeqs`, `shadowedRange` | Real failure semantics to render, not to invent. `changed` = history moved under us; `commit` = partial application is a documented state. |
| **Tool-result pruning** | `compaction-tool-result-pruner` — "replay-safe, model-free", `PRUNE_MARKER`, shadow-price event | Overlaps our deferral idea. Ours differs by writing a **retrievable file and a path reference**; its pruning replaces content with a marker. Verify they compose before assuming. |
| Image offload | `compaction-image-offload` (`agents`, `sessions`) | Precedent for exactly the "attachments leave the body" pattern. |

## The correction this forces on our founding premise

`compaction/types.ts:3` describes `compaction/*` events as **"log-only, no surface events"**, and a
separate replacement `user/message` carries the summary while `result.shadowedSeqs` names the hidden
surface nodes.

So DSH's compaction **shadows surface nodes; it does not delete the durable log.** Every claim in
`README.md` and `AGENTS.md` that in-place compaction destroys the raw text is therefore **wrong about the
record** — the text stays in the log. What is actually lost is *model accessibility*: the content is
hidden from the projection and there is no addressable handle the agent can use to get it back.

That is a smaller and more honest claim, and it redefines our value:

> dsh-chapters does not prevent data loss the harness would otherwise cause. It makes compacted content
> **addressable and re-loadable by the model** — topic-named chapter files with stable paths, an index the
> model can consult, and a decision about which oversized tool results are worth carrying — plus branching.

Everything in both docs that says "the raw conversation is gone" must be rewritten to say "the model can no
longer see it." *(Done — README §the two costs and AGENTS.md invariant 1 now phrase it as loss of
accessibility, with the check-2 qualification from Phase 0b.)*

## Revised MVP (much smaller than the approved plan)

1. **`ChaptersCompactionEngine extends BasicCompactionEngine`**, overriding only `summarize()`. Instead of
   returning an LLM summary it returns **deterministic TOC blocks** over chapters written to disk — **zero
   summarization tokens spent**, which also means no `summarizationProvider`/`summarizationModel` config,
   no extra call, no summary-accuracy risk.
2. **Archive module**: `render` (ranges → Markdown + frontmatter), artifact deferral
   (content-addressed, dedup), `budget` check. Mount (corrected by Phase 0b — see "closed" section):
   a **shipped user-root preset** whose compaction group names `dsh-chapters` instead of
   `compaction-basic` (the web profile already ships the host rows `disabled: true`; the live engine
   sits in the agent-preset realm), plus `agents.create({ setup: ctx => agentPresets.mount(ctx, id) })`
   for continuations. The kernel refuses double-provision of `compaction` on one plane at boot.
3. **Registry** (storage domain `dsh_chapters`): chapter records, ranges, hashes, per-session index.
4. **`chapters_fork`** tool for branching/related conversations (Phase 0 already proved the mechanics), plus
   `chapters_segment` if model-assisted ranges prove better than deterministic chunking.
5. **Config**: `thresholdRatio: 0.9`, `retainRatio` tuned so the retained tail plus TOC fits a 32K window
   after the measured ~12K header.

Dropped from the plan: `pressure.ts`, `compact.ts`, custom surface mutation, custom trigger wiring,
`chapters_compact` as our own command (`/compact` already exists via `command-compact`), and the summarizer.

## Phase 0b closed — all five items measured (rounds 12-17)

Full evidence in [spikes/probe/FINDINGS.md § Phase 0b](../spikes/probe/FINDINGS.md). One-liners:

1. **Engine replacement: PROVEN.** Subclass + host-mounted service + `/compact` resolution + the
   automatic `agent/pre-step` path all dispatch into our override, manual and automatic transactions
   commit real durable records, zero provider calls (r12/r13). Double-provision on one plane fails boot
   loudly (`service "compaction" has been registered at <BasicCompactionEngine>`, r14). The live mount
   point is the **preset realm** — the web profile disables host rows and the `standard` preset mounts
   the engine inside an `isolate: { compaction: true }` cordis group; a user-root preset naming our
   package works end-to-end (r17, 6/6). New founding fact: **`agents.create` composes no preset** —
   `meta.agentPreset` is a label; without `setup: agentCtx => agentPresets.mount(agentCtx, id)` a child
   is a tool-less agent (974-token bare head, no `read`), with it the head is the real ~13.3K header
   (27 tools; r16). This lands on invariant 2.
2. **Shadowed content reachability:** no default model path exists (the web profile mounts no session
   query tool; the sqlite index ships `openAt: never`), **but** an opt-in package
   (`dsh-tool-session-query`, five tools incl. `session_event_read` = full unabridged event JSON)
   already ships in rc.2 — mounting it costs five schemas + fixed guidance per request. Differentiation
   survives as *readable topic-named files + zero-token index + forking*; the README wording was
   tightened in the same change.
3. **Prefix-cache sharing — CLOSED by r23:** cross-session sharing is ~one leading block (1,024 of
   13.7K on a cold start with siblings warm; r10/11 stand). In-place compaction across a head-position
   replacement: `cacheReadTokens` HELD (7,424 on both post-compaction turns) while uncached refill
   halved (13,658 → ~7,000, stable) — the header survives replacement, "refill halves" is the honest
   phrase, "fully cached" is not. So the cache story favors the engine as designed: the engine is the
   relief mechanism; `chapters_continue` is for branching and topic resets (it pays one full cold
   ~13.3-15K head).
4. **Pruner × deferral: compose**, given one rule — render chapter bodies from the **durable log**
   following each replacement's `sourceEventSeqs` (the pruner only shadows surface nodes; originals are
   untouched), never from `summarize()`'s input, which already shows `PRUNE_MARKER` truncations.
5. **Vocabulary: pinned** — `src/notice.ts` + `test/notice.test.ts` (kernel-measured rejections
   reproduced; published `MessageSourceMap`/`ContextForm` constants; installed-`.d.ts` drift guard).

### Also true, learned late (fix on contact)

- `summarize()` receives no seqs; the manual path bypasses `compactRegion` dispatch; correlation is
  post-commit via `CompactionResult.shadowedSeqs` / the `compaction/summary` event.
- `compactIfNeeded` no-ops until the session has a durable routed request — the first step can never
  compact (index.ts:260).
- `retainRatio ∈ (0, 1]`; zero-tail tests use `retainTokens: 0`.
- Subclassing inherits `static inject` — extend it or `ctx.agents` throws `cannot get property "agents"
  without inject`.
- Host consumers do `instanceof` against THEIR copy of `ManualCompactionError`; our engine's throws are
  a different class when mounted from a different tree — pair `command-compact` with us in one tree or
  ship our own command (r12 section J observed the raw-throw degradation).

## Verification delta

Landed as `docs/verify.md § Engine-Path Checks` (E1-E6): after automatic compaction, assert (a) the
header prefix stays cached — **E3 still OPEN, never measured on a composed session**; (b) the
durable log length **never decreased** (shadowing, not deletion — r12 proved the host honors this);
(c) a compacted session can still answer a question whose answer lives only in a chapter it chooses to
`read`; (d) the summary call cost is **zero** tokens, since our `summarize()` is deterministic —
proved with the r12 stub (no `usage` field), must re-prove with the real TOC.

## Measured on 0.2.0-rc.2 (2026-10-23, #78) — what the seam actually does now

Every line below came from an artifact in this repo's own run: the diagnostics sink
(`realm:engine:compact`), the tape proxy journal (`reqBytes=`, `OVERFLOW refused`), or a decoded
`session.v4.jsonl.zstd`. None of it is inferred from the 0.1.x notes above, which is the point —
those notes are what made the failure legible as "the hook is never called", and that was wrong.

1. **The host does call our override.** Pre-step, with `trigger="pressure"`:
   `compactIfNeeded entered (trigger="pressure", session=session-…)` — three entries in one probe
   session, seven compactions in one `heavy` session. The claim "never invoked" was an inference
   from absent `compaction/*` events, and the instrument replaced it with a fact in one run.
2. **The base decision path** (`dsh-compaction-basic/lib/index.js`) is: `routedTarget(session)` →
   `undefined` ⇒ return `null` immediately; else `tokenMeter.measure(session)`, then
   `llm.resolveModelInfo(provider, model)` for `contextWindow`, then
   `resolveCompactSpec(policy, window, reservedCompletionTokens(agent, defaultMaxTokens))`, then
   `measurement.totalTokens < spec.thresholdTokens` ⇒ `null`; else `selectCompactableRange(...)`,
   which can itself return `null` — that is the documented "no safe range" case, and it is the case
   `heavy` reaches.
3. **Two failure shapes for the same field symptom.** A decline can be a `null` return or a THROW
   (`selectCompactableRange` threw on a harness session whose surface it could not read). The
   engine now reports on both paths, because "the endpoint said 400" was the only user-visible
   trace of a state the product knew about.
4. **A single oversized `tool/result` is not relievable by pressure.** Measured: one 120,650-byte
   result (~30K tokens) in a 32,000 window at ratio 0.5 — six compactions of *older* content, then
   the hard `400 … exceeds the context window`. The knob that prevents it is the **arrival floor**
   (`toolResultArtifactTokens`), and `heavy` deliberately sets it to 1,000,000 so pressure — not
   arrival — is what gets exercised. The engine does NOT override that floor: AGENTS calls it "a
   behavior switch, not a knob", and an engine quietly reinterpreting an operator's switch is the
   same species of dishonesty as a pin that is collected and never applied. What it does now is name
   the switch, the offending node size, and the count of nodes above the trigger, in the sink.
5. **Bytes ↔ tokens, calibrated.** 78,140 serialized request bytes measured 27,306 / 27,952 /
   28,928 tokens by the host meter — **≈2.8 B/token**, not the conventional 4. The rig's window
   enforcement uses whole-body `/3` (deliberately conservative: early refusal still exercises the
   regime; late refusal exercises nothing) and the rows assert the estimator against the two field
   values that matter, including the 120,129-byte / 35,428-token request that `4/` let through.
6. **The regime must be identical in record and replay.** Enforcement applies in both modes now:
   a distill whose request was refused, relieved, and re-asked recorded a sequence *shaped by* that
   refusal, so a replay without it diverges and looks like prompt drift.
7. **Realm config lives on the preset row, not the host row.** `thresholdRatio`,
   `toolResultArtifactTokens`, `artifactStoreRoot`, `auto`, `elicitedPlot` are read from the
   `chapters-engine` row inside `preset-chapters` (`cordis.patch.yml`); the host plugin row's
   `compactionThresholdRatio` / `installChaptersPreset` are inert since 0.1.18. This is why an
   apparently-configured rig ran every leg on realm defaults while its own header claimed 0.5.

## Relief must not shadow the question (#87, measured 2026-10-23)

The seam's real failure mode is not a crash — it is a **surface with no request in it**. Field
evidence from one `heavy` session (299 events, decoded `session.v4.jsonl.zstd`):

```
13 compaction summaries, 108 distinct shadowed seqs
STILL-HERE instruction seqs:      [109,116,138,154,172,188,216,236,254,268,291]
shadowed away by relief:          [109,116,138,154,172,188,216,236,254,268]   ← 10 of 11
final assistant text: ""
```

Why: `retainRatio` reserves a *token fraction* as a verbatim tail. When an oversized `tool/result`
sits in that tail it eats the whole budget, and range selection shadows the newest `user/message`
anyway. Our summary is deterministic and plot-shaped, so it carries no request. The user sees an agent
that stopped responding, with nothing in the sink — a `#61a` violation twice over (undetected, and
therefore undelivered).

**The rule we ship.** We author the summary text, so the newest human turn travels *into* it — verbatim
(`carryOpenRequest`, `src/engine.ts`). Nothing recorded is rewritten: this honors invariant 1, appends
to our own output, and the input array is never mutated. Details that are the point:

- **Injected scaffolding is skipped.** `<system-reminder>`, the host's checkpoint preamble,
  `Time sampled …`, artifact stubs: re-injecting machine state as if it were a request would be a
  different lie, so the predicate that decides "is this a human turn" lives in ONE place — the same
  one-predicate rule that bit us with #59's title chooser.
- **A cap is stated, never silent.** `openRequestCarryMaxChars` (realm config, default 4000) bounds the
  block, and when it bites the text says `carried in part: N characters total, M included — the whole
  turn stays in the durable log`. Never truncate to fit is a plugin rule, and it applies to our own
  summaries.
- **Nothing is claimed when there is nothing to carry.** No human turn in the region ⇒ no OPEN REQUEST
  block, no empty promise of one.

Rows: `tests/unit/engine-open-request.test.ts` (verbatim carry; injections excluded; stated truncation;
empty region), written before the wiring was trusted. **Process lapse, recorded honestly:** the mandated
cycle is Issue → Docs → Tests → Code, and here I wrote the implementation before this section. The
issue (#87) and the tests did come first, and the docs landed before the commit — but the order slipped,
and a rule that is only followed when convenient is the kind of drift this file exists to catch.

## The last-resort deferral (#78 option A, decided 2026-10-23)

**The rule.** A single `tool/result` that cannot coexist with the mandatory verbatim tail makes pressure
relief *impossible*, not merely hard: `selectCompactableRange` finds no safe range, the engine declines,
the endpoint refuses the request, and the session is left spinning (#86) or answering something other
than what was asked (#78's original symptom). Survivability is therefore an invariant, not a tuning
outcome: such a node is artifact-deferred **as a last resort**, with a delivered warning naming the seq,
the node's tokens, and the ceiling it failed.

**Three bounds, because the obvious implementation is the wrong one.**
1. **After a decline, never before.** The trigger is the measured fact that relief ran, found no safe
   range, and the surface is over the trigger. Deferring big nodes eagerly makes compaction unnecessary
   and turns `oversized-turn.spec.ts` into a tautology — the trap AGENTS names in the rig rules — so an
   anti-vacuity row asserts the ceiling does NOT fire when relief is possible.
2. **Derived, not invented.** The ceiling is `windowTokens − retainBudget`, both from the base's own
   config (`resolveCompactSpec` inputs), so no new magic constant appears. The one new key is the
   operator-visible boolean switch `lastResortArtifact` (default on), which `preset-declaration.test.ts`
   must see declared or the loader strips it.
3. **The archive keeps every byte.** The deferral writes the artifact and leaves a citation, so the worst
   case is a context-economy miss and `chapters_artifact` still answers for it — which is the only thing
   that makes overriding a configured economy knob defensible at all.

Rows: `tests/unit/engine-last-resort.test.ts` — fires only after a decline; below the ceiling, untouched;
switch off, untouched even after a decline; and the warning carries the numbers.
