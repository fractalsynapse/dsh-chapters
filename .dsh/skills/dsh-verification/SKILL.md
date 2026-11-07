---
name: dsh-verification
description: Use when verifying DSH Chapters behavior, host compatibility, acceptance tapes, installed packages, or release readiness.
---

# Verify the claim at the right boundary

Follow the [project instructions](../../../AGENTS.md) and
[Scaffold verification procedure](../verification-before-completion/SKILL.md).
The [verification record](../../../docs/verify.md) owns claim-specific assertions.
Use the [rig procedure](../../../docs/development.md) for current commands and inputs.

| Claim | Evidence to inspect |
| --- | --- |
| Archive logic or host contract | Relevant deterministic checks, payload fields from the exact host, and real default composition when wiring changes. Keep deterministic coverage and the server, client and applicable e2e type checks distinct. |
| A journey works on the pinned host | Actual replay verdicts from isolated boots, the executed journey list and skip reasons, clean tape matching, the pinned host and corpus anchor, and the observed UI or durable log assertions. |
| A child survives restart | The expected child becomes active, its authored TOC and history render after a cold restart, and a new turn works when resumability is part of the claim. Exercise the real composed host and use the restore door when recovery is the claim. |
| A release artifact works after install | Pack the exact candidate, install the tarball into a scratch profile, and verify the loaded copy and the relevant user journey on the claimed host. Verify published identity separately. |
| A fix reaches a maintainer's host | Identify the intended process, profile, loaded plugin path and build, actual host and process generation. Check the intended artifact after authorized installation and restart. A report with zero copies is no comparison. |
| Live provider behavior, timing or cache | Use an authorized live run with recorded provider regime, bounds and configuration. Assert the real result and record before and after measurements where relevant. Tape replay establishes pinned deterministic behavior. |

Record the issue or PR criterion, candidate commit or package identity, host and
profile or rig pin, relevant corpus provenance, check mode, observed assertions,
counts and result, and the log or run link. Match the intended host and profile
when claiming field delivery. Record observed differences before drawing conclusions. Record failed, skipped, advisory,
unavailable and inapplicable checks separately. Compare the actual executed tests
with the required scope. CI job names, a matching version string, coverage
percentages and a zero exit from an empty parity scan prove only what they measured.

For regressions, reproduce the smallest failing journey and inspect the existing
browser, boot, durable-log or tape-diff artifact first. Capture the baseline.
Show a new or changed gate can fail on the defect or a meaningful negative
control in isolation. Verify the correction on that journey before applicable
broader confirmation. Reuse unchanged evidence and avoid replay or live reruns
that cannot answer the open question.

Keep the scratch home, port, store and mirror separate from live agents. Check the
actual mounted preset, profile pins and executed path. Keep fixture bytes
deterministic and assertions observable. Prefer the canonical rig commands.
Read both incoming and stored prefixes for a tape miss. Strict replay treats a
miss as a failure and keeps live fallback disabled. Refresh a corpus for
affected host, prompt, or prefix-shape changes while preserving AGENTS-BLIND
matching and generated provenance. For background drivers, verify that the bound
still permits observing the feature. Keep unsupported or unproven coverage open.
