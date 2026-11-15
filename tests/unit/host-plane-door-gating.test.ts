/**
 * #341 — the host-plane doors are gated independently.
 *
 * `apply()` has no deterministic harness (it needs the whole cordis context), which is precisely how
 * the suggested-next-step door and the #319 reload self-check ended up nested inside
 * `if (config.subagentAutoSave)`: nothing observed the wiring, so turning archiving off silently
 * silenced the prompt bar while `/chapters-prompt` kept reporting ON. A behaviour row is therefore
 * not available here; the honest substitute is a structural row over the real source — the same
 * shape `prompt-bar.test.ts` uses to pin "the client wires a real verifier".
 *
 * The scanner is a brace-depth walk of `src/index.ts` with comments excluded, so a re-nesting —
 * however it is introduced, including by a reformat that moves a brace — turns this red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const src = readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8').split('\n')

/** Strip line comments and block-comment bodies so braces in prose cannot move the depth. */
function codeLines(): string[] {
  const out: string[] = []
  let inBlock = false
  for (const raw of src) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) { out.push(''); continue }
      line = line.slice(end + 2); inBlock = false
    }
    for (;;) {
      const start = line.indexOf('/*')
      if (start === -1) break
      const close = line.indexOf('*/', start + 2)
      if (close === -1) { line = line.slice(0, start); inBlock = true; break }
      line = line.slice(0, start) + line.slice(close + 2)
    }
    // string/template bodies could hold braces; strip single-quoted and template segments for the
    // purposes of DEPTH ONLY (we never evaluate the code).
    line = line.replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, '``')
    out.push(line.replace(/\/\/.*$/, ''))
  }
  return out
}

/** 1-based line number → brace depth at END OF LINE, over comment-stripped code. */
function depths(): number[] {
  const code = codeLines()
  const d: number[] = []
  let cur = 0
  for (const l of code) {
    for (const ch of l) { if (ch === '{') cur++; else if (ch === '}') cur-- }
    d.push(cur)
  }
  return d
}

/** Find the single line matching `re` (asserts uniqueness so a rename cannot vacuate the row). */
function only(re: RegExp, what: string): number {
  const hits = src.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0)
  assert.equal(hits.length, 1, `expected exactly one line matching ${re} for ${what}, found ${hits.length} (line ${hits.join(', ')}) — update this row, do not let it read an empty set as green`)
  return hits[0]! + 1
}

/** The line range of the block that OPENS on `startLine` (1-based, inclusive of the closing brace). */
function blockRange(startLine: number, d: number[]): [number, number] {
  const before = d[startLine - 2] ?? 0
  for (let i = startLine; i < d.length; i++) if (d[i - 1] === before) return [startLine, i]
  throw new Error(`unterminated block at line ${startLine}`)
}

test('#341: subagentAutoSave gates ONLY the settlement archiver', () => {
  const d = depths()
  const gate = only(/^\s*if \(config\.subagentAutoSave\) \{/, 'the subagentAutoSave gate')
  const [gs, ge] = blockRange(gate, d)

  const inside = (n: number): boolean => n >= gs && n <= ge
  const promptRunner = only(/const promptRunner = makePromptRoundRunner\(/, 'the suggested-next-step door')
  const reloadCheck = only(/const reloadSelfCheck = makeReloadSelfCheckListener\(/, 'the #319 reload self-check')
  const eventDoor = only(/ctx\.on\?\.\('session\/event'/, "the prompt plane's session/event registration")
  const autoSave = only(/ctx\.on\?\.\('subagent\/end'/, 'the settlement archiver registration')

  assert.equal(inside(promptRunner), false, `the prompt door (line ${promptRunner}) is nested inside subagentAutoSave (${gs}-${ge}) — turning archiving off would silently kill suggestions while /chapters-prompt still reports ON (#341)`)
  assert.equal(inside(reloadCheck), false, `the reload self-check (line ${reloadCheck}) is nested inside subagentAutoSave (${gs}-${ge}) — #319 part 3's seed-doom detector would vanish with the flag`)
  assert.equal(inside(eventDoor), false, `the session/event registration (line ${eventDoor}) is nested inside subagentAutoSave (${gs}-${ge})`)
  assert.equal(inside(autoSave), true, `the settlement archiver (line ${autoSave}) must stay INSIDE its own gate (${gs}-${ge})`)
})

test('#341: the prompt plane keeps its own switch — the model spec, not a boolean', () => {
  // The prompt door must be gated by the model being set ("the model IS the enable", one knob). If
  // someone re-adds a second boolean or re-keys it to another config flag, this catches the drift.
  const d = depths()
  const gate = only(/^\s*if \(config\.subagentAutoSave\) \{/, 'the subagentAutoSave gate')
  const promptRunner = only(/const promptRunner = makePromptRoundRunner\(/, 'the suggested-next-step door')
  const enabled = only(/enabled: \(\) => prompt\.effective\(\)\.spec !== ''/, "the prompt door's own model-set enable")
  assert.ok(enabled > promptRunner && enabled < promptRunner + 12, 'the door is enabled by its effective model spec')
  // And that predicate is not additionally conditioned on any config boolean.
  const line = src[enabled - 1]!
  assert.match(line, /spec !== ''/, 'enable == a prompt model is configured')
  assert.doesNotMatch(line, /config\.(subagentAutoSave|[a-zA-Z]*[Ee]nabled)/, 'the enable gained a second condition — the model spec is the only switch')
  assert.ok(gate > promptRunner, 'the settlement gate sits after the prompt door, so the door cannot be re-nested by a reformat alone')
  void d
})
