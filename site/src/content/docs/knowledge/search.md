---
title: "12. Search"
description: How the two-layer index is built, what ranks, and why search quality is identical online and offline.
lastUpdated: true
---

`chapters_search` answers from **whichever corpus is real for this workspace right now**: the pool
**mirror** when a project is linked and pulled, and otherwise **this machine's own store** — so it behaves
identically offline, on git, or on TreeDX, and on a laptop that has never linked anything. Its inputs are
plain files you can grep either way, and the answer always says which door it came from.

## Two doors, one scorer

| door | when | paths it returns |
|---|---|---|
| pool mirror | a project is linked **and** pulled (`.dsh-knowledge/` exists) | `chapters/<project>/<session>/…`, `rules/<project>/…` |
| local store | nothing linked, or linked but not pulled yet, **or** the pool had no match | `.dsh-chapters/<session>/chapters/…`, `.dsh-chapters/rules/<harness>/…` |

Both call the same `rankEntries`, so a result cannot rank one way at home and another way in the pool —
that divergence is the reason there is one scorer rather than two implementations. Three deliberate
details:

- **The store holds three document kinds and search knows them apart**: transcript chapters, `kind: plan`
  directives, and curated rules. A plan is findable *as a plan*, by what it changes and by its status.
- **Artifacts are not indexed.** Deferred blobs answer to `chapters_artifact` (path or bare sha). Indexing
  them would be the second index the design record forbids, and their bytes are content-addressed anyway.
- **"Nothing matched" and "nothing here" are different answers.** The first means your query missed; the
  second means the workspace holds no archive at all. They imply different next actions, so they are
  reported differently (`documents` vs `empty`), never merged into one quiet `[]`.

## What's indexed

Search reads every chapter and rule file in the mirror, frontmatter first. The two-layer index around it:

**Layer 1 — curation facts.** Per-machine, append-only JSONL at `edits/<harnessId>/curation.jsonl`: topic aliases, pins, weights, groups, notes — and this machine's rule-approval facts. One writer per file, ever; zero conflicts by construction.

**Layer 2 — the derived index.** One shard per canonical topic (`index/<topic>.md`, alphabetical) plus a build manifest, rebuilt deterministically from the corpus at every sync. Incremental when nothing changed; a full rebuild from primaries is the recovery path — which is why divergence is recovery, not corruption.

**Stitching.** Legacy compaction fragments (pressure-sliced chapters titled "Earlier history" / "Conversation span") that sit adjacent within a session cohere into ONE search entry citing every member — nothing merged on disk, no chapter rewritten.

## What ranks

- **Lexical score**, deterministic and inspectable: topic hits ×2, title and summary ×1 each — a rule's body scores as its summary, and a category match adds 1.5. Recency only breaks ties (a fresh file that matched no term never ranks). Results pack to a token budget (`searchDefaultMaxTokens`, default 400) — the *shape* of the answer is bounded, the corpus is not, and `total` vs `shown` says when to raise the budget;
- **topic-awareness** — emergent vocabulary from the enrichment ladder ([§14](/knowledge/enrichment/)) aliases surface forms; candidates are applied only if `vocabApply` is on, so the default posture is *shadow, review, then enable*;
- **per-machine rule bonus** (`rulesCoreBonus`, default 0.15) — rules you approved *on this machine* rank their categories higher; teammates get their own ranking from their own approvals.
- **one scorer for the corpus, one selector for the head** ([#50](https://github.com/treeseed-ai/dsh-chapters/issues/50)) — `rankEntries` ranks the unbounded archive (rules are ordinary `kind: rule` entries in it); `rules.selectRules` picks the bounded set a rebuilt head or the `chapters_rules` door renders, and the head and the door share that one selector. Two jobs, one implementation each — plus a row that fails if a third rule-picker appears. Scope differs by tier, and that is the trap: project rules arrive from the pool mirror under `rules/<projectKey>/…`, while session rules live in the local store under `rules/<harness>/…` with **no projectKey prefix** (they are never staged). A path-prefix filter alone would make the session tier invisible to the door whose job is to find it, so session rules are scoped by the ancestry activation predicate instead.

## Why the receipts in the answer

Each hit cites `chapters/<key>/…md` — a path to verbatim text, not a paragraph to trust. That closes the loop back to the archive: search is the address book, `read` is the retrieval, and the guarantee stays "every byte remains retrievable." The [field study](/evidence/field-study/) watched agents follow chapter paths with `read` 49/49 times.

Continue: [Rules & governance](/knowledge/rules/).
