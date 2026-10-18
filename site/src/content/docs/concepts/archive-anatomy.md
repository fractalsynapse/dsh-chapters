---
title: "9. Anatomy of the archive"
description: Every artifact the system writes, what lives where, and why the split is exactly as deep as it needs to be.
lastUpdated: true
---

Three durable layers, in three different places on purpose:

## 1. The workspace store — `read`-reachable text

```
.dsh-chapters/
  artifacts/<aa>/<sha256>.txt   # store-root blobs — content-addressed oversized tool results, shared across every session
  <root-session>/
    chapters/001-<slug>.md      # verbatim body + YAML frontmatter (title, seq range, body hash, topics; + subagent lineage when the author was a subagent)
    chapters/plan-001-<slug>.md # a session PLAN as its own document (kind: plan) — searchable as a plan
    artifacts/<aa>/<sha256>.txt # the same content-addressed scheme, one level down: what a CHAPTER defers
```

Three kinds of document, one store. Transcript chapters carry the conversation verbatim; **plan
documents** carry a submitted plan as a first-class, indexed file (`kind: plan`, its status, the
chapter that cites it, the blob sha holding the same bytes); curated **rules** live apart under
`rules/` because they are authored, not archived. Plan documents sit in `chapters/` deliberately: the
pool transport, the mirror rehydrate and the corpus index then carry them with no special casing, and
`chapters_search` answers *"what did we plan about X"* with the plan itself. Their numbering is its own
(`plan-NNN-`), so a plan can never consume a chapter number or reorder the table of contents.

Two directories, one citation form. A chapter prints `artifacts/aa/<sha>.txt` whether the blob sits at the
store root (arrival-time stubbing) or inside its own session tree (archive-time deferral, and every session
plan), and `chapters_artifact` searches both before it searches the pool mirror — measured 2026-10-09,
because the reader used to look in one place only and a deferred plan was unreachable on the machine that
wrote it.

A subagent's chapters are ordinary citizens of this layout: the child is its own root session, so its
archive lands in a tree of its own and nothing links it into the spawner's ancestry. What makes them
traceable is the frontmatter — `subagent: true` plus `parentSession: <id>`, copied from the child's durable
session header the host itself writes (`parentSession`, `origin: subagent`, `delegationDepth`,
`agentPreset`). A reader who finds a chapter by search can therefore tell, from the file alone, whose work
it was. See [15. Commands](/reference/commands/) for when that archive is written — automatically, at each
settlement of the child's run.

### What a chapter's Plans block looks like

A session plan is one `tool/call` argument (`exit_plan_mode`'s `plan` field) answered by one `tool/result`
that carries the human verdict. The renderer puts both in a labeled block **after** the verbatim transcript,
so the transcript stays exactly what the log said:

```markdown
## Plans in this chapter

### Plan — "Carry session plans into chapters" — APPROVED

- verdict: submitted seq 412 → answered seq 419: `{"approved":true} Plan approved — …`
- full text: `artifacts/8f/8f3a1c9d….txt` (18.4 KB ≈ 4.6K tok) — chapters_artifact 'toc' | 'search' | 'read'
- outline: Goal · Success criteria · Changes by subsystem · Tests · Assumptions
- head (first 900 chars, verbatim):
- plan mode ACTIVE from seq 118 (log event plan/mode)
- plan mode inactive from seq 141 (log event plan/mode) · at chapter end: inactive
```

That last line is measured, not obvious: **approving a plan exits plan mode**, and the host appends the
`inactive` flip inside the same turn — so a chapter ending after an approval correctly reports
`planMode: inactive`. The fold takes the last logged value, exactly like the harness's own projection.

The head is bounded; **the artifact is not** — every byte of the plan is stored, always, and the same
content-addressed dedup that serves oversized results serves it. `pending` (a review nobody answered) is a
status of its own and never prints as approval, and a `plan/mode` event is read and folded into
`planMode:` rather than dropped silently. The frontmatter declares what the block claims, and the
plan's complete text is written twice on purpose — once as the content-addressed blob a chapter can
cite without knowing any number, once as the `kind: plan` document the index can rank.
(`plans: [412:approved:8f3a1c9d]`), and the registry record carries the structured facts the child's notice
is built from. Why the whole design looks like this is in the repo's `docs/plans-carriage.md`.

Why the workspace: the model reloads chapters with its ordinary `read` tool, so the text must live where `read` reaches — a `$HOME` path can be reachable-but-not-writable or writable-but-not-readable; the workspace is the one place both guarantees hold. Content-addressing applies to the artifacts: identical tool results anywhere in the archive are stored **once**, at the store root — and since 0.1.4 they publish to the pool too, so a teammate's `chapters_artifact` read resolves the blob from the shared mirror when the local store doesn't hold it. Chapter bodies need no dedup — each is one validated, non-overlapping range of the log, so the same text never appears in two chapters.

## 2. The harness storage domain — bookkeeping

```
storages/dsh_chapters.json   (DSH home, plugin-owned domain)
```

Ancestry edges, chapter numbering, body hashes, per-session TOC bullet lists, registry of collections. Structured, atomic-ish, restart-safe. The rule of thumb everywhere in this system: **anything a human should `read` is a file in the workspace; anything a machine should join is the storage domain.** The corpus is grep-able by design, the ledger is transactional by necessity.

## 3. The pool + mirror — the transportable mind

A linked upstream ([§10](/knowledge/pool/)) holds `chapters/`, `artifacts/`, `rules/`, and the *derived* two-layer index (`index/` fragments stitched into ranked entries, `collections/`, `topics/vocabulary.json`). The local mirror (`.dsh-knowledge/` clone) is what search actually queries — so search quality is identical online, offline, git or TreeDX. Which brings us to the knowledge layer proper:

Part III — [The pool](/knowledge/pool/) · [Providers: git vs TreeDX](/knowledge/providers/) · [Search](/knowledge/search/) · [Rules & governance](/knowledge/rules/) · [Enrichment](/knowledge/enrichment/)
