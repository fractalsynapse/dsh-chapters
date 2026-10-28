# Ask of the host team: the protected system head and a plugin-seeded first message (#105)

**Filed 2026-10-24 against `dsh 0.2.1` / session format v4.** Reproduced on the maintainer's own data:
a `chapters_continue` child (`ch-dc3be3ab-c3d9-4afc-bc53-9994c06600d6`) refuses to open in the UI with
`SessionFormatError: system/message requires a protected first surface head`, while its 2,924-line log
decodes cleanly. Nothing about that file is damaged.

## The two kernel rules that cannot both hold for our children

1. **The seed contract**, established by measurement against the installed kernel (`spikes/probe/FINDINGS.md`)
   and recorded in `AGENTS.md` invariant 2: a continuation is
   `agents.create({ sessionId, seed: [noticeEvent] })` with **one synthetic `user/message` at `seq 0`**, a
   producer-owned `source.kind` (`plugin:dsh-chapters`, `form: 'snapshot'`), no `plugin` field (format v4
   retired it and refuses it at row admission), and the kernel's own `permission/preset` / `sandbox/mode` /
   `approval/policy` events appended **after** the seed. Seeding from the parent's events is refused as
   capability-gated, and is the failure mode this plugin exists to avoid.
2. **The protected head**, as read out of `@deepseek-ai/dsh-session-format-v2-to-v3/lib/index.js`:

```js
const SURFACE_TYPES = new Set(["system/message", "user/message", "assistant/message", "tool/result"])
// inside restoreReleasedV3Artifact's event walk:
if (system) {
  …
  if (hasSurface && head === void 0)
    throw new SessionFormatError("system/message requires a protected first surface head")
}
…
if (SURFACE_TYPES.has(event.type)) hasSurface = true
```

`user/message` **is** a surface type. So a kernel-sanctioned seed at `seq 0` sets `hasSurface` before the
host composes and writes its own `system/message` header at the first step — and at that moment the header
can no longer claim the protected head, because `head` is only assigned to a `system/message` that arrives
while `hasSurface` is still false.

## The statistics that make this a rule collision, not a corrupt file

53 durable logs on this machine, first surface event preceding the header:

| shape | sessions |
|---|---|
| header **is** the first surface event | 50 |
| a `user/message src=plugin:dsh-chapters` at `seq 0` precedes it | **2** |

Both of the 2 are children this plugin created (`ch-dc3be3ab…`, 2,924 events — refused; `ch-c2a7ee0f…`,
105 events — same shape, not yet opened). Also observed: that child's header carries `isSeeded: false`.

## What we are asking for

**Preferred:** for the protected-head rule, do not treat a `user/message` whose `source.kind` is
producer-owned plugin (`form: 'snapshot'`) at `seq 0` as a surface event that pre-empts the head. The rule
exists to protect the system head from being shadowed or replaced; a plugin snapshot that the kernel
itself invited to `seq 0` is not a competing user turn.

**Acceptable alternative:** admit the mid-run header by letting the first `system/message` claim the head
when the preceding surface events are all plugin-produced seeds, and record the head position as it is
written.

**What would NOT fix it:** telling us to seed nothing. Then a continuation starts with no TOC, which is the
whole feature. And we cannot write the header ourselves — invariant 3, and a per-session system contribution
changes every session's header in the profile.

## Why we are not just changing our own shape unilaterally

We could seed a non-surface synthetic event instead (the `plan/mode` seed in `docs/plans-carriage.md` § 10
proves the kernel accepts plugin-authored STATE events in a seed) and deliver the TOC as an appended message
at the child's first step. We are **not** building that on an assumption: it needs a measurement first —
does a state-only seed get admitted, and does the header then land as the first surface event so the session
loads? The spike design is in `spikes/seed-protected-head/` (see `docs/backlog.md`); one boot, zero model
tokens, a fake provider supplying the turn. If the measurement says the kernel admits it, we ship it behind
a config flag and the ask above becomes belt-and-braces. If it says otherwise, the ask is the only path, and
we would rather know that before a user loses a child.

## Side observation, offered as a fact rather than a claim

We tried to reproduce the throw by calling `restoreReleasedV3Artifact` directly with the real bytes. Every
variant — the refused child *and* healthy sessions — failed earlier at `assertV3EventAdmission` with
`"system message requires plugin source"`. So that module's admission gate is not the path that validated
this v4 log, even though its message text is what the UI shows. Whatever the actual v4 validator is, the
statistics above and the rule text are consistent; a pointer to the right entry point would help us pin it.
