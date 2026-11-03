---
title: "3. Link a knowledge pool"
description: One command turns a single session's archive into a shared, searchable corpus for the whole team or every project of yours.
lastUpdated: true
---

## Why link

The archive is already on disk and already searchable *by you*. Linking a **knowledge pool** publishes chapters and a derived two-layer index to a shared upstream, so any linked workspace — another project, another machine, a teammate — gets cross-session, cross-project `chapters_search` and the rules layer. The link is **per workspace, not per session**: one command, and it carries over to every future session and sub-agent under that path (a child directory inherits its nearest ancestor's link).

## Pick a transport

**A local git repo (easiest; no network, no credentials):**

```
/chapters-link /home/you/fractalsynapse-kb.git
```

**A networked git pool over smart-HTTP:**

```
/chapters-link https://github.com/you/team-kb.git  <token>
```

The token is stored **0600 under the DSH home**, never in the project, never committed.

**A TreeDX service:**

```
/chapters-link treedx+https://kb.example.com/team-kb  <token>
```

The two backends are documented side-by-side in [§11, Providers](/knowledge/providers/); either way the on-disk mirror layout is identical and search/rules read the same materialized files.

## What lands in the pool

`chapters/` (verbatim), `artifacts/`, `rules/`, plus derived `index/`, `collections/`, and `topics/vocabulary.json`. It is a Git history of your team's distilled memory — browsable with any git client, greppable with plain shell, and readable by the model through search.

## Verify

```
/chapters-status
```

shows the last sync with the steps behind it (`cloned → published N new file(s) → pushed`), or an honest `local-only` with the failed step named and the mirror marked current so the push lands when the remote returns. If you ever see `origin changed — rebuilding mirror` — the workspace's mirror was built for a different upstream (typically right after you re-linked) — that is the correct recovery, not a bug: the stale mirror is discarded, republished from the store, and pushed. The store is the truth, the transport is expendable.

## One nuance about "before the first prompt"

Commands run inside a session; a brand-new *draft* screen sends text as a message rather than executing a command (see the [FAQ](/start/faq/)). Send any one-word opener first, then `/chapters-link`.

Next: [4. FAQ & troubleshooting](/start/faq/).
