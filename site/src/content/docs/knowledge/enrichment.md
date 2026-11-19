---
title: "14. Enrichment ladder"
description: The deferred annotator that keeps topics, summaries, and search fresh — and the only sanctioned mutation in a write-once system.
lastUpdated: true
---

Freshly archived chapters are *verbatim* but *unlabeled*: the archive is done, the labeling is background work. The enrichment ladder runs after pushes and on idle (trigger seam `enrichmentTrigger`/`enrichmentIdleMs`, defaults `both`/60 s), a bounded batch per pass (`enrichmentBatchCap`, default 5), on a model you choose (`enrichmentModel`; empty = the conversation route) — or **off** entirely (`enrichmentEnabled: false` makes the whole subsystem a pure no-op; the corpus stays fully functional, and signatures are model-free either way).

## The ladder

For each chapter: keep what's free (the deterministic topics already derived from the turn signatures — paths, commands, terms) → ask the model for the semantic layer (a better title, a 2–3-sentence summary, topic labels) only when the cheaper rung doesn't answer → **validate before commit** → write. Malformed output retries once; on a second failure the deterministic values survive untouched — a slow or failing model never blocks or blanks a chapter.

## The guard that makes it safe: the body hash

Every chapter's frontmatter carries a hash of its body. Enrichment is the **only** sanctioned mutation of a chapter file, and only ever to the metadata fields (title, summary, topics, provenance) — the body-hash guard rejects any write that would change the verbatim text. So "write-once archive" and "model annotates it later" coexist honestly: the *record* is immutable; the *label* is versioned with a provenance chain — `generated: <model>, <date>` stamped newest-first, so you can always see which annotation came from a model rather than the log.

## Emergent vocabulary stays in the dark until you flip a switch

New topic candidates accumulate as **shadow aliases** — they influence nothing and change nothing until `vocabApply: true` turns reviewed curation into git-visible `topic-alias` records (plus the derived `topics/vocabulary.json`). Shadow-by-default is the same governance posture as rules: *observe, review, then apply.*

## Driven by you

```
/chapters-enrich run                     # drain the queue now
/chapters-enrich model <provider>/<model-id>   # or: model clear  (back to conversation route)
/chapters-enrich report                  # what the ladder did, to which chapters, with provenance
```

That closes the knowledge layer. Next: the reference — [15. Commands](/reference/commands/).
