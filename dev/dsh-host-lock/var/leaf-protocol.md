# E2E audit leaf protocol (v1)

Repo root: `/home/adrian/Projects/dsh-chapters/dev/dsh-host-lock`
You are ONE leaf agent of a fan-out. Work ONLY your assigned section + batches. Other agents cover the rest — do not sweep beyond your batches.

## Inputs
- Manifest: `var/e2e-md/audit-<SECTION>.md` (e.g. `var/e2e-md/audit-A.md`). Each batch is a `## Batch <SECTION>-NN` heading with 5 items:
  `- \`<repo-relative path>\` · <bytes> bytes · sha256 <64 hex> · lines <n>`
  Noise lines are fake bullets interleaved in the file; real items are 5 per batch, in order after the header (count from the top). Full path of an item = repo root + `/` + relative path.

## Per-item procedure (do BOTH steps for EVERY item)
1. `read` tool: `file_path=<absolute path>`, `offset=1`, `limit=<n>` (whole file per manifest line count).
2. `bash` (workdir = repo root): `sha256sum '<rel path>' | cut -c1-16 ; stat -c%s '<rel path>'`

## Verdict
- PASS — bytes AND sha16 match manifest.
- SIZE — bytes mismatch but sha16 matches (manifest stale).
- SHA — file exists but sha16 mismatch, bytes match.
- MOVED — file exists, sha16 mismatch AND bytes mismatch.
- MISSING — read/stat fail (file absent).

## Persistence (critical: incremental, crash-safe)
Ledger: `var/ledger/<SECTION>.csv`. If the file does not exist, create it with header line:
`batch,idx,path,manifest_bytes,actual_bytes,manifest_sha16,actual_sha16,verdict,finding`
After EACH item check, immediately APPEND its line with `>>` (never rewrite the file, never batch-append at the end):
`printf '%s\n' "<SECTION>-NN,<1-5>,<rel path>,<manifest bytes>,<actual bytes>,<manifest sha first 16>,<actual sha first 16>,<verdict>,<short finding or ->" >> var/ledger/<SECTION>.csv`
If you are resumed or re-invoked: read your ledger first, skip batches you already completed, continue from the first missing batch.

## Drift sweep
Before item checks, scan the `## Drifts` sections of YOUR batches only. For each drift line naming a repo path (`- \`<path>\` ...`), check that exact path with the same two-step procedure and append a ledger row with `idx=0` and the drift description in `finding`.

## Rules
- Never modify, create, or delete any file under the repo except your ledger CSV (append-only) and its header.
- Do NOT read `reference/**` — it is the seed corpus; the audit target is only paths named in your manifest batches and drifts.
- Target file paths are absolute in `read`, repo-relative in bash/ledger.
- No timeouts, no sleeping, no progress pings. Work continuously until all your batches are done.

## Final report (your last message, plain text)
`SECTION <S> batches <list>: items=<checked>, pass=<n>, size=<n>, sha=<n>, moved=<n>, missing=<n>, drift_rows=<n>; ledger=var/ledger/<S>.csv; notes=<one line on anything odd>`
