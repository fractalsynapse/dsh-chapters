# Chapter Removal — design record (issue #255)

Date: 2026-11-02. Decided with the maintainer across three brainstorming rounds in the session
that archived this design; approved plan at `docs/superpowers/plans/2026-11-02-chapter-removal.md`.

## Intent and the why

Operators mistype prompts meant for another project into a project session. When that session
archives, the contaminated turns become chapters that flow through every derived surface from that
point on — TOCs, index shards, search, enrichment. The maintainer asked for the ability to see the
active chapters of a session and **spot-delete** the bad ones, removing the chapter *everywhere it
matters*: file, metadata, artifacts, and references.

The bar the maintainer set, in their words: removal must be *actual* — "I want the bad chapters
actually removed" — and the project guidance must accept that **removal can be good when the data
is bad**. What matters is the generated TOCs from that point on; git history of the pool and other
chapters that happen to cite the removed file are acceptable residue. An open question the
maintainer raised themselves: a log of missing-chapter access from other chapters, so they can
decide whether those referrers need to stay too.

## Goals

1. `/chapters-remove` — operator-only command: `list` (active TOC view with canonical ids),
   `find <query>` (project pool-mirror search), `[dry-run] <ids…>`, `apply <ids…>`, `report`,
   `restore <journalId>`.
2. `apply` deletes the chapter file, its **orphaned** artifacts and plan docs, from the store AND
   the pool mirror clone (so the deletion publishes and the derived index regenerates clean), and
   flips the registry record to a `status: 'removed'` stub.
3. No TOC, search result, or enrichment pass cites a removed chapter from that moment on —
   through the ONE predicate `isActiveChapter` (no second filter lists).
4. The archive watermark never rewinds: a removed chapter's span is never silently re-captured
   by an auto-archive moment.
5. Every removal is journaled; `restore` re-derives the chapter from the durable log through the
   same save core (a NEW number — identity is `(number, sha256)`).
6. Dangling citations of removed chapters are reported at removal time and logged thereafter
   (`removals/missing-access.log`), per the #61 rule that a detected failure is a delivered one.

## Non-goals

- Not a model-facing tool. The human made the mistake; the human pulls the trigger. This also
  keeps every model-visible prompt byte unchanged — no corpus/tape re-record (rig rule).
- Not scrubbing git history, already-seeded child-session TOCs, or other projects' stores.
  Invariant 1 (append-only durable log) is never bent.
- Not cross-machine tombstones: v1 guarantees correctness on the removing machine and on clones
  pulled after the deletion commit. A second machine holding a local copy can re-publish it; the
  follow-up is a removal fact carried in the per-session collections JSONL (which already syncs),
  consumed by `planStoreToRepo`. Filed as follow-up at PR time.

## Anti-goals (what would make this a failure)

- A removed chapter reappearing — via watermark rewind (re-archived span), via mirror rehydration,
  or via a stale put resurrecting the record. Each has a named test.
- Deleting bytes that a *surviving* chapter still references (shared content-addressed blobs).
- A destructive apply that cannot be explained or reversed: no journal written before the first
  unlink ⇒ refuse.

## Constraints (from AGENTS.md, load-bearing)

- Append-only durable log; registry mutation only through `store.mutate(sessionId, fn)`.
- Stored paths are one dialect: `sameStoredPath(a, b, cwd)`, never `===` (#69).
- One predicate per semantic decision (#59) — this feature extends `isActiveChapter`, it must not
  fork it; the hand-rolled `!== 'superseded'` in `src/enrich-wire.ts:195` is swept into the
  predicate as part of this change.
- Never bound reports loosely: caps are config rows, withheld counts are named (#117/#61).
- Three schema systems, never mixed: zod for domain records (`ChapterRecord`), plain specs for
  tool params, Schemastery for `Config`.
- Version bumps touch `package.json`, `src/version.ts`, and the lock root together
  (`loudness.test.ts` pins it); commit/PR bodies via files, never quoted args.

## The mechanics, as decided

**Why the stub survives deletion.** The watermark is `max(chapter.endSeq)` over all records in the
author session's row (`src/save-core.ts:187`, `src/tools.ts:559`, `src/continue-core.ts:279`).
Deleting the record outright rewinds the watermark and the next archive moment re-captures the
poisoned span — the exact failure the feature exists to prevent. So the record keeps `number`,
`startSeq`/`endSeq`, `path`, `sha256`, the artifact manifest (for orphan forensics and restore
re-counting), title, plus `status: 'removed'` and `removedAt`. The *bytes* are gone; the *span book
keeping* is not. `nextChapterNumber` never rewinds: numbers are never re-spent.

**Orphan math.** Artifacts are content-addressed and deduplicated across the subtree, so a blob is
deleted only when no *active* record in any session tree under the project's store root names it
(chapter `artifacts`, `plans[].artifactPath`, `planDocs[]`). `removed` stubs do not hold blobs
open — their references are exactly what the operator judged bad.

**Publish + rehydrate.** `publishIntoClone` only copies new files; a store-side deletion never
reaches the pool by itself, so `apply` unlinks the clone-relative paths directly and forces a sync
pass, letting `stageAllAndCommit` record `git rm` deletions. Independently,
`rehydrateStoreFromMirror` (which copies *absent* files back) gains a guard: names belonging to
`removed` stubs are never restored — closing the window between unlink and push, and protecting a
future `git checkout` of an old pool commit.

**Identifiers.** Canonical id is the registry `path` (workspace-relative, the #69 dialect).
`find` results (`chapters/<projectKey>/<session>/<file>` pool dialect) map through the
`<session>/<file>` tail; a TOC display ordinal from `list` is accepted alongside `list` output but
re-checked against the flat index at apply time. Unknown/ambiguous ids refuse with near candidates;
an id resolving outside this project's store root refuses outright.

**Dangling / missing-access.** At removal, scan every active chapter file (store and clone) plus
registry `plans` titles for citations of the removed filename; report + append to
`<store-root>/removals/missing-access.log`. Ongoing: where `collectEntries` mints
`"<path>: missing since archived"` warnings, also append a structured dead-citation line. The
report verb reads the log tail with the same cap discipline as repair reports.

**Restore.** Re-render the journaled span through the same save-core path repair already uses for
explicit-span re-derivation, commit as a NEW chapter number, flip the stub's tombstone into the
new record's lineage (`repairs: <n>`-style provenance), and journal the restore. A restore whose
render yields zero messages is refused (never-commit-an-empty-archive rule), not faked.

## Guidance amendment (docs-first deliverable)

AGENTS.md's Hard Rule currently says the store is append-only "with no exceptions" and damage is
"superseded, not repaired in place". It gains the sanctioned operator class beside #60 repair:
**removal of bad data** — bytes leave the store, the log stays, the stub keeps the watermark, and
the journal makes reversal re-derivable. The seven archive moments are untouched: removal is an
operator door, not a moment.
