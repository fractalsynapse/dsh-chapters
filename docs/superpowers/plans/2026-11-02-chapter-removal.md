# Chapter Removal (`/chapters-remove`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operator command that actually deletes bad chapters (file, orphaned artifacts, plan docs, mirror copy) from a project store, leaving a `removed` stub so the watermark holds and no derived surface re-cites the chapter; journalled, re-derivable undo. Ships as 0.2.17.

**Architecture:** Registry widening (`status: 'superseded' | 'removed'` through the one `isActiveChapter` predicate) + a pure `src/removal.ts` core (resolve → plan → journal → unlink → mutate-stub → force sync) wired into `src/commands.ts` beside `chapters-status`. Sync gains clone-side unlinking and a rehydrate guard; dangling citations are reported and logged; restore re-renders the span through the save core repair already uses.

**Tech Stack:** TypeScript, zod (domain records), Node ≥ 24 test loop, host slash-command plane (`CommandResult`), git provider (`stageAllAndCommit`).

**Spec:** `docs/superpowers/specs/2026-11-02-chapter-removal-design.md` — read it first; the plan argues from it.

## Global Constraints

- Durable log append-only (Invariant 1); registry writes only via `store.mutate(sessionId, fn)`; never put a snapshot (#59).
- Stored paths: mint with `toStoredPath`, compare with `sameStoredPath` — never `===` (#69).
- One predicate per semantic decision: all active-chapter filtering goes through `isActiveChapter`; no second status list may appear (#59 rule; enrich-wire.ts:195 gets swept).
- Never commit an archive that rendered nothing (`stats.messages === 0` over `events > 0` is a refusal, before any number is spent).
- Report caps are config rows; withheld lines are named, never silent (#117). Diagnostics and warnings must reach a human or a file (#61).
- No model-visible prompt bytes change ⇒ no e2e corpus/tape re-record; the acceptance job's nine model-free legs must stay green untouched.
- Commits/PR bodies through files (`git commit -F`, `--body-file`), never quoted args with backticks.
- Version bump = `package.json` + `src/version.ts` + lock root together; `tests/unit/loudness.test.ts` pins `PLUGIN_VERSION === pkg.version`.
- Both typechecks green: `npm run typecheck` and `npm run typecheck:client`.
- Node ≥ 24 for test runs; on older node every suite fails misleadingly — check `node --version` first.

## Review Focus

(Each line gets its pinning test in the named task.)

1. Shared content-addressed artifact still referenced by a surviving chapter → must NOT be deleted (Task 3).
2. Removing the **tail** chapter → watermark still `max(endSeq)` over stubs; next auto-save archives only seqs above the removed span, never re-captures it (Task 2).
3. Sync pass running between unlink and push → `rehydrateStoreFromMirror` does not resurrect removed names (Task 4).
4. `find` result pool path and a registry path naming the same chapter → resolve to one record; ambiguous or cross-project ids refuse with candidates (Task 3).
5. `apply` interrupted (journal write fails, or first unlink succeeds and a second throws) → nothing applied without a journal; partial apply is listed by bytes and named in output and journal (Task 3).

---

### Task 0: Issue, branch, docs commit

- [ ] Issue #255 exists; branch `feature/255-chapter-removal` from latest `origin/staging`.
- [ ] Commit the spec (this plan's source doc) + this plan file: `docs: chapter-removal design record and implementation plan (#255)` via `git commit -F`.

### Task 1: Documentation FIRST

**Files:**
- Modify: `AGENTS.md` (Hard Rules: the append-only bullet gains the sanctioned removal class; What-This-Is/Storage tables stay truthful)
- Modify: `docs/architecture.md` (integrity/storage section), `docs/knowledge-repo.md` (amendment: deletions in the transport layer + follow-up tombstone note), `docs/verify.md` (manual procedures), one new numbered site page in `site/src/content/docs/` (§29) + cross-link from the repair page; README doorway line.

- [ ] Write the guidance amendment exactly as the spec's last section frames it: bad bytes leave the memory; the log stays; the stub keeps the watermark; the journal makes reversal re-derivable; removal is an operator door, not an eighth archive moment.
- [ ] Site page documents the verbs, identifiers, what is deleted at each layer, the dangling/missing-access log, restore semantics, and the single-machine v1 bar with the multi-machine follow-up named.
- [ ] `docs/verify.md`: rows for each acceptance criterion with the command or fixture that proves it.
- [ ] Commit `docs: chapter-removal guidance amendment and operator manual (#255)`; check the issue's docs checkbox.

### Task 2: Registry widening — one predicate

**Files:**
- Modify: `src/archive.ts` (`ChapterRecord`, ~:76), `src/registry.ts` (`isActiveChapter`, ~:213), `src/store.ts` (zod `chapterRecordSchema`), `src/enrich-wire.ts` (~:195 filter → predicate), `src/render.ts` if the stub needs a shape note.
- Test: `tests/unit/registry.test.ts` (new rows), plus touched rows in `tests/unit/continue.test.ts` / enrichment suites.

**Interfaces:**
- Produces: `isActiveChapter(c: { status?: 'superseded' | 'removed' }): boolean` (excludes both); `ChapterRecord.status?: 'superseded' | 'removed'`; `ChapterRecord.removedAt?: string`.

- [ ] **Step 1 (failing tests):** (a) zod round-trips a record with `status:'removed'` + `removedAt`; (b) `buildIndex`/`collectEntries` exclude a `removed` stub and keep `superseded` excluded; (c) watermark math over `[{endSeq:50,status:'removed'}]` yields 50 — assert at the three reduce sites' shared helper or via a small pure function `archiveWatermark(records)` (already exists in continue-core.ts:447 — reuse; extend it, do not duplicate); (d) enrichment candidate scan excludes `removed` (replaces the inline string compare at enrich-wire.ts:195).
- [ ] **Step 2:** run, watch fail.
- [ ] **Step 3:** implement the widening; sweep `enrich-wire.ts:195` to `isActiveChapter`; add `status` to zod as `z.enum(['superseded', 'removed']).optional()` and `removedAt` as `z.string().datetime().optional()` (Optional-with-default precedent: old rows parse unchanged).
- [ ] **Step 4:** run green; `npm run typecheck`.
- [ ] **Step 5:** commit `feat: registry status 'removed' behind the one active-chapter predicate (#255)`.

### Task 3: Removal core — `src/removal.ts`

**Files:**
- Create: `src/removal.ts`; Test: `tests/unit/removal.test.ts` (+ fixture helpers copied from repair test patterns).

**Interfaces (produced for Tasks 4–7):**
```ts
export interface RemovalPorts { fs: () => FsLike; store: RegistryStore; storeRoot: string; cwd: string; now: () => string }
export type RemovalId = { sessionId: string; number: number }
export function resolveRemovalId(raw: string, rows: Iterable<[string, SessionState]>, cwd: string): { sessionId: string; record: ChapterRecord } | { refusal: string }
export function planRemoval(plan: { target: { sessionId: string; record: ChapterRecord }[]; rows: Iterable<[string, SessionState]>; fs: ...; storeRoot: string; cwd: string }): { removals: RemovalEntry[]; dangling: DanglingRef[]; refused: string[] }
export function applyRemoval(ports: RemovalPorts, plan: ReturnType<typeof planRemoval>): Promise<{ journalId: string; removed: string[]; problems: string[] }>
export function scanDangling(fs, roots: string[], needles: string[]): DanglingRef[]
export function appendMissingAccess(storeRoot: string, lines: string[]): void
```

- [ ] **Step 1 (failing unit tests)** — names and assertions:
  - `resolveRemovalId accepts registry path / pool path / "<sessionId>:<number>" / bare number against the display index`
  - `resolveRemovalId refuses unknown id naming near candidates` ; `refuses ambiguous pool path hitting two sessions` ; `refuses a path under a different store root (cross-project)`
  - `planRemoval keeps an artifact blob still named by an ACTIVE record; deletes one named only by removed/none` (two records sharing sha, one active)
  - `planRemoval includes planDocs + plan artifactPath files in the deletion set`
  - `planRemoval dangling scan reports a surviving chapter whose body cites "007-evil.md"`
  - `applyRemoval writes the journal BEFORE the first unlink (throw on journal write ⇒ zero unlinks, record unmutated)`
  - `applyRemoval partial failure lists what went and journals it (second unlink throws)`
  - `applyRemoval mutates through store.mutate and leaves a stub: number/startSeq/endSeq/path/sha256/artifacts kept, status 'removed', removedAt set`
- [ ] **Step 2:** run to fail.
- [ ] **Step 3:** implement. Notes for choices the tests don't fix: journal lives at `<storeRoot>/<rootSession>/removals/<journalId>.json` with the `repair-run.ts:196-247` write-ahead pattern (same `journalId` format); needles for the dangling scan = removed filename basename + registry path (match via `sameStoredPath` for path arms, substring for body-citation arms); store-root scoping = `resolveStoreRoot`-adjacent path prefix check.
- [ ] **Step 4:** green; commit `feat: removal core — resolve/plan/journal/apply with orphan-artifact math (#255)`.

### Task 4: Sync correctness

**Files:**
- Modify: `src/sync.ts` (`rehydrateStoreFromMirror` ~:488 + its caller in `runSync`; possibly a `removedNames` set threaded from registry rows read by the sync pass), `src/removal.ts` (clone-side unlink in `applyRemoval` behind a `cloneDir?: string` port; force-sync trigger).
- Test: `tests/integration/sync.test.ts` new rows + `tests/unit/removal.test.ts` clone-arm rows.

- [ ] **Step 1 (failing):** (a) given a mirror clone containing `chapters/<key>/<s>/007-x.md` and a store stub naming it removed, `rehydrateStoreFromMirror` restores zero files; (b) after clone unlink, `buildIndexInClone` output no longer contains the removed entry; (c) stale topic shard cleanup on the `changed=true` branch (read the current behavior first — if shards for vanished topics already get removed, pin it with a test instead of writing code).
- [ ] **Step 2:** run to fail.
- [ ] **Step 3:** implement guard + unlink arms; keep the copy-only invariant of `publishIntoClone` (deletions are done by the removal, not the publisher — the doc comment in sync.ts must say so).
- [ ] **Step 4:** green (integration sync suites on Node ≥ 24 — check `node --version`); commit `feat: deletions publish to the pool and the mirror never rehydrates them (#255)`.

### Task 5: Missing-access log

**Files:**
- Modify: `src/removal.ts` (apply writes dangling lines to `<storeRoot>/removals/missing-access.log`), `src/continue-core.ts`/`src/prompt.ts` where `verifyChapter` mints `"<path>: missing since archived"` — emit a structured dead-citation line there too (grep both call sites; the delivery must not depend on the caller reading `warnings`).
- Test: `tests/unit/removal.test.ts` append rows + `tests/integration/` TOC-build row.

- [ ] **Step 1 (failing):** `removal appends dangling report lines "ts | removed=<path> | referrer=<path> | how=cited-in-body"` ; `collectEntries marks a chapter missing and appends a dead-citation line naming the citing session`.
- [ ] **Step 2:** run to fail. **Step 3:** implement; confirm the #61 diagnostics sink already receives the warning text (it does for doors — verify, don't assume). **Step 4:** green; commit `feat: missing-access log for removed-chapter citations (#255)`.

### Task 6: `/chapters-remove` command wiring

**Files:**
- Modify: `src/commands.ts` (new command object; shape = `statusCommand` :271-…), `src/index.ts` (registration + config plumbing; report cap row e.g. `removalReportMaxLines` defaulting to `repairReportMaxLines`'s value), `src/diag.ts` if a status line helper is wanted.
- Test: `tests/integration/commands-removal.test.ts` (fixture store: 3 sessions, 5 chapters, one linked project with a throwaway loopback remote; port-keyed temp homes per rig rules).

- [ ] **Step 1 (failing integration):** verbs — `list` prints flat ancestor index with canonical ids + statuses; `find` returns pool-scoped hits; `dry-run` prints deletion set + dangling report + `NOTHING WRITTEN`; `apply` journals and reports counts; `report` tails the log with the cap and withheld count named; unknown verb/args refuse without touching state; no-session/no-cwd invocation refuses cleanly.
- [ ] **Step 2–4:** implement the handler against the core; green; commit `feat: /chapters-remove operator command (#255)`.
- [ ] `/chapters-status` addition (one line, printed in EVERY state incl. unlinked): `Removals (this project): N removed stub(s); missing-access log: <path or 'empty'>`. Test it renders in the unlinked case.

### Task 7: Restore = re-derivation

**Files:**
- Modify: `src/removal.ts` (`restoreRemoval(ports, journalId)`), reuse the explicit-span seam `src/save-core.ts` exposes to repair (`spanOverride`, see save-core ~:70/:189 and `repair-run.ts` usage).
- Test: `tests/integration/removal-restore.test.ts` with a synthetic durable log (deterministic bulk per rig rules — no model).

- [ ] **Step 1 (failing):** `restore re-renders the journaled span at a NEW number, chapter bytes sha-match the journal's recorded sha256`; `restore of a span whose render yields zero messages refuses, stub untouched`; `restore is journaled (second journal entry, or appended to the same file)`; `restore after supersede-by-repair of the same span refuses and says why`.
- [ ] **Step 2–4:** implement, green; commit `feat: /chapters-remove restore re-derives a removed chapter from the durable log (#255)`.

### Task 8: Full deterministic verification — run ONCE

- [ ] Confirm `node --version` ≥ 24 (if not, find the pinned runtime — the local-llm/dev-platform docs name the rig; do not trust red suites on 22.x).
- [ ] `npm run typecheck && npm run typecheck:client && npm test` — all green.
- [ ] `git diff origin/staging -- tests/e2e` shows **no** changes to model-visible prompts/tool descriptions ⇒ no re-record; the CI acceptance job must run its nine model-free legs untouched as proof.
- [ ] `node scripts/check-env-parity.mjs` — note drift for the maintainer's install step (do not force the live home).

### Task 9: PR → staging → RC (stop at the maintainer's gate)

- [ ] `git fetch origin staging && git merge origin/staging` into the branch; resolve; push.
- [ ] Check every acceptance box in #255 with evidence (test names / CI run ids); post the final progress comment.
- [ ] PR to `staging` per template via `--body-file`, title `feat: /chapters-remove — spot-delete contaminated chapters (#255)`, `Closes #255`.
- [ ] CI green ⇒ squash-merge to staging (agents may).
- [ ] Bump `0.2.17` (three files together) `chore: release 0.2.17 — /chapters-remove (#255)`; open RC PR `staging → main` (`Release candidate: 0.2.17`, `Changes since 0.2.16`).
- [ ] **Do not merge or tag.** File the cross-machine-tombstone follow-up issue; link it in the RC body and the design doc. Hand the maintainer: parity script output + a note that BOTH of their harnesses need a restart to load the new copy.
