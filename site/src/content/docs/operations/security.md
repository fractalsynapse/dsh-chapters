---
title: "27. Security & privacy"
description: Where secrets live, what never leaves your machine, and what the archive guarantees.
lastUpdated: true
---

## Credentials

- Knowledge-pool tokens (git or TreeDX) are stored **under the DSH home, mode 0600, per project** — never in the workspace, never in a chapter, never in git, never in an agent prompt beyond the auth header the transport adds. A local-path link needs no credential at all.
- Remote identity includes a deliberate de-credentialization: `https://user:token@repo` and `https://repo` canonicalize to **one project key** — pasting a URL with credentials cannot fork your pool into a split-brain twin (caught, fixed, pinned by test).

## Data boundary

The plugin has no network of its own: it writes files (workspace store, mirror clone) and drives **your** git/TreeDX transport to **your** linked remote. No telemetry, no phoning, no account, no default egress beyond the DSH home's configured providers. The archive is plain Markdown — it can and should go through the same review (and `.gitignore`, if you don't want the store in your repo working tree) as any other file. Nor does the knowledge pool ever carry another project's instructions: the archive-time injection screen marks host-injected context (instruction files, runtime snapshots, skill catalogs) and never archives it, so corpus search sees conversation only.

## Integrity

- **The log is append-only** — no tool path rewrites or deletes durable history; compaction *shadows* in the rendered surface and the shadowed spans are archived verbatim with coverage checked per span.
- **Write-once everywhere it matters** — chapters are never edited (the body-hash guard makes the enrichment metadata regions the only sanctioned mutation, with provenance chains), rules are never edited, artifacts are content-addressed.
- **Supply chain**: every CI-published version (0.1.1 onward) carries an **npm provenance attestation** signed from the run's OIDC identity — publish auth is an npm org token held in the `Production` environment since #261 (before it: OIDC trusted publishing); **no long-lived token is ever stored in the repo**. The ledger's stated exceptions stay true: a repeat-provenance 409 forces one documented republish-without-attestation path behind a loud run warning, and the manual 0.2.20 predates the tarball-verify gate. `npm audit signatures` verifies any install.

## If your sessions contain sensitive text

The same advice as any chat-log system, honestly scoped: **chapters archive conversation bytes verbatim** — if a secret is said in a session, the archive stores it like the session log does. One guard ships: credential **redaction at the render chokepoint** — deterministic, config-extensible patterns replace secrets with stable markers (`⟦redacted:credential sha256=…⟧`) in chapters and artifact files alike, and the same secret always yields the same marker. It is deliberately credentials-only and is a speed bump, not a guarantee; broader content redaction is not offered, and per-write redaction hooks beyond it remain a known gap, on the record. Treat pools as you'd treat git history you can rewrite *before* first push, and use per-project pools + scoped tokens (a read-write-token to one pool is the blast radius).

Questions on this page deserve a repo issue rather than an email — the answers belong in public.

← back to [26. Changelog](/operations/changelog/) · or start the book at [1. Quickstart](/start/quickstart/).
