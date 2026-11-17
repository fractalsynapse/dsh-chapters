/**
 * #355 item Z — host-shaped readers are checked against the INSTALLED dist, in both directions.
 *
 * The rule in AGENTS is "inspect actual host payload fields and use fixtures of the real shape". This
 * release found that rule three times in the breach, each time because a test asserted against a
 * hand-written fixture that matched the code's assumption rather than the host's declaration:
 *
 *  - #345: `toolResultIsError` read `isError` off the CONTENT BLOCK. The installed `@deepseek-ai/dsh-llm`
 *    declares it on `ToolResultMessage`, and real logs agreed — 13 failures on `data.message`, **zero** on
 *    a block — so the reader returned false for every failed call in every log, and `plans.ts` feeds the
 *    plan verdict from it.
 *  - #339: the row-health witness compared cordis' `fiberState` to the string `'active'`. `FiberState` is a
 *    numeric `const enum`, so the comparison is false under every condition — `all active`, forever,
 *    including during the week a foreign engine was compacting chapters sessions.
 *
 * So this file parses the installed packages and asserts BOTH halves of the contract: what the host
 * declares, and what our code does with it. Every search that must find something **throws** when it does
 * not — the vacuous-match failure mode that made the first version of the corpus gate (#389) report a
 * false all-clear is the thing most likely to go wrong in a test like this one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function pkgTypes(name: string): { dir: string; version: string } {
  const pkgJson = require.resolve(`@deepseek-ai/${name}/package.json`)
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string; types?: string; typings?: string }
  return { dir: dirname(pkgJson), version: pkg.version }
}

function readDeclared(name: string, rel: string): string {
  const { dir } = pkgTypes(name)
  const file = join(dir, rel)
  // Non-vacuous by construction: a moved or renamed declaration must fail the run, not silently produce
  // an empty body for the assertions below to "pass" against.
  assert.ok(existsSync(file), `installed declaration missing: ${file} — this gate can no longer verify the shape it was written for`)
  return readFileSync(file, 'utf8')
}

/** Extract one interface body by name, or throw. */
/**
 * Find `interface Name [...] {` — the `extends`/generic clause is optional but MUST be allowed for:
 * the real declaration is `interface ToolResultMessage extends MessageBase {`, and a literal
 * `interface X {` search misses it. That mismatch is what made this row fail on first run, and the fix
 * is in the finder, not in the assertion — a host type is not obliged to be written the way I guessed.
 */
function interfaceBody(src: string, name: string): string {
  const re = new RegExp(`interface ${name}(?:\\s+extends\\s+[A-Za-z0-9_<>,. \\|]+?)?\\s*\\{`)
  const m = re.exec(src)
  assert.ok(m !== null, `interface ${name} not found in the installed dist — the host type moved or was renamed`)
  const start = m.index
  const brace = src.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(brace + 1, i) }
  }
  throw new Error(`unbalanced declaration for ${name}`)
}

test('#Z: the installed dsh-llm declares isError at MESSAGE level and not on a content block', () => {
  const { version } = pkgTypes('dsh-llm')
  const src = readDeclared('dsh-llm', 'lib/types/message.d.ts')
  const body = interfaceBody(src, 'ToolResultMessage')
  assert.match(body, /\bisError\?\s*:\s*boolean/,
    `ToolResultMessage must declare isError (installed dsh-llm ${version}) — if the host moved it, `
    + 'the reader must move with it in the same change')

  // The #345 defect, expressed as a constraint on the host: there is no block-level isError to read.
  const blockNames = ['TextBlock', 'ContentBlock', 'ToolResultBlock', 'ToolCallBlock']
  for (const b of blockNames) {
    const i = new RegExp(`interface ${b}(?:\\s+extends\\s+[A-Za-z0-9_<>,. \\|]+?)?\\s*\\{`).exec(src)?.index ?? -1
    if (i < 0) continue // not every build declares all of these by these names
    assert.doesNotMatch(interfaceBody(src, b), /\bisError\b/,
      `${b} now declares isError — the block-level fallback in toolResultIsError stops being a legacy arm `
      + 'and becomes the primary read; update src/log-shape.ts and #345 in the same change')
  }
  const hits = (src.match(/\bisError\b/g) ?? []).length
  assert.ok(hits >= 1, 'the scan found no isError anywhere — the parser is broken, not the host changed')
  console.log(`    #Z dsh-llm ${version}: isError declared ${hits}× in message.d.ts, message-level confirmed`)
})

test('#Z: the installed cordis declares FiberState as a NUMERIC const enum', () => {
  const { version } = pkgTypes('cordis')
  const src = readDeclared('cordis', 'lib/types/fiber.d.ts')
  const decl = /export declare const enum FiberState \{([^}]*)\}/.exec(src)
  assert.ok(decl !== null,
    `FiberState is no longer a numeric const enum in cordis ${version} — #361's numeric comparison is now `
    + 'the wrong shape and must be re-derived, not left to silently match nothing')
  const members = decl![1]!
  assert.match(members, /ACTIVE\s*=\s*\d/, 'ACTIVE must be numeric')
  assert.match(members, /PENDING\s*=\s*0/, 'and the enum starts at 0')
  // Explicitly: no quoted member. A string union would make `state === 2` always false — the mirror of
  // the bug this file exists to prevent, arriving from the host side instead of ours.
  assert.doesNotMatch(members, /=\s*['"]/, `FiberState gained string members: ${members.trim()}`)
  console.log(`    #Z cordis ${version}: FiberState { ${members.trim().replace(/\s+/g, ' ')} }`)
})

test('#Z: our readers match the declared shape — the direction the host cannot check for us', () => {
  const logShape = readFileSync(join(process.cwd(), 'src/log-shape.ts'), 'utf8')
  // #345's fix must still read the MESSAGE field first. If someone reverts to block-only, the dist facts
  // above stay green while the code is wrong again — so the code side is asserted here, not inferred.
  const fn = logShape.slice(logShape.indexOf('export function toolResultIsError'))
  assert.ok(fn.length > 100, 'toolResultIsError must exist — the gate has nothing to check without it')
  assert.match(fn, /message\??\.isError/, 'reads the message-level field the dist declares')
  assert.match(fn, /blocksOf\(/, 'and keeps the block arm as the documented 0.1.x fallback')

  const preset = readFileSync(join(process.cwd(), 'src/preset.ts'), 'utf8')
  // #339's defect in one line of source: a string compared to a number. Grep, not memory.
  const stringCompare = /\bfiberState\b[^=\n]*===\s*['"][^'"]+['"]/.exec(preset)
  assert.equal(stringCompare, null,
    `a string comparison against fiberState is back (${JSON.stringify(stringCompare?.[0])}) — FiberState is a `
    + 'numeric const enum, so this is always false and the row-health line reads "all active" unconditionally')
  assert.match(preset, /ACTIVE/, 'the numeric form is expected: reference the enum member or its numeric value')
})

test('#Z: the gate itself cannot pass vacuously', () => {
  // Meta-row: if pkgTypes/readDeclared/interfaceBody ever stop finding their target, they must THROW.
  assert.throws(() => interfaceBody('export interface Unrelated { a: 1 }', 'ToolResultMessage'),
    /not found in the installed dist/)
  assert.throws(() => readDeclared('dsh-llm', 'lib/types/definitely-not-here.d.ts'),
    /installed declaration missing/)
})
