/**
 * The prompt-bytes anchor (#156) — a tape corpus is pinned to what a model sees, not to what the build happened to be.
 *
 * Why each row exists: `BUILD_STAMP.json` hashed the whole bundle, so after #152/#153 added diagnostic-note fields it
 * demanded a full re-record while CI's nine-leg acceptance was legitimately green (no prompt byte moved), and the gate
 * that should reconcile them is never run in CI at all (`corpus:check` appears only in a comment in `ci.yml:136`). The
 * fix has to be *discriminating*: invariant under our own instrumentation, responsive to a description or a threshold.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  PROMPT_SURFACE, extractTokens, promptAnchorOf, promptAnchorFor, anchorCoverage,
} from '../../scripts/prompt-anchor.mjs'

const tools = () => extractTokens('src/tools.ts', `
  const t = { name: 'chapters_rules', description: 'Rules that govern this project', parameters: {} }
`)

test('a diagnostics-only change does not move the anchor — that is the whole point (#156)', () => {
  const before = promptAnchorOf([['src/tools.ts', tools()]])
  // Exactly what #152/#153 did: a comment, a new key, and a diagnostic label — none of it reaches a model.
  const after = promptAnchorOf([['src/tools.ts', (() => extractTokens('src/tools.ts', `
    // #143: the note must say what the pass removed.
    const t = { name: 'chapters_rules', description: 'Rules that govern this project', parameters: {} }
    diagnosticNote(logger, 'realm:engine:compactIfNeeded', \`shadowed=\${n}, shadowedTok=\${k}\`)
  `))()]] )
  assert.equal(after, before, 'instrumentation we ship must never demand a re-record')
})

test('a tool description moves the anchor, because a model reads it (#156)', () => {
  const before = promptAnchorOf([['src/tools.ts', tools()]])
  const after = promptAnchorOf([['src/tools.ts', extractTokens('src/tools.ts', `
    const t = { name: 'chapters_rules', description: 'Rules for planning a chapter arc', parameters: {} }
  `)]])
  assert.notEqual(after, before, 'a changed description changes what the model is told — the corpus is stale')
})

test('a realm threshold moves the anchor; a logging or path key does not (#156)', () => {
  const base = promptAnchorOf([['cordis.patch.yml', extractTokens('cordis.patch.yml', `
    - id: chapters-engine
      config:
        thresholdRatio: 0.9
        headroomTokens: 8192
  `)]])
  const thresholdMoved = promptAnchorOf([['cordis.patch.yml', extractTokens('cordis.patch.yml', `
    - id: chapters-engine
      config:
        thresholdRatio: 0.75
        headroomTokens: 8192
  `)]])
  const onlyBytes = promptAnchorOf([['cordis.patch.yml', extractTokens('cordis.patch.yml', `
    - id: chapters-engine
      config:
        thresholdRatio: 0.9
        headroomTokens: 8192
    - id: logging
      config:
        maxBytes: 131072
  `)]])
  assert.notEqual(thresholdMoved, base, 'the trigger ratio decides when relief fires — a corpus change')
  assert.equal(onlyBytes, base, 'our own log cap is not model-facing and must not force a re-record')
})

test('every file in the manifest actually contributes tokens, or the rule is silently dead (#156)', () => {
  const cov = anchorCoverage('.', PROMPT_SURFACE)
  const dead = cov.filter((c) => c.tokens <= 0).map((c) => `${c.file}: ${String(c.tokens)}`)
  assert.deepEqual(dead, [], `a manifest file with no tokens gives false assurance:\n  ${dead.join('\n  ')}`)
})

test('the anchor is stable across reads and order moves within a file (#156)', () => {
  const a = promptAnchorFor('.')
  const b = promptAnchorFor('.')
  assert.equal(a.anchor, b.anchor, 'deterministic or it cannot gate anything')
  const reordered = promptAnchorOf([['src/tools.ts', tools().slice().reverse()]])
  const normal = promptAnchorOf([['src/tools.ts', tools()]])
  assert.equal(reordered, normal, 'a line moving is not a byte changing')
})

/**
 * The stamp tool's two-verdict rule (#156), pinned as pure code rather than by mutating a working tree.
 *
 * `build-stamp.mjs` used to hash one thing — the bundle — and refuse on any difference, which conflated "a model saw
 * different bytes" (stale corpus: re-record) with "we shipped a different build" (bookkeeping: re-stamp). The rows feed
 * `verdictFor` directly so the semantics are the tested thing, and the import must stay side-effect free: a CLI module
 * that reads the corpus and calls `process.exit` at import time would silently kill the test runner that only wanted the
 * function — which is how the first draft of this guard behaved.
 */
test('a build-only difference advises; a prompt-byte difference refuses (#156)', async () => {
  const { verdictFor } = await import('../../scripts/build-stamp.mjs')
  const A = 'aaaaaaaaaaaaaaaa'
  const B = 'bbbbbbbbbbbbbbbb'

  const buildOnly = verdictFor({ promptAnchor: A, lib: A }, { promptAnchor: A, lib: B })
  assert.equal(buildOnly.stale, false, 'a diagnostics-only change must NOT demand a re-record (#152/#153)')
  assert.equal(buildOnly.advisories.length, 1, 'but it must say the stamp needs re-taking, not stay silent')
  assert.match(buildOnly.advisories[0], /tapes still match this build/, 'the advisory states why the run may proceed')

  const bytesMoved = verdictFor({ promptAnchor: A, lib: A }, { promptAnchor: B, lib: B })
  assert.equal(bytesMoved.stale, true, 'model-facing bytes changed: the recorded requests cannot be served')
  assert.equal(bytesMoved.advisories.length, 1, 'the build change is mentioned too, as a secondary fact')

  const predates = verdictFor({ lib: A }, { promptAnchor: B, lib: B })
  assert.equal(predates.stale, false, 'no recorded anchor cannot be compared — advise, never refuse on absence')
  assert.equal(predates.advisories.length, 2, 'and names both facts: no anchor on record, and a build that moved')
  assert.match(predates.advisories[0], /predates the prompt-byte anchor/, 'the missing anchor is stated first, since that is the gap in protection')

  const identical = verdictFor({ promptAnchor: A, lib: A }, { promptAnchor: A, lib: A })
  assert.equal(identical.stale, false, 'a matching corpus is a quiet corpus')
  assert.deepEqual(identical.advisories, [], 'no advisory noise when nothing moved')
})

test('importing the stamp tool does not read, write, or exit the process (#156)', async () => {
  // The guard is structural, so prove it by importing: if the CLI ran at import, this file would either rewrite the
  // corpus or the runner would die. Surviving the import at all IS the assertion.
  const stampPath = new URL('../../tests/fixtures/model-tape/BUILD_STAMP.json', import.meta.url)
  const before = fs.readFileSync(stampPath, 'utf8')
  const mod = await import('../../scripts/build-stamp.mjs')
  assert.equal(typeof mod.verdictFor, 'function', 'the pure helper is reachable')
  assert.equal(fs.readFileSync(stampPath, 'utf8'), before,
    'importing must not stamp, refuse, or rewrite the corpus — the CLI path belongs to `isCli`, not to the module' )
})
