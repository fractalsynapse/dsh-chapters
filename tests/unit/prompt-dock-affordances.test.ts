/**
 * #282 affordance pins for the Suggested Next Step dock: the click-state tooltips, the expanded-pane
 * collapse control, and the unknown-is-not-running doctrine the clear-on-run depends on. Source-scan
 * rows like prompt-dock-placement.test.ts, because the behaviours are one-attribute facts whose
 * absence is silent in the wire and loud in the chair.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOCK = fs.readFileSync(path.join(ROOT, 'src', 'client', 'prompt-dock.ts'), 'utf8')

test('#282+#309: the row tooltip names the click outcome per state, from ONE pure predicate', () => {
  const bar = fs.readFileSync(path.join(ROOT, 'src', 'client', 'prompt-bar.ts'), 'utf8')
  assert.ok(bar.includes('Click to expand the full suggested prompt'), 'collapsed names expand (rowTooltip now owns the strings, prompt-bar.ts)')
  assert.ok(bar.includes('Click to send this prompt to the chat input for editing'), 'expanded+empty names the composer handoff')
  assert.ok(bar.includes('Clear existing prompt to send this prompt to chat input'), 'expanded+occupied names the precondition')
})

test('#309: the row bubble rides the host tooltip seat — no native black bubble, no hand-off into a typed composer', () => {
  assert.doesNotMatch(DOCK, /title: state\.expanded/, 'the hard-coded native title is gone (the black-bubble foreign style)')
  assert.match(DOCK, /withTooltip\(rowTip/, 'the row button wraps in the themed seat, like the door buttons')
  assert.match(DOCK, /nativeTitle\(rowTip\)/, 'native only where the host seat is absent — never both')
  assert.match(DOCK, /if \(composerHasText\(\)\) \{ dispatch\(\{ t: 'note'/, 'the occupied-composer refusal says itself on the bar')
  assert.match(DOCK, /glyph: '▾'/, 'collapse folds DOWN — the maintainer\u2019s reading: we expand up, we collapse down')
  assert.doesNotMatch(DOCK, /glyph: '▴'/, 'the up-glyph cannot return')
  assert.match(DOCK, /const composerBox = \(\)/, 'one probe for the composer, shared by guard, focus, and verify')
  assert.match(DOCK, /querySelector<HTMLElement>\('\[data-composer-input\]'\)/, 'the host\'s own identifying attribute (ComposerContentEditable.tsx:46) — never a first() on a shared selector')
  assert.doesNotMatch(DOCK, /document\.querySelector<HTMLElement>\('\[contenteditable="true"\]\[role="textbox"\]'\)/, 'the bare first-match selector cannot return to any probe site')
})

test('#282: the expanded pane carries a collapse control wired to the reducer', () => {
  assert.match(DOCK, /t: 'collapse'/, 'collapse dispatches the existing reducer case (keeps the offer — only human/prompt or off dismisses it)')
  assert.match(DOCK, /dsh-chapters_promptCollapse/, 'with its own corner class')
})

test('#295: the collapse control lives in the action row — never floated over the prompt text', () => {
  assert.doesNotMatch(DOCK, /\.dsh-chapters_promptCollapse\{[^}]*position:absolute/, 'the overlay CSS is gone: the button and the text cannot fight for one pixel')
  assert.match(DOCK, /key: 'collapse'/, 'it is an expanded-conditional entry in the bar’s own actions row')
  // and the handoff gesture folds back on both success paths, never on a refusal
  const collapses = (DOCK.match(/dispatch\(\{ t: 'collapse' \}\)/g) ?? []).length
  assert.ok(collapses >= 3, `collapse dispatched by the action-row button AND both handoff success paths (saw ${String(collapses)})`)
  const refusalSite = DOCK.slice(DOCK.indexOf("if (!wrote) { refuse("), DOCK.indexOf("if (!wrote) { refuse(") + 30)
  assert.ok(!/collapse/.test(refusalSite), 'the refusal path does not collapse — the note must stay readable')
})

test('#282: unknown running is NOT running — the clear-on-run must never strand a non-publishing host', () => {
  assert.doesNotMatch(DOCK, /running \?\? true/, 'the #221 doctrine extended: `?? true` made an absent signal mean "a turn is in flight", which under clear-on-run would clear the bar forever')
  assert.match(DOCK, /running === true/, 'strict boolean: only a published true edge folds to running')
})

test('#291: the ✕ executes the session-scoped verb — never the plane-wide off', () => {
  assert.match(DOCK, /exec\('\/chapters-prompt off-session'\)/, 'the label and the verb now share one scope')
  assert.doesNotMatch(DOCK, /exec\('\/chapters-prompt off'\)/, 'the plane-wide verb is out of the dock entirely')
})

test('#300: the dock renders NO second message — the goal-edit fact lives only in the label', () => {
  assert.doesNotMatch(DOCK, /edits the goal · run it yourself/, 'the overflowing badge text is gone from the source')
  assert.doesNotMatch(DOCK, /promptIntent/, 'the class is gone entirely — label, element, and CSS (an unused rule is drift bait)')
})
