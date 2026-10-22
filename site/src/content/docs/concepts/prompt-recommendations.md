---
title: "28. Prompt recommendations"
description: A second model reads the context and defines the work — the next prompt, offered in the composer as a ghost layer you can accept, overwrite, or ignore.
lastUpdated: true
---

Every feature so far answers *what did we do*. This one answers *what should we do next*.
One model reads the context and **does** the work; a second model reads the context and
**defines** the work: it proposes the next prompt you would send, and offers it where you
would type it.

It is **off by default** and there is exactly one knob: a model. Setting a model — with
`/chapters-prompt model <provider/model>` or the `promptModel` config — turns the feature
on; clearing it (`model clear`, or `off`) turns it off. No second boolean to drift against
the first.

## What you see

An idle session with an empty draft shows a dim suggestion line in the composer
card — in the band where the slash/@ menu pops, in the placeholder's own caption
palette — labeled with the model that wrote it (hover):

- **Type, and it is gone.** The layer renders only while the draft is empty. Anything you
  type wins immediately, exactly as a placeholder behaves.
- **Right-arrow accepts it.** The suggestion moves into the draft as real text, cursor at
  its end. It never sends itself: the keystroke is the decision. (A click on the ghost does
  the same, for anyone who never finds the key.)
- **Escape (or a second right-arrow past the accepted text) dismisses it for the turn.**
  The next completed turn re-opens the offer, and the model gets a fresh look.
- **Nothing shows when it is off or failing.** A refusal latches the layer hidden for that
  boundary — an invisible feature is honest; a nagging error banner is not.

The suggestion is labeled with the model that wrote it (hover). That matters: the whole
point is a *different* model defining the work, and you should know which mind suggested it.

## Why a ghost layer and not the literal placeholder

The composer's own placeholder text is computed inside the host ([measured, see
`docs/contract.md`](https://github.com/treeseed-ai/dsh-chapters/blob/main/docs/contract.md)):
it is a chain of host-owned states resolving to locale-dictionary strings — plan mode swaps
it, offline states swap it, and no config key, slot, or projection feeds a plugin-writable
value into that chain. So the plugin renders its own layer in the composer's **overlay
slot** (`conversation.input.overlay` — the same hole the slash/@ trigger menu occupies) and
behaves *like* a placeholder: shows when empty, hides when typed, accepts on a keystroke.
It sits in the menu band above the typing line rather than on top of the host's placeholder
text: a chip that replaces another plugin's pixels is a styling hostage; a chip that reads
as the composer's own suggestion is not. This is a visible, replaceable surface, not a
hijack of the host's text.

## What the model reads

A bounded, deterministic slice — the same discipline as the enrichment input:

- the session's chapter summaries (the TOC facts the registry already holds),
- the live tail of the conversation (last completed turns, capped by `promptContextChars`),
- nothing else. Host-injected context is defused before the cap; command results, notices,
  and your private instruction files are not silently fed to a second model.

The answer must be one imperative prompt of at most `promptMaxChars` characters. An
oversized or empty answer is retried **once** with the cap restated, then **refused** —
this project does not truncate to fit.

## The cost, honestly

This is the **one place the plugin spends model tokens at human cadence**. Everything else
in dsh-chapters is zero-inference (rendered from the log, indexed without a model). Here:

- at most **one recommendation per turn boundary per session** — one auxiliary completion,
  or two when the first answer fails validation and gets its single restated retry — computed
  **on demand**: a suggestion is generated when a human is looking at an idle composer with an
  empty draft, never eagerly for sessions you abandoned;
- concurrent requests for the same session share one in-flight call;
- the completion runs under the existing `enrichmentMaxTokens` budget (the one auxiliary
  budget, now three consumers: annotation, mined rules, recommendations);
- a cached suggestion is reused while its turn-boundary watermark is current — revisiting
  the session costs zero tokens until a new turn completes.

For a local model at 10–30 tok/s a recommendation is short (≤ `promptMaxChars`), so the
wait is small; the ghost appears when the answer lands and simply doesn't if you typed first.

## Where it never goes

- **Never into the archive.** A suggestion is UI state. If you accept it and send, the text
  becomes *your* message — authored by the human who took the keystroke — and archives as
  conversation. The recommendation itself is never written to a chapter, a notice, a rule,
  or the pool.
- **Never into a model request.** The suggestion reaches only the composer surface. It is
  not injected per step; it cannot steer the working model except through your acceptance.
- **Never automatic.** No submit path, no queue insertion, no background send. The feature
  defines work; only you start it.

## Commands and config

Syntax is at [§15 Commands](/reference/commands/), keys at
[§17 Configuration](/reference/configuration/). The short form:

| Key | Default | Meaning |
|---|---|---|
| `promptModel` | `''` | the defining model; **empty ⇒ the feature does not exist**. Setting it (config or command) is the enable |
| `promptContextChars` | 4000 | hard cap on the assembled input slice |
| `promptMaxChars` | 240 | cap on the accepted answer; over-cap ⇒ retry once ⇒ refuse with numbers |

## Transport (for future maintainers)

Today the client **pulls**: the overlay component executes `/chapters-prompt suggest` over
`remote.commands` — the exact wire the door buttons ride — and the host command serves the
cache or runs the one call. On a 0.2.x host the upgrade is a **push**: the plugin appends
its recommendation as a *plugin record* (durable, append-only, never model-surface-eligible)
and a registered session projection delivers it to clients without a pull. Same component,
one seam moved; tracked in `docs/backlog.md`.
