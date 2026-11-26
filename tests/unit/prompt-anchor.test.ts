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

// ───────────────────────────────────────────── #362: comments are not model-facing bytes

test('#362: editing a COMMENT in a manifest file cannot move the anchor', async () => {
  // The regression this closes: `src/preset.ts` was hashed whole-file, so an apostrophe in JSDoc
  // opened a quoted span running to the next quote and swallowed the code between them. Every one of
  // that file's tokens was comment prose, and a comment-only edit moved `promptAnchor` (measured on
  // #339: dd3f545d -> 37a2415b with the token count unchanged at 77) — declaring a green corpus stale.
  const { extractTokens } = await import('../../scripts/prompt-anchor.mjs')
  const src = fs.readFileSync('src/tools.ts', 'utf8')
  const base = extractTokens('src/tools.ts', src)
  // The mechanism, narrowed by mutation testing rather than assumed: the whole-file regex matched
  // `'([^'\n]*)'`, so a bogus "literal" needs TWO apostrophes on ONE line — the text between them. One
  // lone apostrophe is skipped and the digest is unchanged, which is why an earlier draft of this row
  // (a comment with a single `host's`) passed against the broken extractor and proved nothing. Real JSDoc
  // routinely carries two (`the host's … it's …`), which is exactly why #339's comment edit moved the anchor.
  const commented = extractTokens('src/tools.ts', src.replace('export function', "// the host's own view: it's unchanged\nexport function"))
  assert.deepEqual(commented, base, 'a pure comment insertion — with two apostrophes on one line — changes nothing the model sees')
  // And the mutation the OTHER way still fires: a real description is a corpus change.
  const literalChanged = extractTokens('src/tools.ts', src.replace(/description: '([^'\n]{20,})'/, "description: 'ZZZ rewritten tool description ZZZ'"))
  assert.notDeepEqual(literalChanged, base, 'a rewritten description MUST move the anchor — this fix cannot pass by hashing nothing')
})

// #362 removed preset.ts wholesale; #526 moved STATIC tool rows INTO that file, and the #362
// note's own warning applies: bytes the model reads must not leave the anchor's sight. The fix is
// the NARROW rule — row names inside VERSIONED_ROWS are covered, everything else in the file is
// not (that was the legitimate half of #362's complaint: comments and ids must not move it).
test('#526: preset.ts is in the manifest via the row-name rule ONLY — the relocated bytes stay covered', async () => {
  const { PROMPT_SURFACE, extractTokens } = await import('../../scripts/prompt-anchor.mjs')
  assert.ok(PROMPT_SURFACE.includes('src/preset.ts'),
    '#526: a file whose code composes model-facing tool rows belongs in the anchor')
  const src = fs.readFileSync('src/preset.ts', 'utf8')
  const rows = extractTokens('src/preset.ts', src)
  assert.ok(rows.length >= 1, 'the anchor must see the VERSIONED_ROWS tool names — an empty rule is the #156 silent false assurance')
  assert.ok(rows.every((t) => t.startsWith('name=')), `only row names may come from this file, got ${JSON.stringify(rows.slice(0, 3))}`)
  // The token SHAPE matches the YAML rule, so a row moving from patch to code is the same content
  // under a new path — here is the byte-level proof the move was a relocation, not a invention:
  assert.ok(rows.includes("name='@deepseek-ai/dsh-tool-subagent-control/list-agents'"),
    'the list-agents row the patch used to declare statically is the very token the code now carries')
  // Comments cannot move it (the #362 grievance, honored): a two-apostrophe JSDoc insert changes nothing.
  const commented = extractTokens('src/preset.ts', src.replace('export const VERSIONED_ROWS', "// the host's own view: it's just prose\nexport const VERSIONED_ROWS"))
  assert.deepEqual(commented, rows, 'comment prose — even with paired apostrophes — is not a model-facing byte')
  // Renaming a row MUST move it: this is the half the old full-file removal could no longer catch.
  const renamed = extractTokens('src/preset.ts', src.replace("name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'", "name: '@deepseek-ai/dsh-tool-subagent-control/renamed-row'"))
  assert.notDeepEqual(renamed, rows, 'a rewritten row name MUST move the anchor')
  // Persona prose staying OUT of this file is still true, and still policed (the #362 tripwire):
  const personaish = /\b(prefix|suffix|personaPrompt|systemPrompt|promptText)\s*:\s*['"`]/.exec(src)
  assert.equal(personaish, null,
    `src/preset.ts gained persona text (${personaish?.[0]}) — the narrow rule is not a license for persona bytes`)
})

// #540: the anchor measures the TEXT A MODEL SEES — no more (a human-menu string that moves the
// digest teaches people to route around the guard, #362's own words), no less (bytes that vanish
// from the scan are the quiet escape, #526's lesson).
test('#540: human command-plane bytes are anchor-blind; model tool bytes are not', async () => {
  const { PROMPT_SURFACE, extractTokens } = await import('../../scripts/prompt-anchor.mjs')
  assert.equal(PROMPT_SURFACE.includes('src/commands.ts'), false,
    'commands.ts is the human menu plane (contract: human command text is not model-visible) — it left the manifest in #540')
  const cmds = fs.readFileSync('src/commands.ts', 'utf8')
  // tripwire: if this file ever registers a TOOL, its literals ARE model-facing and it returns.
  assert.equal(/ctx\.tools\.register|jsonOutput\(/.test(cmds), false,
    'src/commands.ts now registers tools — #540 removal must be reverted')
  // hint/description EDITS of commands are the docs-truth edits the old rule punished: they must not move anything
  const tools = fs.readFileSync('src/tools.ts', 'utf8')
  const t0 = extractTokens('src/tools.ts', tools)
  const door = extractTokens('src/tools.ts', tools.replace(
    "input: { hint: '[messageSeq] [title]' },", "input: { hint: 'CHANGED by a hint-truth fix' },"))
  assert.deepEqual(door, t0, 'a DOOR hint edit is human plane — it must not move the anchor')
  const toolDesc = extractTokens('src/tools.ts', tools.replace(/description: '([^'\n]{20,})'/, "description: 'ZZZ model-visible rewrite ZZZ'"))
  assert.notDeepEqual(toolDesc, t0, 'a TOOL description is model-visible — it MUST move the anchor')
  // the command OBJECTS are stripped whole: a repair/save description edit changes nothing scanned
  const saveDesc = extractTokens('src/tools.ts', tools.replace(
    "description: 'Save completed turns as searchable chapters without creating a new session.",
    "description: 'CHANGED save menu text — human plane only."))
  assert.deepEqual(saveDesc, t0, 'the /chapters-save description is menu text, not model text')
})
