---
title: "13. Rules & governance"
description: Two tiers of durable agent steering — team-approved project rules that survive every checkout, and session rules captured from what you actually type.
lastUpdated: true
---

> **Status.** Everything under *Project rules* ships today. Everything under *Session rules* is the
> design approved in [#50](https://github.com/treeseed-ai/dsh-chapters/issues/50) and specified in
> [the record §7](https://github.com/treeseed-ai/dsh-chapters/blob/main/docs/knowledge-repo.md) —
> it is documented here first because the docs are the interface lock, not because the behavior is
> live. Where the two differ, this page says which is which.

Rules are short, category-tagged instructions — "check the archive before starting", "always run the
tape replay before tagging" — the steering wheel for agent behavior on a project. They are **chapters
of a different kind**: the same file format, the same write-once store, the same index, the same
search. There is no second rules system to keep in sync.

## The problem the tiers solve

A rule you type into a chat request is real conversation — it is in the durable log — but it is not
*carried*. When the head of a session gets rebuilt, the plugin re-states the working plot and the
active plan into the new head, and it did not re-state rules. So rules faded: at a compaction, and at
every continuation unless someone had deliberately promoted them. Two tiers, one for each direction
that pain comes from:

| | **Project rules** | **Session rules** |
|---|---|---|
| Who writes them | a person, with `/chapters-rule add` (or an agent proposing) | captured for you — the `ADD RULE:` marker, optionally the model |
| Who they bind | this machine, after a human here approves | your session tree only |
| Where they live | the shared pool (git or TreeDX) | the local store — **never staged to the pool** |
| Reach a branch (`chapters_fork`) | yes | no — a branch is a new direction, not an order |
| Reach a continuation / compaction | yes | yes |

## Project rules

1. **Propose** — `/chapters-rule add <category> "<text>"` (or the model's own
   `chapters_rule_propose` tool). The file is **write-once**: proposed rules are never edited in
   place; you amend with a new id. Proposed rules bind *nothing*.
2. **Review** — `/chapters-rule list [--proposed|--all|--category <c>]`.
3. **Approve** — `/chapters-rule approve <id>` — and this is the load-bearing word.

### Approval is a per-machine curation fact, never a shared rewrite

The single design decision that makes team memory survivable: **approval never rewrites a shared
file**. It is recorded as a machine-local curation fact keyed by your `harnessId` — the same principle
as shadow-by-default vocabulary, and its opposite is every "team prompt" system that turns one
person's `git push` into instructions *everywhere*. On your machine you approve the rules that bind
your agents; a teammate decides their own; nobody governs the other by committing text. `revoke` is
the same fact withdrawn.

### They already carry across your checkouts

Project rules are keyed by `projectKey`, which is derived from the repository's **remote URL**, not
from a directory path. So five clones of one repo on one machine see one rule set, and every
teammate's clone sees the same rule *files* — only the approval status stays per-machine. No global
tier is needed for that, and none was built: a namespace that spans different projects would put one
team's rules in another team's prompts.

What *can* go wrong is identity silently disagreeing — a checkout with no readable remote falls back
to a path-derived key and gets a private rule set, a checkout whose first remote is a fork derives a
different key, a pool linked through TreeDX keys on the pool location rather than your remote, and a
fresh clone that has not been linked or synced has no rules at all. Those four are reported, not
inferred: the head states `0 project rules — this checkout resolves project … from …`, and
`/chapters-status` reports `projectKeySource`. Ungoverned must never look like governed.

## Session rules *(specified in #50)*

### Capture, at two deliberate speeds

- **`ADD RULE: <text>`** at the start of a line in one of your own messages becomes an active
  session rule immediately, with **zero model tokens** — a deterministic parse on the same turn
  boundary the topic signatures use. The rule body is your sentence, verbatim.
- **Model capture** is a setting (`rulesEnrichment`, off by default) riding the existing
  idle-batched enrichment pass. It runs *after* a chapter is archived, so a model-derived rule
  arrives at the next boundary, not mid-turn — the local model server is single-slot, and per-turn
  work would queue against your own conversation. **A model-derived rule only auto-activates when it
  quotes your own words verbatim**; anything it inferred with no sentence behind it waits as
  proposed. The model never writes to the store: it proposes, the plugin commits.

Activation for this tier is **derived, not approved**: a session rule is active when it is scoped
`session`, belongs to a session on your current ancestry, and has not been revoked. No approval step,
because it governs only your session tree and never leaves the machine.

### Carried at the moments the head is rebuilt

Session rules ride into a continuation notice and into an in-place compaction checkpoint, next to the
plot and the active plan; a fork carries project rules only. They are **not** injected into every
request, which is a measured choice rather than a stylistic one: the global system prompt is off
limits by invariant 3, and on local hardware replacing a block at the head of the prompt reuses no
cache at all — a ruleset that churns mid-session would be a cache-wipe machine on exactly the
hardware this project is for. Between rebuilds your original wording is still in the context; what it
could not survive was the rebuild, and that is what is fixed.

### Kept inside the budget, visibly

Automatic capture means the active set grows on its own, so "render everything" stops being
affordable. Selection has three classes: **pinned** rules (a human pins them; always rendered —
ground rules are old, and any topical or recency ranking evicts them first), **relevance-selected**
rules (the same scorer `chapters_search` uses, never a second one), and **index-only** rules shown
as a one-line category entry with a path. Per-tier counts are configurable, and anything the caps
drop is **announced with numbers** — `9 project rules active, 4 shown — /chapters-rule list`.
Selection that could silently drop the load-bearing rule would just rebuild the original bug inside
the fix. The token ceiling keeps the old doctrine: over budget it refuses with per-rule numbers, it
never clips.

## Conflicts

Two live tiers means two sources of "must", and a small model handles a contradiction badly. The
rule is stated to the model in the block itself: **project rules are the team's order; session rules
refine and add; a session rule never overrides a project rule.** `/chapters-rule conflicts` reads the
assembled set and reports contradictory pairs with ids — one bounded model call, report-only, never an
edit. Enrichment may flag the same pairs in its own pass. Your two options on a conflict are to
promote a fix to the project rule or revoke the session rule; nothing resolves itself.

## What the agent sees

Deliberately little. Capture, activation, budgeting and carriage happen without the model doing
anything — no bookkeeping it can get wrong, no command it has to remember. The one behavior that
*is* encouraged, in every rebuilt head, is to **look the rules up before starting a task**:
`chapters_rules` with the task description returns the text of the rules that actually apply. That is
the only rule verb a session is asked to reach for, because a tool an instruction never names does not
exist to a small model.

## Search tie-in

Rules your *own* machine has core-approved get a small rank bonus in search (`rulesCoreBonus`) —
computed per machine at query time, never baked into the shared index shards — so retrieval is tuned
to each machine's governance state without any shared ranking.

Continue: [Enrichment ladder](/knowledge/enrichment/).
