---
title: "16. Agent tools"
description: What the model can call, when it reaches for each, and the receipts that they actually fire.
lastUpdated: true
---

Six tools ship today, all schema-typed with output schemas (mandatory in this plugin). The field study: agents called these — plus plain `read` on archive paths — **49 times, all successful**. A seventh, `chapters_rules`, is specified in [#50](https://github.com/treeseed-ai/dsh-chapters/issues/50) and marked below as such.

| Tool | What it does | When the model reaches |
|---|---|---|
| `chapters_segment` | returns the archive ceiling + chapter-shaped ranges (title/summary editable, text never) | "we're expensive — what can we archive?" |
| `chapters_continue` | archive the chosen ranges, open a new session whose first message is the cumulative TOC, carry a handoff note | the workhorse of continuation |
| `chapters_fork` | the same door's branch intent for the model: cites the existing archive, writes nothing (the human-pulled [`/chapters-fork`](/reference/commands/) archives the new span first) | "let's try another angle from here" |
| `chapters_search` | ranked, token-bounded hits from **whichever corpus is real here**: the pool mirror when one is pulled, otherwise this machine's own store — the answer names the door it came from, and plans are findable **as plans** (`kind: plan`) | at the start of any domain ("has anyone hit this?") |
| `chapters_artifact` | `toc / search / read` on content-addressed blobs that never hit the window | re-consulting big results — after compaction, across windows — **and reading a session plan without swallowing it** |
| `chapters_rule_propose` | write-once rule candidate (still needs a human per-machine approve) | "we learned a team convention" |
| `chapters_rules` *(#50, not yet shipped)* | the assembled **text** of the rules that apply to a task description — project + session tier, within budget, with the count it withheld. One scorer with `chapters_search`, never a second ranking | **before starting a task** — the one rule verb a head is told to reach for |

These are the model's surface, not the only way in: **every assistant row carries *Fork with chapters*
and *Continue with chapters*, and the composer carries `/chapters-fork` and `/chapters-continue`** — one
deterministic door with two intents, where the plugin derives the ranges itself instead of asking the model
to chain `chapters_segment` → `chapters_continue`. Same archive, same child, same notice, and the intent
alone decides what the child is told about plans ([§15](/reference/commands/)).

## What success returns

| Tool | Returns |
|---|---|
| `chapters_segment` | `archiveCeiling`, `eventCount`, `toolResults[{seq, toolName, bytes, estimatedTokens, excerpt}]`, `plans[{seq, title, status, resultSeq, bytes, estimatedTokens, outline, verdict}]`, `livePlans[…]` (above the ceiling — an unfinished turn, so archivable by nothing), `modeActive`, `existingChapters`, `budgetHint` |
| `chapters_continue` | `childSessionId`, `presetUsed`, `chapters`, `warnings[]` (coverage gaps, over-target chapters), `budget` |
| `chapters_fork` | `childSessionId`, `presetUsed`, `budget` |
| `chapters_search` | `results[{score, date, kind, title, path, topics}]`, `total`, `shown`, `budget{requested, used, remaining}`, a `note` that names **which door answered** (pool mirror vs this machine's store) or says the list was trimmed to the budget, and `line` (the packed answer text) on the store door |
| `chapters_artifact` | per action — `toc`: heading map with line numbers; `search`: matched blocks + `totalMatches`/`truncated`/`remainingMatches`; `read`: `start`, `end`, `of`, `lines` |
| `chapters_rule_propose` | `ok`, `text` — the proposal reply |
| `chapters_rules` *(#50)* | `rules[{id, scope, category, text}]`, `shown`, `active` (per tier), `withheld` (count, with why), `budget` — the withheld count is returned even when nothing was withheld, so "you are seeing all of it" is a fact the model can rely on |

Every refusal shares one shape: `{ ok: false, reason, budget? }` — measured numbers, never a truncation. `chapters_artifact read` windows are 1-based (default 200 lines, hard cap 400); `toc`/`search` default to a 400-token packing budget.

## The drill-down shape in practice

A child session in the field study met a 24K-token artifact, and after its first compaction the raw text was gone from context. What happened next, from the logs: `toc` on the artifact → five windowed `read` calls by line range (offsets 1, 400, 799, 1198, 1517) → and *later windows re-consulted the same blob again post-compaction*. Nobody wrote a "use artifacts" playbook step; the TOC and stub handles advertise themselves, and recursive retrieval is what a capable model does with them.

Next: [17. Configuration](/reference/configuration/).
