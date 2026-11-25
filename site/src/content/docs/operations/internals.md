---
title: "25. Internals map"
description: Where the machinery lives in the repo — for agents and humans who want the source of truth, not the paraphrase.
lastUpdated: true
---

The plugin is small because the rules are strict. One glance at the module map:

| Module | Job |
|---|---|
| `src/index.ts` | plugin entry (host plane): the operator doors `/chapters-repair` + `/chapters-restore`, the knowledge-layer commands' wiring, the config schema (the host-plane reference), and preset VERIFICATION — delivery moved to `src/preset.ts` with 0.1.18; `installChaptersPreset` is inert |
| `src/preset.ts` | the `preset-chapters` declaration row: mirrors the host's agent-preset plugin line, and owns the two host-conditional decision families — rows the host cannot import are dropped-and-named at boot (#445), platform-eligible rows ride `PLATFORM_ELIGIBLE` in code, never `!!js` in YAML (#537); with #526 it also appends VERSIONED_ROWS dynamically, gated on the host's own exports map |
| `src/tools-row.ts` | the realm row module: mounts the seven `chapters_*` tools and the three door commands INSIDE the chapters preset (0.2.32, #330 — nothing model-visible registers process-globally) |
| `src/engine-core.ts` | pure engine: `planSummarize` (deterministic checkpoint + carried plot), `buildFinalizedChapters`, `extractPlot` (the contract-shaped matcher) |
| `src/engine.ts` | cordis subclass: pre-step wiring, arrival stubs, elicitation, finalization-after-commit |
| `src/render.ts` + `src/injections.ts` | verbatim chapter bodies; the host-injection screen (mark-and-exclude so counts are truth) |
| `src/continue-core.ts` | the TOC notice composer (ancestry flattened chronologically, budget preflight refusing with numbers) |
| `src/sync.ts` / `src/provider.ts` | the sync loop (offline degrade, divergence rebuild) and the six-verb provider seam |
| `src/gitops.ts` / `src/treedx/` | the two transports (isomorphic-git; TreeDX workspace→overlay→commit) |
| `src/indexing.ts` / `src/search.ts` / `src/vocabulary.ts` / `src/enrich-wire.ts` / `src/rules.ts` | the knowledge layer: derived index, ranked search, shadow vocabulary, enrichment ladder, per-machine rule ledger |
| `src/plans.ts` | session-plan facts: pairs each `exit_plan_mode` call with the `tool/result` carrying the human verdict, folds `plan/mode`, and renders the notice's `## Active plan` / `## Previous plans on this path` block (the `kind: plan` document itself is written by `src/archive.ts` and numbered by the registry — a plan never consumes a chapter number) |
| `src/client/` | browser plane: both door buttons on assistant rows — a two-row table and ONE runner (`doors.ts`), so the branch and the continuation cannot drift into two implementations |
| `tests/unit` + `tests/integration` | the deterministic suite (zero skips when services are up — skips are treated as defects; the row count lives in the release ledger on [§26](/operations/changelog/), not on this page, because a typed count goes stale on the next commit) |
| `tests/e2e` + `tests/fixtures/model-tape/` | twelve model-free replay legs (`scripts/chain-replay.sh`: suite arrival enrich fanout rules fork plans prompt prompt-off prompt-revival reload compose), each one boot per journey, replayed from committed model tapes; a miss is a loud refusal, never a silent hosted recording |

Deep prose lives in the repo docs: `docs/architecture.md` (mechanics & decisions), `docs/knowledge-repo.md` (the governing design record with amendments), `docs/provider.md` (transport truth table), `docs/host-compaction-seam.md` (the harness integration surface), `docs/verify.md` (every claim's verification procedure). The archive's rule applies to this site too: **links over paraphrases.**

Next: [26. Changelog & release notes](/operations/changelog/).
