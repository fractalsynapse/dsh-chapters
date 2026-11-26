---
title: "8. Recursive context theory"
description: The intellectual basis — long material as an external environment the agent inspects programmatically, not a context to be compressed.
lastUpdated: true
---

The naive frame: a model has a context window; when content exceeds it, compress. dsh-chapters takes the opposite frame, and it is worth being precise about because it is where most memory systems diverge.
## The goal is carried into the child as text, and said aloud as unarmed (#349)

A session running under a goal (`/goal`, or `create_goal`) has an objective the host is driving toward.
A continuation child reads its parent's archive and notice — but **not its parent's goal state**, so unless
something carries it, the objective stops steering the work exactly at the boundary the plugin exists to
cross.

What happens now, conservatively:

- The child's continuation notice gains a **`## Goal (carried from the parent session)`** block, folded from
  the parent's durable `goal/change` events by one selector (`foldGoalFromLog`) and rendered by one function
  (`renderGoalCarriage`). It states the **objective whole**, the revision, the round cap, the phase, and the
  seq it came from.
- And since #349's decision landed (2026-11-19, `goalRearmOnCarry` default **on**): an **ACTIVE** goal is
  **re-created on the child** through the host's goal service — the objective keeps driving work instead of
  becoming prose — and the block says exactly that. Paused or blocked goals are stated but NOT re-armed: a
  human stopped it; only a human resumes it. With `goalRearmOnCarry: false` the notice carries the
  older wording — "the goal is NOT armed in the child, and only the human can send `/goal resume`" — which
  remains true of that mode.
- A **cleared** goal carries nothing. A **completed** goal is stated as finished and gets no re-arm
  instruction, so a child cannot pick a closed purpose back up.
- A session that never used a goal pays **zero bytes**: the block is absent, the notice is byte-identical
  to before, and no recorded tape shifts.
- The budget (`goalNoticeChars`, default 600) bounds the **objective display only**. The instruction lines
  are never truncated — a cut-off "only the human can re-arm" is worse than none.

### The authority question, and how it was answered (#349)

The host's `create_goal` TOOL is gated behind `requireDirectHuman`: an open-turn message with
`source.kind === 'user'`. A continuation child's first turn is authored `plugin:dsh-chapters`, so the child
cannot call the tool. The **service** underneath (`ctx.get('goals').create(agent, …)`) has no such gate, so
the plugin *could* arm a goal on the child's behalf — and routing around a direct-human gate because the
seam is reachable is an authority widening, not a fix. #349 asked the maintainer explicitly rather than
deciding silently.

**The decision landed 2026-11-19: YES, scoped.** `goalRearmOnCarry` (default on) re-creates an ACTIVE
carried goal on the child through the service — the one authorized exception to the direct-human gate,
bounded by `goalRearmDecision` (paused/blocked/complete/cleared never re-arm), loud on every refusal, and
`false` restores the notice-only wording byte-identically. The plugin ships the documented, configurable
step the old section said it would need — which is the correct outcome of "not a side effect of the birth
path": the seam is used by decision, behind a named control, not by accident.

### One state the log can give, and one it cannot

`phase` (active / paused / blocked / complete) is carried inside `goal/change`, so the block can state it
truthfully. **`activation` — armed or disarmed — is not in the log at all**: the host keeps it process-local,
and the plugin reads it from the live service for its own driver decisions. In notice-only mode the block
says who *can* change the driver, never what the driver currently is; a claim about armedness recovered by
folding history would be a guess dressed as a record. The one thing the block may assert about armedness is
the plugin's OWN act at birth — "re-created on the child (armed by the host's goal service)" — because that
is a fact about what this door just did, read from the service call's result, not from history.

Rows: `tests/unit/goal-carriage.test.ts` (fold semantics for every operation the host emits, including
unknown ones ignored; clear vs complete; budget and instruction survival; zero bytes with no goal; notice
placement above the fold).


## The claim

**Long material is not a window to fit; it is an external environment to inspect.**

This is the Recursive Language Model (RLM) result — Zhang, Kraska & Khattab, *arXiv:2512.24601*. Their formulation: treat the long input as an *external environment*, let a small model run programs that decompose it and pull **sub-spans** into its limited window programmatically, recursing as needed. Their mechanism is a Python REPL over the prompt; their reported **compaction-baseline gap** (median ~26% quality) is the evidence that *how you handle overflow* matters more than *how big the window is*. The quality argument for this project's architecture is theirs, cited by name in the repo's own design record.

## dsh-chapters' instantiation

The same decomposition, engineered for a coding agent's real corpus, **without a code sandbox or a separate REPL**:

| RLM idea | Here |
|---|---|
| long input as external environment | the `.dsh-chapters/` archive on disk — files, plain Markdown |
| recursive decomposition | TOC notice → numbered chapters → per-chapter frontmatter + headings → `read` on a path |
| pull sub-spans into the window | `read` with offset/limit; oversized *tool results* deferral to content-addressed `artifacts/`, retrieved via `chapters_artifact` with `toc / search / read` |
| agent drives the recursion | the model issues the reads; the plugin provides handles (paths, `⟦omitted…⟧` markers, artifact TOCs) — never a token reading of the session, which the model cannot verify (#330) |

Structured documents even self-describe: a 373 KB book arrives with a parsed table of contents so the first call is already a search, not a dump.

## The guard that keeps it honest

The follow-up, SRLM (*arXiv:2603.15653*), supplies the caution: **recursion that splits material that already fits actively hurts.** So the design refuses to be a split-everything stance — a **hard band boundary** decides *when* the recursive path engages, and bounded pulls stay the model's *choice*, never a forced pipeline. That boundary — and the refusal-not-truncation it feeds into ([§7](/concepts/budget/)) — is what separates this from "chunk everything and RAG it".

## What it buys, in one line each

- **Unbounded horizon on a bounded model** — the same 64K window carried a ten-session, multi-agent project analysis; the field study in [§20](/evidence/field-study/) is the existence proof.
- **Verbatim, lossless retrieval** — you pull the *bytes*, not a paraphrase of them; a summary can never do that.
- **Structural cost control** — the retention paradox (huge-but-new) never fires because the huge result is stubbed *at arrival* ([§9](/concepts/archive-anatomy/)).
- **Model-agnostic quality** — it's about context *management*, so a 64K local model gains capability rather than merely longevity. The thesis is *small models, more capable*.

## What it concedes

- **Extra round-trips** — retrieval costs turns and re-prefill; a summary is one call. Recursion is the discipline; over-splitting is the failure mode the guard defends against.
- **Model cooperation** — it depends on the agent deciding to reach. In the field study, it did 49/49 times; the archive is written from the log *regardless*, so the worst case is under-retrieval, never data loss.

Next: [9. Anatomy of the archive](/concepts/archive-anatomy/).
