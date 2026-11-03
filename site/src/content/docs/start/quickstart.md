---
title: "1. Quickstart"
description: Install dsh-chapters in one line, restart, and take your first continuation in about two minutes.
lastUpdated: true
---

## Three steps

**1. Install the plugin** (DeepSeek Harness ≥ 0.1.5-rc.x, Node ≥ 24). A harness profile is a directory
with its own `package.json` and `node_modules` (`~/.dsh/profiles/<profile>/`), so the plain npm install is
the path this project documents and uses:

```bash
cd ~/.dsh/profiles/web && npm i @fractalsynapse/dsh-chapters@latest
```

`@latest` is deliberate: it is the only instruction that cannot go stale. The host also ships
`dsh plugin --profile <name> add @fractalsynapse/dsh-chapters` — see [§23](/operations/install/) for both paths
and for what this project relies on.

The current release is the one the [npm page](https://www.npmjs.com/package/@fractalsynapse/dsh-chapters) calls
`latest` — every version ships with a build provenance attestation and a green deterministic + tape-replay
CI run behind it ([§26](/operations/changelog/)).

**2. Restart your harness.** `dsh web` loads plugin bundles at boot. After restart you have, with no further configuration:

- the agent tools `chapters_segment`, `chapters_continue`, `chapters_fork`, `chapters_search`, `chapters_artifact`, `chapters_rule_propose`;
- the composer commands `/chapters-link`, `/chapters-status`, `/chapters-enrich`, `/chapters-rule`, and the two door commands `/chapters-fork` and `/chapters-continue`;
- a **Fork with chapters** and a **Continue with chapters** button on every assistant message: ONE
  deterministic door with two intents, each button executing its own command. The archive is identical
  either way (the plugin derives the ranges itself — a click needs no model turn); what differs is only
  what the child is told about plans — a branch gets zero plan bytes, a continuation carries the operative
  plan and, while the session is still planning, starts in plan mode for real;
- the `chapters` agent preset (select it from the preset menu to route in-place `/compact` through the deterministic engine — optional; the archive tools work without it).

**3. Take a continuation.** Work a few turns in a real task until the conversation feels expensive, then either click **Continue with chapters** on the last assistant message (**Fork with chapters** if this is a new direction rather than more of the same), or say:

> *"Segment this conversation and continue with a TOC; keep the debugging history in one chapter and the setup in another."*

The agent archives verbatim chapters, opens the continuation, and the new session starts with a Table of Contents of everything that came before. Nothing was summarized; the original session is untouched and still openable.

## Check it works

```
/chapters-status
```

On a fresh workspace the honest answer is `No knowledge repository is linked yet` — that is the system
working as designed, not a failure: it is the *transport* answer. The archive itself is on disk and
greppable the moment it exists, and `chapters_search` already answers from this machine's store without any
pool linked — naming the door it answered from, so "this machine only" can never be read as "the whole
project". Linking a pool widens that door to every machine's work ([Part III](/knowledge/pool/)).

## Two traps we documented so you don't rediscover them

- **Slash commands need a started conversation.** On the brand-new session *draft* screen, the composer sends text as the first message rather than running a command — send any short opener first (or just ask: *"check our chapters status"*), then commands behave. This is a harness draft-screen behavior, and the plugin's docs are candid about it.
- **Restart after upgrade.** Reinstalling swaps files on disk; the running process holds the old bundle until restart (`npm i @fractalsynapse/dsh-chapters@latest` in the profile, then restart `dsh web` — [§23](/operations/install/)).

## What's next

[2. Your first continuation](/start/first-continuation/) walks the mechanics — what the archive looks like, what the new session actually contains, and how to reload a chapter when the model needs the old detail.
