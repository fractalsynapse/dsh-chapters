/**
 * The prompt-bytes anchor (#156) — what a tape corpus is really pinned to.
 *
 * `BUILD_STAMP.json` hashed the whole built bundle, so it could not tell two opposite situations apart: a
 * diagnostics-only change (no model-facing byte moved → the tapes still match, and only the stamp needs re-taking) and a
 * prompt change (the system prompt, a tool description, a realm threshold that reaches the model → every recorded prefix
 * is stale and a re-record is mandatory). Measured 2026-10-28: after #152/#153 added note fields, `corpus:check` shouted
 * "re-record" while CI's nine-leg acceptance was legitimately green, and nothing in CI ran the check at all.
 *
 * So the anchor is computed over the TEXT A MODEL SEES, extracted from the files that author it:
 *  - `.ts` sources: their string literals (comments and code moves cannot change it; a description or prompt template can)
 *  - `cordis.patch.yml`: `key: value` scalars on non-comment lines (thresholds that reach the model)
 *
 * Pure: `promptAnchorOf(map)` takes the extracted tokens and hashes them, so the rows can feed mutated inputs without
 * touching the repository. Reading files is a separate function.
 */
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** The files whose bytes reach the model. Adding a file here is a deliberate act: it becomes part of every anchor. */
export const PROMPT_SURFACE = [
  'cordis.patch.yml',
  'src/tools.ts',
  'src/commands.ts',
]

/**
 * #362: `src/preset.ts` used to be listed here and has been REMOVED, because it holds no model-facing
 * bytes at all — the chapters persona is `cordis.patch.yml`'s `prefix`/`suffix` (covered by
 * `yamlScalars`), and preset.ts is the declaration-row mirror: types, ids, and JSDoc. The manifest entry
 * was hashing comment prose, which is both false assurance (it claimed to protect persona text that
 * lives elsewhere) and a false alarm (any comment edit declared the corpus stale). A tripwire row in
 * `tests/unit/prompt-anchor.test.ts` fails if persona literals ever appear in that file, so this removal
 * cannot quietly become a hole.
 *
 * NOT covered today, stated rather than implied: `src/continue-core.ts` (the TOC notice body), `src/render.ts` and
 * `src/engine.ts` build their model-facing text from runtime-composed strings, so no static rule captures them — the
 * first draft of this module listed them and produced **zero** tokens for each, which is a silent false assurance.
 * `anchorCoverage()` below makes a manifest file contributing nothing a FAILURE, so the day someone adds a rule here it
 * cannot quietly stop matching. The host's own checkpoint preamble ("this is an automatically generated checkpoint…") is
 * not ours at all — `src/injections.ts:137` only screens it — so it belongs to a host-version gate, not this one.
 */

/**
 * Model-facing literals of a TS source — deliberately NOT "every string literal".
 *
 * That over-broad version failed its own first smoke test: a diagnostic label (`diagnosticNote(logger, 'realm:engine:x', …)`)
 * is a string literal, and #152/#153 added exactly those, so the naive anchor would have demanded a full re-record for a
 * change no model ever sees. The tokens here are the ones the host puts in front of a model: a tool/command/parameter
 * `description`, a dock `label`, a persona/prompt value.
 *
 * #362 removed the `wholeFile` mode this used to support for `src/preset.ts`. Its premise ("whose file is wholly
 * model-facing, so it is taken in full") was false — the persona is `cordis.patch.yml`'s `prefix`/`suffix` — and the
 * mechanism was worse than the premise. The matcher was `'([^'\n]*)'`, so TWO apostrophes on ONE line of ordinary
 * JSDoc (`the host's view: it's …`) manufactured a "literal" out of the prose between them; a lone apostrophe was
 * skipped. Every one of that file's 12 tokens was such a JSDoc fragment, never a shipped byte. A comment-only edit
 * therefore moved `promptAnchor` and declared the corpus stale — measured on #339's fix, `dd3f545d` → `37a2415b`
 * with the token COUNT unchanged at 77. A gate that fires on prose nobody ships is the #156 lesson pointed back at
 * this file.
 */
export function tsStringLiterals(text) {
  const keys = /\b(description|label|personaPrompt|systemPrompt|promptText)\s*:\s*(?:'([^'\n]*)'|"((?:[^"\\]|\\.){2,})"|`([^`$]*)`)/g
  const out = []
  let m
  while ((m = keys.exec(text)) !== null) {
    const key = m[1]
    const v = (m[2] ?? m[3] ?? m[4] ?? '').trim()
    if (v.length > 0) out.push(`${key}=${v}`)
  }
  return out
}

/**
 * Realm scalars that change what the model is asked to do. A whitelist, not all YAML: `maxBytes`, artifact-store paths
 * and logging keys are ours alone and must not force a re-record.
 */
export const REALM_KEYS = new Set([
  'thresholdRatio', 'retainRatio', 'retainTokens', 'maxTokens', 'headroomTokens',
  'compactionRetries', 'maxOverflowRetries', 'summarizationProvider', 'summarizationModel',
  'toolResultArtifactTokens', 'toolResultDeferFloorTokens', 'chapterTokenTarget',
  'continuationBudgetRatio', 'autoRuleGeneration', 'name', 'order',
])
export function yamlScalars(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.length === 0 || t.startsWith('#')) continue
    const m = /^([A-Za-z0-9_.-]+):\s+(\S.*)$/.exec(t)
    if (m && REALM_KEYS.has(m[1])) out.push(`${m[1]}=${m[2].trim()}`)
  }
  return out
}

/**
 * Extract the model-facing tokens of one file. YAML goes through the realm-key whitelist; every TS
 * file through the same literal rule. (#362: `src/preset.ts` used to be "taken in full" on the claim
 * that it is the persona file. It is not — see the manifest note above.)
 */
export function extractTokens(path, text) {
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return yamlScalars(text)
  return tsStringLiterals(text)
}

/** Deterministic anchor: sorted tokens, so a line moving cannot look like a byte changing. */
export function promptAnchorOf(byFile) {
  const all = []
  for (const [path, tokens] of byFile) all.push(...tokens.map((t) => `${path}\u0000${t}`))
  all.sort()
  return createHash('sha256').update(all.join('\n')).digest('hex').slice(0, 16)
}

/** Per-file token counts, so an empty rule is a loud failure rather than an unprotested claim. */
export function anchorCoverage(root, files = PROMPT_SURFACE) {
  const fs = []
  for (const f of files) {
    const abs = join(root, f)
    fs.push({ file: f, tokens: existsSync(abs) ? extractTokens(f, readFileSync(abs, 'utf8')).length : -1 })
  }
  return fs
}

/** Read the surface from a repo root; missing files are reported, never silently skipped (#61: a delivered failure). */
export function promptAnchorFor(root, files = PROMPT_SURFACE) {
  const byFile = []
  const missing = []
  for (const f of files) {
    const abs = join(root, f)
    if (!existsSync(abs)) { missing.push(f); continue }
    byFile.push([f, extractTokens(f, readFileSync(abs, 'utf8'))])
  }
  return { anchor: promptAnchorOf(byFile), missing, files: byFile.length }
}
