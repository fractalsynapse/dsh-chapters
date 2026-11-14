---
title: "7. Continuation budget math"
description: Why the limit is a share of the space left after the header, and why "refuse with numbers" beats "truncate to fit".
lastUpdated: true
---

A continuation's cost is the **newly added** context: the Table of Contents plus the handoff note. The invariant that keeps it sane:

```
tocTokens + handoffNoteTokens  ≤  continuationBudgetRatio × (window − systemPromptTokens)
```

This math is the plugin's, about the artifact the plugin is composing — **it is never shown to the model as a reading of its own context** (#330; AGENTS § The Model Never Measures Its Context). A refusal names the notice size and the allowance; no agent-visible string states the window, its fill, or any estimate of session usage, because a model handed such numbers cannot verify them and will steer by the guess instead of the work.

Measured **before** the session is created. Over budget → **refuse, with per-rule numbers.** Never silently truncate.

## Why "after the header," not "of the window"

A 32K model with a ~9K system prompt and tool schemas has only ~23K of headroom. Budget the continuation as a fraction of the *whole* window and you make it unmeetable on exactly the small-context hardware the plugin exists for. Reserve a share of what **remains** — here `continuationBudgetRatio` defaults to **0.25**, so on 32K/9K the new content may use ~5.75K tokens, and the TOC that measured **~102 tokens** clears it with room to breathe.

## Why refuse rather than clip

A dropped or clipped handoff note is precisely the lossy behavior this whole project rejects. A summary can shrink; a *citation index* should stop short and say so — "TOC + note = 7,420 tokens over an allowance of 5,750 (0.25 × 23,000); trim the note or raise `continuationBudgetRatio`" — so the human decides deliberately. The same doctrine runs everywhere in the system: offline degrades to `local-only` **naming the failed step**; the rules section refuses with its overage and **never clips a rule**; an oversized tool result whose artifact write fails **inlines with the failure named**, never silently. Loud beats lossy, every time.

## The retention paradox, structurally avoided

In-place compaction has a corner where a message is too big to file and too new to keep — bounded refusal or forced truncation is the usual answer. dsh-chapters makes it unreachable: a monster tool result **never enters the window at all** — it is stubbed at arrival into `artifacts/` ([§9](/concepts/archive-anatomy/)), so the retention gate at the *rescue* stage is instead a *never-on-the-desk* gate. This is the Recursive-LM decomposition doing bookkeeping for us — next page.

Next: [8. Recursive context theory](/concepts/recursive-context/).
