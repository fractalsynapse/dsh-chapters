---
title: "18. The continuation notice, annotated"
description: The single message a new session starts with — every section, annotated with what it is and why it exists.
lastUpdated: true
---

A continuation's whole inherited history is one message: exactly one synthetic `user/message` event at seq 0, seeded with source `{ kind: 'plugin:dsh-chapters', form: 'snapshot', sections: [...] }` (a producer-owned kind — session format v4 retired the bare `plugin` wrapper; see `docs/contract.md`). Here is the structure, line by line (as `assembleNotice` renders it — `src/continue-core.ts` is its only author):

```markdown
# Continuation: <title>                              ← the branch's headline
                                                       (durable — renamed via the host's title service)

Project: <slug> · <projectKey>                       ← only when a knowledge project is linked, with the
                                                       one-line pointer to chapters_search
<CORE RULES>                                         ← this machine's approved rules, verbatim; over budget
                                                       the continuation refuses, never clips
                                                       #50 adds a SESSION tier to the same block: local
                                                       rules, rendered beside the project ones; a fork
                                                       child gets zero session bytes (branch intent)

## Active plan
(this continuation keeps the same stream of work: 3 plan(s) submitted on the path — …)
- ACTIVE PLAN: "Carry plans into chapters" — APPROVED
  (ch. 4 · full text: .dsh-chapters/<root>/artifacts/8f/8f3….txt · plan document:
   .dsh-chapters/<root>/chapters/plan-001-….md · ~4.6K tok)
  Read the full text with chapters_artifact before implementing. Do NOT re-plan from recall.

## Previous plans on this path
(history — cited for evolution and status, not directives)
- "Carry plans into chapters" — REJECTED — the user sent it back with feedback (ch. 4 …)

- "Rollback plan" — PENDING … (NOT ARCHIVED — parent log seq 11 only)
                                                     ← the ACTIVE block appears only for a CONTINUATION —
                                                       whichever way it was pulled: the `chapters_continue`
                                                       tool, `/chapters-continue`, or the *Continue with
                                                       chapters* button (which runs that command). Same
                                                       stream of work, so the operative plan stays a live
                                                       directive and plan mode is SEEDED into the child when
                                                       the archived span was still planning. A BRANCH
                                                       (`chapters_fork`, `/chapters-fork`, the *Fork with
                                                       chapters* button) splits a new direction, so it gets
                                                       ZERO bytes here — the plans remain, but as history: in
                                                       the cited chapters and as searchable `kind: plan`
                                                       documents.
                                                       A continuation whose plan was already approved is NOT
                                                       seeded either — approving a plan exits plan mode, and
                                                       that child's job is to implement. Anything not
                                                       APPROVED says so to the child's face; a review left
                                                       open sits in an unfinished turn, above the archive
                                                       ceiling, and is named live and un-stored

This session continues an archived conversation. Chapters are verbatim Markdown in the workspace;
every byte remains retrievable — inline, or at artifact paths cited inside a chapter. Read a chapter
by its path with the read tool when the detail matters. The previous session stays intact.
                                                     ← the fixed preamble, identical every time

## In flight
<State of play — the handoff note. Free text, the
agent's framing of "here's what's happening now".>   ← budget-checked TOGETHER with the index below;
                                                       "(none stated)" when empty

## Chapters
1. [Deeply analyze this project…](.dsh-chapters/<root>/chapters/001-….md) — <summary> (33 msgs)
2. [Earlier history](.dsh-chapters/<root>/chapters/002-….md) — <summary> ⚠ modified since archived
                                                     ← a PATH to verbatim text, not a paraphrase. The count
                                                       is CONVERSATION messages — injected host context
                                                       (AGENTS.md, skill catalogs) is marked-and-excluded,
                                                       so the same chapter counts identically on every
                                                       machine. ⚠ marks a chapter missing or modified
                                                       since archived — flagged, never trusted

## Finding things
- Chapter detail: open its path above with the read tool.
- A deferred tool result: chapters_artifact (the path, or the bare sha a chapter cites) — 'toc' | 'search' | 'read'.
- Anything else on this project — other sessions' work, archived plans (`kind: plan`), curated rules: chapters_search.
                                                     ← three verbs, one line each; the child's QUESTION
                                                       decides which to reach for. The notice used to teach
                                                       only `read`, so tools that were installed and never
                                                       mentioned were tools a small model would not think to
                                                       call. `retrievalHints` (default on) is the switch, and
                                                       off the notice is byte-identical to the old shape

Ancestry: root <session-id>; parent <session-id>; archive under .dsh-chapters/.
                                                     ← explicit back-links, one line; the chapter list
                                                       itself is the ancestor path flattened root-first —
                                                       reading order IS causal order; the model never
                                                       traverses
```

That is the entire inherited-context surface. There is no replay of the parent's last messages and no second index — the TOC is the only index, deliberately (a regenerated duplicate would drift).

A plan is the highest-value thing a continuation can inherit, and the one thing a child cannot reconstruct:
`exit_plan_mode` puts the whole design in a tool-call argument. So the operative plan's title, verdict,
chapter, blob and plan-document paths ride above the fold —
~40 tokens that stand between a child and the two failure modes: implementing something nobody approved, or
re-planning from recall. Seeding is measured, not assumed — the kernel accepts the two-event seed and the host's
own plan projection folds it to active, so a seeded child really is gated (see the repo's `docs/plans-carriage.md`
§ 10 for the probe). Its full bytes stay in the store (see [§9](/concepts/archive-anatomy/)); the notice
names where they are, the budget counts every one of them, and an over-budget continuation still refuses
rather than clipping a single line.

What's deliberately absent: the parent's full events (invariant 2 — citation not copying), any summary of a body (the model authors ranges, never text — invariant 4), any shared system-prompt edit (invariant 3). What's present because the numbers said so: **~102 tokens** for this index vs **~2,476** for the transcript it replaces — and every line is a door back to the full bytes ([§9](/concepts/archive-anatomy/)). The CORE RULES block rides under the title when you've approved some — verbatim, budget-capped, refuse-don't-clip ([§13](/knowledge/rules/)). With [#50](https://github.com/treeseed-ai/dsh-chapters/issues/50) the same builder feeds **two** places a head is rebuilt — this notice and the in-place compaction checkpoint (whose lead sections already carry the active plan and the working plot) — because a plan survived a `/compact` and a rule did not, which was the bug. Nothing is injected per request: invariant 3 keeps the global system prompt out, and on local hardware a head-position replacement reuses no cache. Empty set ⇒ zero bytes, exactly as today.

Next, the receipts: [19. Benchmarks](/evidence/benchmarks/).
