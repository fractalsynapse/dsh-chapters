---
title: "6. The four invariants"
description: The non-negotiables every design decision follows from — each earned by a failure they prevent.
lastUpdated: true
---

**1. Never rewrite the durable session log.**
Append-only, always. Surface-span *shadowing* is permitted — in fact it is the shipped mechanism: `compaction/*` events are log-only, and the durable record stays append-only and fully auditable. Rewriting history is how memory products lose your trust the one time it matters.

**2. Never seed a continuation from the parent's history.**
A naive "fork" copies the parent's events into the child — context *grows* every generation and nothing ever compacts. The continuation is instead **unseeded but for one synthetic message: the TOC notice**. Citation, not copying — the whole economics of the system follow from this one line. **Amended 2026-11-05 (#319):** the child is born with an *empty* seed — the notice itself at surface position zero was the poison: the host's own first-turn header recording landed after it, and the host's own cold-load validator then refused the log (#314). The TOC notice now arrives as the child's first authored turn, after the kernel records its header exactly as it does for every session you start yourself. Citation still, not copying — and the shape now loads across any restart.

**3. Never contribute to the shared system prompt.**
The header is global to every session in a profile; per-continuation notices are the only injection surface. Enabling dsh-chapters changes what *your sessions can do*, never what *every session hears*. (Rules land in the continuation notice for exactly this reason — [§13](/knowledge/rules/).) The same scope rule reaches the tool catalog: a host-plane tool registration rides every session's request whatever preset it composes, so since 0.2.32 ([#330](https://github.com/fractalsynapse/dsh-chapters/issues/330)) the chapters tools and door commands mount **inside the chapters preset realm** — other presets see neither the tools nor their vocabulary.

A sibling rule earned by the same failure (#330): **the model never measures its own context.** No agent-visible string states the context window, its fill, or token estimates of the live session — the model has no gauge to check them against, so it guesses and steers by the guess. The plugin does the measuring (notice-size admission refuses with numbers; deferral floors are ours) and the relief is invisible: compaction and archive by default, pressure vocabulary nowhere.

**4. Never let the model author chapter bodies.**
Ranges and titles come from the model when it works through the tools — or from the plugin's own
deterministic derivation when a human pulls the door; the **text is always rendered from the log by the
plugin**, never retyped. Model-typed "lossless" archives are reconstructed from recall — which is precisely
the failure mode being eliminated. Corollary: the model *is* trusted where trust is cheap and
human-auditable — proposed rules are model-authored *prose*, but write-once and approval-gated.

## Why invariants instead of settings

Every one of these was chosen after watching the convenient alternative fail: seeded forks that never shrink, summaries that drop the detail the task turns on, a global prompt every user of the machine must trust. The architecture is small because the rules are strict. They are enforced in code and tested by name — `tests/unit/engine-core.test.ts` (the plugin renders every body from the log; the model never authors text) and `tests/unit/notice-rules.test.ts` (the byte-identical absence test: no rules ⇒ no notice section).

Next: [7. Continuation budget math](/concepts/budget/).
