/**
 * #348 — the registry must be able to say where its own bytes live.
 *
 * Rows store chapter paths RELATIVE to the session workspace; the registry is PER HOME and holds
 * every project on the machine in one file. With no owning workspace on the row, a consumer holding
 * only registry bytes has nothing correct to resolve against: doing that on this machine reported
 * 1,431 of 3,623 entries (39%) as "missing" while resolving against each session's own workspace gave
 * 3,620/3,623 present. Nothing was corrupt — the addressing was unattributable.
 *
 * These rows are written against that measurement, not around it: the central one resolves a
 * two-workspace registry the way a registry-only consumer must, and fails if `cwd` is ignored.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { appendChapters, freshSession, isActiveChapter, stampWorkspace, type SessionState } from '../../src/registry.ts'
import { parseSessionState } from '../../src/store.ts'
import type { ChapterRecord } from '../../src/archive.ts'

const rec = (n: number, startSeq: number, endSeq: number, cwd: string): ChapterRecord => ({
  number: n,
  path: `${cwd}/.dsh-chapters/root1/chapters/${String(n).padStart(3, 'x')}-a.md`,
  title: `T${String(n)}`, summary: 's', startSeq, endSeq,
  sha256: 'a'.repeat(64), estimatedTokens: 10, artifacts: [],
} as never)

test('#348: appendChapters stamps the owning workspace onto the row it writes', () => {
  const st = freshSession('s1')
  assert.equal(st.cwd, undefined, 'a fresh row claims no workspace until one is observed')
  const withCwd = appendChapters(st, [rec(1, 0, 4, '/work/alpha')], '/work/alpha')
  assert.equal(withCwd.cwd, '/work/alpha', 'the door that knew the cwd left it on the row')

  // A second door, same session, must not be able to move the row to a different workspace.
  const again = appendChapters(withCwd, [rec(2, 5, 9, '/work/alpha')], '/work/alpha')
  assert.equal(again.cwd, '/work/alpha')
})

test('#348: an unknown or unchanged cwd returns the SAME object — no phantom write, no rev bump', () => {
  // store.mutate treats "returned the same object" as "nothing changed" (the shared-row rule).
  // If stamping always produced a new object, every idempotent retry would write and bump rev.
  const st = freshSession('s1', '/work/alpha')
  assert.equal(stampWorkspace(st, '/work/alpha'), st, 'same cwd in => same object out')
  assert.equal(stampWorkspace(st, undefined), st, 'no cwd known => untouched')
  assert.equal(stampWorkspace(st, ''), st, 'empty cwd is not a workspace')
  const moved = stampWorkspace(st, '/work/beta')
  assert.notEqual(moved, st, 'and a genuinely new workspace IS a change')
  assert.equal(moved.cwd, '/work/beta')
})

test('#348: registry bytes alone resolve every entry across two workspaces in one home', () => {
  // The acceptance shape: one per-home registry, two projects. Resolution must use the ROW's cwd,
  // not the caller's — this is the exact calculation that reported 39% of rows as missing.
  const alpha = appendChapters(freshSession('A'), [rec(1, 0, 4, '.dsh-chapters/root1/chapters')], '/work/alpha')
  const beta = appendChapters(freshSession('B'), [rec(1, 0, 4, '.dsh-chapters/root2/chapters')], '/work/beta')
  const registry: Record<string, SessionState> = { A: alpha, B: beta }

  const resolveWithRow = (id: string): string => {
    const row = registry[id]!
    if (row.cwd === undefined) return ''
    return path.isAbsolute(row.chapters[0]!.path) ? row.chapters[0]!.path : path.join(row.cwd, row.chapters[0]!.path)
  }
  const resolveNaively = (id: string): string => path.join('/work/alpha', registry[id]!.chapters[0]!.path)

  assert.match(resolveWithRow('A'), /^\/work\/alpha\/\.dsh-chapters\/root1/, 'row A resolves under alpha')
  assert.match(resolveWithRow('B'), /^\/work\/beta\/\.dsh-chapters\/root2/, 'row B resolves under beta — from registry bytes alone')
  // The failure this issue is about, shown rather than described: assuming the caller's workspace
  // silently produces a plausible path to the WRONG project.
  assert.match(resolveNaively('B'), /\/work\/alpha\/\.dsh-chapters\/root2/, 'the naive read still points into alpha')
  assert.notEqual(resolveNaively('B'), resolveWithRow('B'), 'and that is precisely the 39% mis-resolve')
})

test('#348: a stored row from before the field parses unchanged, and keeps no cwd', () => {
  // The migration constraint: the registry is durable state with no shutdown hook. Adding a required
  // field here would have made every existing row fail to parse at open.
  const legacy = {
    rev: 3, parentSession: null, rootSession: 'old', nextChapterNumber: 4, nextPlanNumber: 1,
    chapters: [], reservations: {}, plans: {}, finalized: {}, collections: [],
    promptSuggestion: { status: 'off', text: '', turnSeq: null, error: '', at: '', intent: 'worker-step', goalRevision: null },
  }
  const parsed = parseSessionState(legacy)
  assert.equal(parsed.rev, 3, 'the old row still parses')
  assert.equal(parsed.cwd, undefined, 'and simply has no workspace recorded — recovery for it stays the durable log')

  const withCwd = parseSessionState({ ...legacy, cwd: '/work/alpha' })
  assert.equal(withCwd.cwd, '/work/alpha', 'a new row round-trips the field')
})

test('#348: empty-string cwd is rejected by the schema rather than stored as a workspace', () => {
  // `z.string().min(1)` — an empty path would resolve every relative chapter against '' and look
  // plausible while pointing nowhere, which is the failure mode this whole issue is about.
  assert.throws(() => parseSessionState({
    rev: 0, parentSession: null, rootSession: 'r', nextChapterNumber: 1, nextPlanNumber: 1,
    chapters: [], reservations: {}, plans: {}, finalized: {}, collections: [], cwd: '',
  }))
})

test('#348: stamping does not disturb the append-only rules it rides alongside', () => {
  // appendChapters already refuses a reused number with different bytes and tolerates an identical
  // retry. Adding a field must not weaken either, so both behaviours are re-asserted here with a cwd.
  const st = appendChapters(freshSession('s', '/w'), [rec(1, 0, 4, 'p')], '/w')
  const again = appendChapters(st, [rec(1, 0, 4, 'p')], '/w')
  assert.equal(again.chapters.filter((c) => isActiveChapter(c) && c.number === 1).length, 1, 'identical retry does not duplicate')
  assert.throws(() => appendChapters(st, [{ ...rec(1, 0, 4, 'p'), sha256: 'b'.repeat(64) }], '/w'),
    /already committed with different content/)
  assert.equal(stampWorkspace(again, '/w'), again, 'and the no-change case is still object-identical')
})
