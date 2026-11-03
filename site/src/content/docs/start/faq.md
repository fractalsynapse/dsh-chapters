---
title: "4. FAQ & troubleshooting"
description: The traps that are real, what they look like, and why — including a few we discovered instrumenting our own production runs.
lastUpdated: true
---

### Commands "don't run" in a brand-new session

The harness draft screen turns composer text into the **first message**, not a command — so `/chapters-status` typed cold just messages the agent. Send any short opener first (or ask the agent to check status in prose) and the command surface works for the rest of the session. This is a client draft-routing behavior, not plugin state; it's documented wherever commands appear.

### `/chapters-status` says `No knowledge repository is linked yet`

Correct, not broken — and it is the *transport* answer, not a search answer. Before you link a pool the
archive is on disk and fully usable: open it, grep it, commit it; the model reloads chapters by path with
`read`, and `chapters_search` **already answers from this machine's own store** — chapters, `kind: plan`
documents and rules — naming the door it answered from so "this machine only" can never be read as "the
whole project". It also keeps the two facts apart: *nothing matched your query* is not the same answer as
*nothing is archived here*, and they get different next steps ([§12](/knowledge/search/)). Linking a pool
widens the corpus to every machine's work — [Part III](/knowledge/pool/) explains it.

### Which button — *Fork with chapters* or *Continue with chapters*?

Either: they are ONE deterministic door pulled with two intents, and the archive they write is identical.
The choice is about the work, not the machinery — **continue** extends the same stream (so the child is told
which plan governs it, and stays in plan mode if you were still planning), **fork** splits a new direction
(so the child is handed zero plan bytes and asks you what it should work on). Both derive their ranges in
the plugin, so a click needs no model turn ([§15](/reference/commands/)).

### `origin changed — rebuilding mirror`

You relinked to a different upstream. The mirror is transport, the store is truth: the plugin rebuilds from local state and republishes. This is the designed recovery, logged loudly with its reason.

### Cache hit rate drops when many agents share one local model

That is llama.cpp KV **capacity**, not dsh-chapters. On a single-slot server, interleaved sessions can only keep the shared prefix cached; divergent tails re-prefill. dsh-chapters' own serial sessions warm to 99.7%+ (measured). Full writeup with numbers: [§21 Cache behavior on llama.cpp](/evidence/llamacpp-cache/).

### I updated the plugin but nothing changed

Restart `dsh web` — bundles load at boot, so a swap on disk is invisible until then:
`npm i @fractalsynapse/dsh-chapters@latest` in the profile directory, restart, and `npm ls @fractalsynapse/dsh-chapters`
in that same directory tells you which version the next boot will load. Same applies after an upgrade that
changes `cordis.patch.yml` defaults ([§23](/operations/install/)).

### A continuation said "over budget" and refused

Budget is *newly added* context after the header; the plugin refuses with per-rule numbers and never silently truncates a handoff note (a clipped note is the lossy behavior the whole design rejects). Trim the note or raise `continuationBudgetRatio` (default 0.25) — [§7](/concepts/budget/).

### My model never writes `PLOT:` lines, so checkpoints have no plot

Fine — the plugin elicits one bounded call to author the plot over the region being condensed, and logs
*why* if it declines. Reason strings land in the diagnostics sink if you set `DSH_CHAPTERS_ENGINE_ERRORS`.
This exact pipeline is a case study in [§26 changelog](/operations/changelog/) and the
[field study](/evidence/field-study/).

### How do I check what a chapter actually contains?

It is a file. `cat .dsh-chapters/<root>/chapters/001-*.md`. The archive is plain Markdown on purpose — no API, no format lock-in.

### Where do credentials live?

Per-project, `0600`, under the DSH home — never in the repo, never in a chapter, never in the corpus. See [§27 security](/operations/security/).
