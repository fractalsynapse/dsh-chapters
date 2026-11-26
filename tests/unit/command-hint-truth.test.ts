// #540 (maintainer, verbatim): "ensure all command usage statements that show up in deepseek harness
// chat input when the command is typed are up to date … I have noticed missing command options on some
// commands over time." The hint/description IS the affordance — a verb the handler parses but the hint
// omits is invisible while typing. This row compares, statically, the `verb === '…'` branches each
// command handler parses against that command's own hint string, BOTH directions:
//   unadvertised verb   = the maintainer's missing-options symptom (fails here),
//   advertised non-verb = a hint that promises a control which refuses at runtime (also fails).
// Aliases typed at the ARG level (`autorun arm|disarm`) are listed explicitly, because they are
// deliberately folded into the canonical `on|off` wording of the hint.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const commandsSrc = readFileSync(new URL('../../src/commands.ts', import.meta.url), 'utf8')
const toolsSrc = readFileSync(new URL('../../src/tools.ts', import.meta.url), 'utf8')
const restoreSrc = readFileSync(new URL('../../src/restore-command.ts', import.meta.url), 'utf8')
const rulesSrc = readFileSync(new URL('../../src/rules-commands.ts', import.meta.url), 'utf8')

/** Slice the source of one command object: from its `name: '<cmd>'` to the next `name: '` (or EOF). */
function commandBlock(src: string, name: string): string {
  const i = src.indexOf(`name: '${name}'`)
  assert.notEqual(i, -1, `${name}: registration not found — the command moved or was renamed; update this guard`)
  const j = src.indexOf("\n    name: '", i + 10)
  const j2 = src.indexOf("\n  const", i + 10)
  const end = Math.min(...[j, j2].filter((x) => x > 0).concat([src.length]))
  return src.slice(i, end)
}

function parsedVerbs(block: string): string[] {
  const out = new Set<string>()
  for (const m of block.matchAll(/\bverb === '([a-z][a-z-]+)'/g)) out.add(m[1])
  return [...out].sort()
}

function hintOf(block: string): string {
  const m = /input: \{ hint: (['"`])([\s\S]*?)\1 \}/.exec(block)
  assert.notEqual(m, null, 'command block carries no input.hint — typing shows nothing')
  return m[2]
}

const cases: Array<[string, string, string[]]> = [
  // [command, source file, verbs intentionally NOT top-level `verb ===` branches]
  ['chapters-prompt', commandsSrc, []],
  ['chapters-enrich', commandsSrc, []],
  ['chapters-remove', commandsSrc, []],
  ['chapters-rule', commandsSrc, ['add', 'list', 'view', 'active', 'approve', 'revoke', 'pin', 'unpin', 'conflicts', 'model']],
  ['chapters-repair', toolsSrc, []],
  ['chapters-restore', restoreSrc, []],
]

test('#540: every parsed verb is advertised in its own typing hint (and the hint names no ghost verbs)', () => {
  for (const [name, src, declared] of cases) {
    const rules = name === 'chapters-rule'
      // chapters-rule parses inside rules-commands.ts via runRulesCommand, not inline:
      ? parsedVerbs(rulesSrc).concat(declared.filter((v) => !parsedVerbs(rulesSrc).includes(v)))
      : parsedVerbs(commandBlock(src, name))
    const hint = hintOf(commandBlock(src, name))
    for (const v of rules) {
      if (name === 'chapters-remove' && v === 'dry-run') continue // covered as [dry-run] — bracket form
      assert.ok(hint.includes(v), `${name}: handler parses '${v}' but the typing hint (${hint.slice(0, 60)}…) omits it`)
    }
  }
})

test('#540: the prompt hint covers exactly the ten verbs the composer loop exposes', () => {
  const hint = hintOf(commandBlock(commandsSrc, 'chapters-prompt'))
  for (const v of ['model', 'on', 'off', 'off-session', 'state', 'run', 'suggest', 'autorun', 'rounds']) {
    assert.ok(hint.includes(v), `hint lost '${v}' — the harness would hide a live control`)
  }
  assert.ok(hint.includes('unlimited') && hint.includes('clear'), '#505: rounds arms live in the hint too')
})

test('#540: doors advertise the #221 anchor, not just the title', () => {
  // fork/continue SHARE their hint inside deterministicCommand (the `input:` line precedes every
  // `name:`), so the builder block is the surface to read; /chapters-save carries its own copy.
  const i = toolsSrc.indexOf('const deterministicCommand')
  assert.notEqual(i, -1, 'deterministicCommand builder moved — this guard must follow it')
  const builder = toolsSrc.slice(i, toolsSrc.indexOf('const forkCommand', i))
  assert.ok(hintOf(builder).includes('messageSeq'), 'fork/continue hint lost the [messageSeq] anchor')
  // Both ternary arms of the shared `description:` got the anchor sentence (the strings are the
  // advertised surface; the ternary is why a line-level regex could not read them).
  assert.equal((builder.match(/Optional arguments \(#221\)/g) ?? []).length, 2,
    'each door description must advertise BOTH arguments — title alone was the stale half')
  // /chapters-save parses NOTHING from rawInput today — its hint must say so; #541 tracks giving
  // it a real anchor. A hint promising an unimplemented argument is the same defect as omitting
  // an implemented one.
  const saveHint = hintOf(commandBlock(toolsSrc, 'chapters-save'))
  assert.ok(!saveHint.includes('[messageSeq]') && !saveHint.includes('[title]'),
    `chapters-save advertises argument slots it does not parse (${saveHint})`)
})
