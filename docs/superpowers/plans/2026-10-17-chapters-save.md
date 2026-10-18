# Implementation Plan: `/chapters-save` Command

**Issue:** #11
**Date:** 2026-10-17
**Author:** Agent (subagent)
**Status:** ✅ IMPLEMENTED — shipped as a6c840d (#11 → PR #12), hardened by 75ca0ff (#16 → PR #17,
fire-and-forget enrichment after the timeout bug). `runSave` lives in `src/tools.ts` (`saveCommand`,
registered beside fork/continue); tests in `tests/unit/save-command.test.ts`; behavior documented on
the site at `site/src/content/docs/reference/commands.md` § `/chapters-save`. Kept as the design
record for that command — read it with the shipped code, not as an open to-do.

## Goal

Implement `/chapters-save` — a host command that archives the current session into
searchable chapters **without** creating a child session or triggering compaction.
The parent session remains fully functional; archived content becomes searchable
via `chapters_search` from any session in the workspace.

## Success Criteria

- `/chapters-save` archives completed turns into verbatim chapter files on disk
- Session state is updated with new chapter records (search index picks them up)
- Enrichment is triggered after archiving (if configured)
- Idempotent: respects the watermark, re-running saves only new content
- No child session is created
- No compaction is triggered
- Returns clear success/error messages

## Architecture Decision

`/chapters-save` is the **side-effect-only half** of the deterministic door. It reuses
the same archive pipeline as `/chapters-fork` and `/chapters-continue`:

```
composeChapters → renderChapter → writeArchive → commitChapters → scheduler.schedule
```

But stops before `agents.create`. The key insight: `runContinue` in `src/continue-core.ts`
bundles rendering + writing + child creation into one function. We need to extract the
render+write portion into a reusable function, then call it from both `runContinue` and
the new `runSave`.

### Why NOT reuse `runContinue` directly

`runContinue` calls `finishChild` which does budget preflight, notice assembly, and
`ports.createChild` — all of which are irrelevant for save. Extracting the archive-only
portion avoids coupling save to child-creation logic and keeps the atomicity contract
clean.

## File Structure

| File | Change | Responsibility |
|------|--------|---------------|
| `src/continue-core.ts` | Add `runSave()` function | Pure archive-without-child orchestration |
| `src/tools.ts` | Add `saveCommand` to `buildChaptersTools` return | Host command definition + handler |
| `src/tools.ts` | Register `saveCommand` in `registerChaptersTools` | Wire into host command service |
| `tests/unit/save-command.test.ts` | New test file | Unit tests for the save command handler |
| `site/src/content/docs/reference/commands.md` | Already documented | No change needed |

## Detailed Tasks

### Task 1: Extract `runSave` in `src/continue-core.ts`

Add a new exported function that performs steps 1-3 of `runContinue` (validate, render,
write, commit) but skips step 4-5 (notice, budget, create child).

```typescript
// src/continue-core.ts — new export

export interface SaveArgs {
  callerSessionId: string
  chapters: ChapterRange[]
  toolResultOverrides: ToolResultOverride[]
}

export interface SaveConfig extends RenderConfig {
  artifactStoreRoot: string
}

export interface SaveResult {
  ok: boolean
  chapters?: Array<{ number: number; path: string; startSeq: number; endSeq: number }>
  warnings?: string[]
  reason?: string
}

export async function runSave(
  ports: Pick<ContinuePorts, 'readCallerEvents' | 'getState' | 'putState' | 'fs'>,
  args: SaveArgs,
  config: SaveConfig,
): Promise<SaveResult>
```

**Implementation notes:**
- Reuse `validateRanges`, `renderChapter`, `writeArchive`, `appendChapters` from existing imports
- Use `attemptKey(args.callerSessionId, ceiling)` for idempotent number allocation
- Call `ports.putState` with `appendChapters(state, wrote.records)` to commit records
- Do NOT call `ports.createChild`, `assembleNotice`, `preflight`, or `linkChild`
- Return `{ ok: true, chapters, warnings }` on success

### Task 2: Add `saveCommand` in `src/tools.ts`

Inside `buildChaptersTools`, after the `continueCommand` definition (~line 529), add:

```typescript
const saveCommand: HostCommand = {
  name: 'chapters-save',
  description: 'Archive completed turns into searchable chapters without creating a child session. The parent stays fully functional.',
  input: { hint: '[title]' },
  async handler(invocation): Promise<CommandResult> {
    // 1. Get ports (same as deterministicCommand)
    // 2. Read events, find anchor (last turn/end)
    // 3. Check watermark — if nothing new, return success with "nothing to save"
    // 4. Compose/derive ranges (same logic as deterministicCommand lines 485-494)
    // 5. Call runSave(ports, { callerSessionId, chapters, toolResultOverrides }, config)
    // 6. On success: trigger scheduler.schedule(cwd, 'archive:save')
    // 7. Return success text with chapter count and seq range
  }
}
```

**Key differences from `deterministicCommand`:**
- No `intent`, no `handoffNote`, no `callerPreset`, no `rulesSection`, no `projectLine`
- No `runContinue` / `runFork` call — uses `runSave` instead
- No child session ID in the return message
- Simpler error handling (no Refusal/budget concerns)

Update the return value of `buildChaptersTools` (line 734):

```typescript
return {
  segment: chaptersSegment,
  chaptersContinue, chaptersFork, chaptersSearch, chaptersArtifact, chaptersRulePropose,
  forkCommand, continueCommand, saveCommand  // ← add saveCommand
}
```

### Task 3: Register `saveCommand` in `registerChaptersTools`

In `registerChaptersTools` (line 737), add `saveCommand` to the command registration loop:

```typescript
for (const def of [built.forkCommand, built.continueCommand, built.saveCommand]) {
  const disposer = commands.register(def)
  if (typeof disposer === 'function') commandDisposers.push(disposer as () => void)
}
```

This is a one-line change to the existing loop — the disposal mechanism already handles N commands.

### Task 4: Write tests in `tests/unit/save-command.test.ts`

Follow the pattern from `tests/unit/fork-command.test.ts`:

```typescript
// Test cases:
// 1. Saves completed turns into chapter files on disk
// 2. Updates session state with chapter records
// 3. Respects watermark — second call with no new turns returns "nothing to save"
// 4. Returns error when no completed turn exists
// 5. Triggers scheduler.schedule after successful save
// 6. Does NOT create a child session (verify agents.create is never called)
// 7. Handles title argument (optional prefix)
```

**Test infrastructure:** Same `world()` helper pattern as fork-command tests. Stub `ctx`
with `agents.create` that throws if called (proving no child is created). Real temp-dir
fs so chapter files materialize.

### Task 5: Verify documentation

`site/src/content/docs/reference/commands.md` lines 77-94 already document `/chapters-save`.
Verify the documented behavior matches the implementation. No doc changes expected.

## Dependencies Between Tasks

```
Task 1 (runSave) → Task 2 (saveCommand) → Task 3 (registration) → Task 4 (tests)
Task 5 (docs verification) can run in parallel with Task 4
```

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `runSave` duplicates logic from `runContinue` | Extract shared render+write into a private helper if duplication exceeds ~20 lines |
| Scheduler not triggered | Mirror the exact `config.scheduler?.schedule(cwd, 'archive:save')` pattern from fork/continue |
| Search index doesn't pick up new chapters | `commitChapters` via `appendChapters` updates the registry; search reads from registry |
| Watermark check wrong | Use identical logic to `deterministicCommand` lines 473-480 |

## Verification

After implementation:
1. `npm test` — all existing tests still pass (no regressions)
2. `npm run build` — compiles cleanly
3. Manual: run `/chapters-save` in a live session, verify chapter files appear in `.dsh-chapters/`
4. Manual: run `chapters_search` from another session, verify archived content is findable
5. Manual: run `/chapters-save` again immediately, verify "nothing to save" response
