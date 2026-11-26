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
/**
 * #540: `src/commands.ts` REMOVED from the manifest. The anchor's premise (#156) is "the TEXT A
 * MODEL SEES", and this file is the human menu plane: its descriptions and hints render in the
 * slash list, and command text is measured NOT model-visible (docs/contract.md: "human command
 * text is not model-visible"; command output never enters the model context, §7.2). Hashing them
 * made doc-truth edits — correcting a hint to match its own handler! — declare the whole corpus
 * stale for bytes no request ever carried: #362's "measures more than the model sees" failure in
 * a new costume. A tripwire row pins that no tool-registration literal enters this file; if one
 * ever does, the file comes back.
 *
 * #540 part 2: within src/tools.ts, the COMMAND-shape blocks (objects carrying `input: { hint:`
 * — the door commands /chapters-fork, /chapters-continue, /chapters-save, /chapters-repair) are
 * filtered out; the chapters_* TOOL blocks (no hint key) stay. Tool descriptions are model bytes;
 * door descriptions are the same human menu plane as commands.ts.
 */
export const PROMPT_SURFACE = [
  'cordis.patch.yml',
  'src/tools.ts',
  // #526: in, but NARROWLY (versionedRowNames below): the dynamic-append rows (VERSIONED_ROWS)
  // name tools the model reads in its tool list — bytes that used to be static YAML scalars. An
  // anchor that covers the YAML but not the code that replaced it is the #362 note's "opposite
  // failure" verbatim. Only the row-name literals inside that one block count; comments, ids, and
  // every other line cannot move the anchor — which was the legitimate half of #362's complaint.
  // (src/commands.ts STAYS OUT: #540 — the human menu plane, measured not model-visible.)
  'src/preset.ts',
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
 * #526: the VERSIONED_ROWS block's tool-name literals — the ONLY model-facing bytes in preset.ts.
 * Token shape matches yamlScalars exactly (`name='…'`) so a row MOVING from the patch into the
 * code reads as the same content under a new path, not as a new kind of thing.
 */
export function versionedRowNames(text) {
  const i = text.indexOf('VERSIONED_ROWS')
  if (i < 0) return []
  const end = text.indexOf('\n]', i)
  if (end < 0) return []
  const block = text.slice(i, end)
  const out = []
  for (const m of block.matchAll(/\bname:\s*'([^'\n]+)'/g)) out.push(`name='${m[1]}'`)
  return out
}

/**
 * Extract the model-facing tokens of one file. YAML goes through the realm-key whitelist;
 * src/preset.ts through the row-name rule alone (#526); every other TS file through the literal rule.
 * (#362: preset.ts used to be "taken in full" on the claim it is the persona file. It is not —
 * full-file extraction stayed wrong; the NARROW rule is the correction.)
 */
/**
 * #540: strip the HUMAN command objects from a TS file before literal extraction. A command object
 * is identifiable structurally — it carries `input: { hint:`; tool objects carry parameter schemas and
 * an output schema instead. The strip spans from the `name:` line of each such object through the end
 * of its `input:` line; descriptions inside are menu text, not model text.
 */
export function withoutCommandBlocks(text) {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = /\bname: '(chapters-[a-z-]+)'/.exec(lines[i])
    if (m !== null) {
      // look ahead (the object header, within a few lines) for the command shape marker
      const head = lines.slice(i, i + 6).join('\n')
      if (/input:\s*\{\s*hint:/.test(head)) {
        let j = i
        while (j < lines.length && !/input:\s*\{\s*hint:/.test(lines[j])) j += 1
        i = j // skip the name/description/hint header lines of the human command object
        continue
      }
    }
    out.push(lines[i])
  }
  return out.join('\n')
}

export function extractTokens(path, text) {
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return yamlScalars(text)
  if (path === 'src/tools.ts') return tsStringLiterals(withoutCommandBlocks(text))
  if (path === 'src/preset.ts') return versionedRowNames(text)
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
