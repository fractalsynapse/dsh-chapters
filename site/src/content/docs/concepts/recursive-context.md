---
title: "8. Recursive context theory"
description: The intellectual basis — long material as an external environment the agent inspects programmatically, not a context to be compressed.
lastUpdated: true
---

The naive frame: a model has a context window; when content exceeds it, compress. dsh-chapters takes the opposite frame, and it is worth being precise about because it is where most memory systems diverge.

## The claim

**Long material is not a window to fit; it is an external environment to inspect.**

This is the Recursive Language Model (RLM) result — Zhang, Kraska & Khattab, *arXiv:2512.24601*. Their formulation: treat the long input as an *external environment*, let a small model run programs that decompose it and pull **sub-spans** into its limited window programmatically, recursing as needed. Their mechanism is a Python REPL over the prompt; their reported **compaction-baseline gap** (median ~26% quality) is the evidence that *how you handle overflow* matters more than *how big the window is*. The quality argument for this project's architecture is theirs, cited by name in the repo's own design record.

## dsh-chapters' instantiation

The same decomposition, engineered for a coding agent's real corpus, **without a code sandbox or a separate REPL**:

| RLM idea | Here |
|---|---|
| long input as external environment | the `.dsh-chapters/` archive on disk — files, plain Markdown |
| recursive decomposition | TOC notice → numbered chapters → per-chapter frontmatter + headings → `read` on a path |
| pull sub-spans into the window | `read` with offset/limit; oversized *tool results* deferral to content-addressed `artifacts/`, retrieved via `chapters_artifact` with `toc / search / read` |
| agent drives the recursion | the model issues the reads; the plugin provides handles (paths, `⟦omitted…⟧` markers, artifact TOCs) — never a token reading of the session, which the model cannot verify (#330) |

Structured documents even self-describe: a 373 KB book arrives with a parsed table of contents so the first call is already a search, not a dump.

## The guard that keeps it honest

The follow-up, SRLM (*arXiv:2603.15653*), supplies the caution: **recursion that splits material that already fits actively hurts.** So the design refuses to be a split-everything stance — a **hard band boundary** decides *when* the recursive path engages, and bounded pulls stay the model's *choice*, never a forced pipeline. That boundary — and the refusal-not-truncation it feeds into ([§7](/concepts/budget/)) — is what separates this from "chunk everything and RAG it".

## What it buys, in one line each

- **Unbounded horizon on a bounded model** — the same 64K window carried a ten-session, multi-agent project analysis; the field study in [§20](/evidence/field-study/) is the existence proof.
- **Verbatim, lossless retrieval** — you pull the *bytes*, not a paraphrase of them; a summary can never do that.
- **Structural cost control** — the retention paradox (huge-but-new) never fires because the huge result is stubbed *at arrival* ([§9](/concepts/archive-anatomy/)).
- **Model-agnostic quality** — it's about context *management*, so a 64K local model gains capability rather than merely longevity. The thesis is *small models, more capable*.

## What it concedes

- **Extra round-trips** — retrieval costs turns and re-prefill; a summary is one call. Recursion is the discipline; over-splitting is the failure mode the guard defends against.
- **Model cooperation** — it depends on the agent deciding to reach. In the field study, it did 49/49 times; the archive is written from the log *regardless*, so the worst case is under-retrieval, never data loss.

Next: [9. Anatomy of the archive](/concepts/archive-anatomy/).
