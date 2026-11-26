---
title: "14. Enrichment ladder"
description: The deferred annotator that keeps topics, summaries, and search fresh — and the only sanctioned mutation in a write-once system.
lastUpdated: true
---

Freshly archived chapters are *verbatim* but *unlabeled*: the archive is done, the labeling is background work. Since **#529** the ladder's main path is the **backlog chase**: every archive moment (continue, fork, save, compaction finalize, subagent settlement, forced child archive, operator repair) drains the WHOLE pending set in capped passes — a pass whose batch came back full (`enrichmentBatchCap`, default 5) schedules its own follow-up 5 s later, until a pass comes back short. Per-pass memory discipline is unchanged; only the waiting moved. A failing pass **stops** the chase (a loop hammering a broken model is the defect class this week ended twice), `dispose` stops it, and a manual `/chapters-enrich run` never chases. The idle sweeper (`enrichmentIdleMs`, default 60 s) remains as the fallback trigger, and the realm-row seam `enrichmentTrigger` (default `both`) still governs it — a busy session can no longer starve its own backlog. It runs on a model you choose (`enrichmentModel`; empty = the conversation route) — or **off** entirely (`enrichmentEnabled: false` makes the whole subsystem a pure no-op; the corpus stays fully functional, and signatures are model-free either way). The one auxiliary budget for all of it (annotation, mined rules, the conflicts report, recommendations) is `enrichmentMaxTokens` (default 4000 — sized for **reasoning** tokens, not just the visible answer).

## The ladder

For each chapter: keep what's free (the deterministic topics already derived from the turn signatures — paths, commands, terms) → ask the model for the semantic layer (a better title, a **detailed summary — one to three paragraphs**, topic labels) for every un-annotated non-empty chapter (the candidate gate is provenance, not sufficiency: a chapter qualifies unless its top title mark is `by: model` for the current model key) → **validate before commit** → write. Malformed output retries once; on a second failure the deterministic values survive untouched — a slow or failing model never blocks or blanks a chapter.

## The guard that makes it safe: the body hash

Every chapter's frontmatter carries a hash of its body. Enrichment is the **only** sanctioned mutation of a chapter file, and only ever to the metadata fields (title, summary, topics, provenance) — the body-hash guard rejects any write that would change the verbatim text. So "write-once archive" and "model annotates it later" coexist honestly: the *record* is immutable; the *label* is versioned with a provenance chain — `generated:` entries (`by: model`, `model:`, `at:`, `pluginVersion:`) stamped newest-first, so you can always see which annotation came from a model, and from which build, rather than the log.

## Emergent vocabulary stays in the dark until you flip a switch

New topic candidates accumulate as **shadow aliases** — they influence nothing and change nothing until `vocabApply: true` turns reviewed curation into git-visible `topic-alias` records (plus the derived `topics/vocabulary.json`). Shadow-by-default is the same governance posture as rules: *observe, review, then apply.*

## Driven by you

```
/chapters-enrich run                     # ONE capped batch now (up to enrichmentBatchCap) — the backlog chase belongs to the archive moments, not this verb
/chapters-enrich model                   # show the annotator route
/chapters-enrich model <provider>/<model-id>   # or: model clear  (back to conversation route; pending chapters re-qualify under the new key)
/chapters-enrich report                  # the ladder's status line (trigger, model, mining posture, last heartbeat) + pending chapter count
```

Per-chapter provenance lives in the chapter files themselves — the `generated:` blocks — which `report` deliberately does not reprint.

That closes the knowledge layer. Next: the reference — [15. Commands](/reference/commands/).

