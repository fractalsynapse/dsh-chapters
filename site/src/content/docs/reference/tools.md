---
title: "16. Agent tools"
description: What the model can call, when it reaches for each, and the receipts that they actually fire.
lastUpdated: true
---

Seven tools ship, all schema-typed with output schemas (mandatory in this plugin). They mount **inside the `chapters` preset realm** (0.2.32, [#330](https://github.com/fractalsynapse/dsh-chapters/issues/330)): a session on any other preset does not see them — and neither do the deterministic door commands. That scoping is deliberate: a tool description is prompt text, and a host-plane registration would put the archive vocabulary in front of every agent on the machine, whatever preset it chose. The field study: agents called these — plus plain `read` on archive paths — **49 times, all successful**.

| Tool | What it does | When it gets reached for |
|---|---|---|
| `chapters_segment` | returns the archive ceiling + chapter-shaped ranges (title/summary editable, text never) | when the human asks to archive or continue |
| `chapters_continue` | archive the chosen ranges, open a new session whose first message is the cumulative TOC, carry a handoff note | the workhorse of continuation |
| `chapters_fork` | the same door's branch intent for the model: cites the existing archive, writes nothing (the human-pulled [`/chapters-fork`](/reference/commands/) archives the new span first) | "let's try another angle from here" |
| `chapters_search` | ranked hits from **whichever corpus is real here**: the pool mirror when one is pulled, otherwise this machine's own store — the answer names the door it came from, and plans are findable **as plans** (`kind: plan`) | at the start of any domain ("has anyone hit this?") |
| `chapters_artifact` | `toc / search / read` on content-addressed blobs kept as files | re-consulting stored results — after compaction, across windows — **and reading a session plan without swallowing it** |
| `chapters_rule_propose` | write-once rule candidate (still needs a human per-machine approve) | "we learned a team convention" |
| `chapters_rules` *(#50)* | the assembled **text** of the rules that apply to a task description — project + session tier, with the count it withheld. One scorer with `chapters_search`, never a second ranking | **before starting a task** — the one rule verb a head is told to reach for |

These are the model's surface, not the only way in: in **chapters-preset sessions** every assistant row
carries *Fork with chapters* and *Continue with chapters*, and the composer carries `/chapters-fork` and
`/chapters-continue` — one deterministic door with two intents, where the plugin derives the ranges itself
instead of asking the model to chain `chapters_segment` → `chapters_continue`. Same archive, same child,
same notice, and the intent alone decides what the child is told about plans ([§15](/reference/commands/)).
The doors and their commands ride the same realm row as the tools, so sessions on other presets show no
chapters door.

## What success returns

| Tool | Returns |
|---|---|
| `chapters_segment` | `archiveCeiling`, `eventCount`, `toolResults[{seq, toolName, excerpt, deferred}]`, `plans[{seq, title, status, resultSeq, outline, verdict}]`, `livePlans[…]` (above the ceiling — an unfinished turn, so archivable by nothing), `modeActive`, `existingChapters` |
| `chapters_continue` | `childSessionId`, `presetUsed`, `chapters`, `warnings[]` (coverage gaps, over-target chapters), `budget{usedTokens, allowanceTokens}` on refusal |
| `chapters_fork` | `childSessionId`, `presetUsed` |
| `chapters_search` | `results[{score, date, kind, title, path, topics}]`, `total`, `shown`, a `note` that names **which door answered** (pool mirror vs this machine's store) or says the list was trimmed, and `line` (the packed answer text) on the store door |
| `chapters_artifact` | per action — `toc`: heading map with line numbers; `search`: matched blocks + `totalMatches`/`truncated`/`remainingMatches`; `read`: `start`, `end`, `of`, `lines` |
| `chapters_rule_propose` | `ok`, `text` — the proposal reply |
| `chapters_rules` *(#50)* | `rules[{id, scope, category, text}]`, `shown`, `active` (per tier), `withheld` (count, with why) — the withheld count is returned even when nothing was withheld, so "you are seeing all of it" is a fact the model can rely on |

Every refusal shares one shape: `{ ok: false, reason, budget? }` — the numbers size **the notice the
plugin is composing** (its own artifact), never the model's window: since #330 the agent is never handed
a measurement of its own context. `chapters_artifact read` windows are 1-based (default 200 lines, hard
cap 400); `toc`/`search` pack to a default of 400 result units.

## The drill-down shape in practice

A child session in the field study met a 24K-token artifact, and after its first compaction the raw text was gone from context. What happened next, from the logs: `toc` on the artifact → five windowed `read` calls by line range (offsets 1, 400, 799, 1198, 1517) → and *later windows re-consulted the same blob again post-compaction*. Nobody wrote a "use artifacts" playbook step; the TOC and stub handles advertise themselves, and recursive retrieval is what a capable model does with them.

Next: [17. Configuration](/reference/configuration/).
