---
title: "2. Your first continuation"
description: What the archive actually is, what the new session opens with, and how retrieval works — end to end, with real payloads.
lastUpdated: true
---

## What gets written

A continuation archives ranges of the session log as numbered Markdown chapters — verbatim text, generated
by the plugin copying the log. Where the ranges come from is the only thing that differs by route: a **click
or a command** (*Continue with chapters*, `/chapters-continue`, and their branch twins) derives them in the
plugin with **zero model involvement**, while the **model's own path** proposes them from
`chapters_segment`. Either way the model never authors the body and is never asked to summarize. Plus a
durable registry entry, and for oversized tool results, artifact files. On disk in your project:

```
.dsh-chapters/
  artifacts/8f/8f3a1c….txt      # content-addressed, deduplicated, shared across sessions
  <root-session-id>/
    chapters/001-deeply-analyze-this-project-and-describe-it-for-.md
    chapters/002-earlier-history.md
```

Chapter files are plain Markdown with YAML frontmatter — open them, grep them, commit them. They are not a proprietary format; the archive outlives the plugin.

## What the new session opens with

The continuation is a brand-new session whose first message is a **Table of Contents notice** — annotated anatomy in [§18](/reference/notice/); the condensed shape:

```
# Continuation: <title you/agent gave>

[core rules, if any are approved on this machine]

This session continues an archived conversation. Chapters are verbatim Markdown in the workspace;
every byte remains retrievable — inline, or at artifact paths cited inside a chapter. Read a chapter
by its path with the read tool when the detail matters. The previous session stays intact.

## In flight
<State of play — your handoff note>

## Chapters
1. [Deeply analyze this project…](.dsh-chapters/<root>/chapters/001-….md) — <summary> (33 msgs)
2. [Earlier history](.dsh-chapters/<root>/chapters/002-….md) — <summary> (18 msgs)

## Finding things
- Chapter detail: open its path above with the read tool.
- A deferred tool result: chapters_artifact (the path, or the bare sha a chapter cites) — action 'toc' | 'search' | 'read'.
- Anything else on this project — other sessions' work, archived plans (`kind: plan`), curated rules: chapters_search.
- Before starting a task: chapters_rules with the task description — it returns the rules that actually apply, and says what it withheld.

Ancestry: root <root-id>; parent <parent-id>; archive under .dsh-chapters/.

## First response
Acknowledge in one short sentence and wait for the human's next message. Do not call tools in your first turn.
```

Four optional blocks above the fold may or may not appear: the **CORE RULES** this machine approved, the
**operative plan** (continuations only — a *branch* is handed zero plan bytes), a carried **## Goal**
block, and a **## Task list** snapshot. The four **Finding things** verbs are there because a tool the
child was never told about does not exist to it.
[§18](/reference/notice/) annotates the real shape line by line.

Measured size: **~102 tokens of index where the replaced transcript ran ~2,476** — and unlike a summary, every line is a *path to verbatim text*, not a paraphrase to trust.

## Retrieval is the model's normal behavior

The chapter list plus "reload with `read`" is all the instruction needed in practice — and the notice now
names the other lookup verbs too (`chapters_artifact` for deferred blobs, `chapters_search` for everything on
the project, `chapters_rules` for what applies before a task starts), because a tool an agent was never told about does not exist for it. In a real 10-session
production run, agents executed **49 archive retrievals — 49/49 successful, ~497 KB restored** — including a
child session re-consulting a 24K-token artifact three times *after* compaction had removed it from its
context. Tool output deferral works the same way: huge results arrive as a stub with a `chapters_artifact`
handle (`toc → search → read` windows) instead of eating the context.

## The parent survives

Nothing about the continuation modifies the old session: its log is append-only, its prompt cache is intact, and you can keep working in it, delete it, or fork from it again (branching is legal — history is a DAG; the TOC flattens it for the model, chronologically, with explicit back-links).

## The numbers version of this page

The same mechanics ran under fire in [§20, the field study](/evidence/field-study/): 21 compactions across 10 sessions, zero inference tokens spent compacting, zero lost spans, every session closed clean.

Next: [3. Link a knowledge pool](/start/link-pool/) — turning one session's memory into a team's.
