/**
 * #354 — the config surface drifted in both directions, silently, for a long time.
 *
 * Three independent drifts shared one cause: nothing compared the surfaces, so each could diverge
 * without any signal.
 *
 *  1. **Host plane**: 4 keys were in `Schema.object` but not the exported `Config` interface, so
 *     `tsc` forbade reading them there — and they are absent from the shipped realm row. An operator
 *     setting `noticeIndexCap` in a profile's plugin `config:` block got a value that parsed, validated
 *     and did nothing, while the user-facing table described it as a working knob. The
 *     `as Schema<Config>` cast is what hid the whole mismatch from the compiler.
 *  2. **Realm row**: 5 keys were destructured by the engine constructor but never declared in its zod
 *     — no default, no validation, invisible in the config editor. They arrived only because installed
 *     schemastery 3.18.2 preserves unknown keys, which is the accident the comment three lines from that
 *     destructure already records as a past bug ("destructured by the constructor, stripped by the
 *     schema"). A dependency on undocumented pass-through is a gate waiting to close.
 *  3. **Docs**: the patch header claimed to be "the complete configuration reference", 19 host keys were
 *     absent from it, two printed defaults were stale (4000/240 vs 32000/4096), and `harnessId` was
 *     listed as realm-row-only while being documented and read as a host key.
 *
 * These rows make each comparison mechanical, so drift is a failing test rather than an audit finding.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChaptersCompactionEngine } from '../../src/engine.ts'

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

/**
 * The engine row's declared defaults. Schemastery schemas are CALLABLE — `Cfg({})` applies defaults
 * and returns the resolved object (`.parse` / `.validate` do not exist on this API; a first draft of
 * this file assumed zod, because the import is aliased `z`, and failed with `Cfg.parse is not a
 * function`). Verified against the installed schemastery 3.18.2.
 */
function rowDefaults(): Record<string, unknown> {
  const Cfg = ChaptersCompactionEngine.Config as unknown as (v: Record<string, unknown>) => Record<string, unknown>
  return Cfg({})
}

/**
 * Every key the row schema DECLARES, defaulted or not.
 *
 * `Cfg({})` alone is not enough and the difference matters: it returns only keys that have a default
 * or a supplied value, so `artifactStoreRoot: z.string()` (declared, no default) looked undeclared and
 * this gate reported three false positives — the same "a gate that cries wolf" mistake #354 is about,
 * in my own test, caught on its first run. `dict` is the field map: the truth about declaration.
 */
function declaredRowKeys(): string[] {
  const Cfg = ChaptersCompactionEngine.Config as unknown as { dict?: Record<string, unknown> }
  assert.ok(Cfg.dict !== undefined && typeof Cfg.dict === 'object', 'schemastery no longer exposes `dict` — re-derive the declared key set, do not delete this gate')
  return Object.keys(Cfg.dict).sort()
}


/** Keys the host `Schema.object` accepts but the host plane provably cannot read. */
const DECLARED_INERT = ['knowledgeMirrorDir', 'noticeIndexCap', 'openRequestCarryMaxChars', 'lastResortArtifact']

function hostSchemaKeys(): string[] {
  const pkg = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
  assert.ok(pkg.length > 0)
  const src = read('src/index.ts')
  const start = src.indexOf('export const Config = Schema.object({')
  assert.ok(start >= 0, 'could not locate the host Config Schema literal — this gate is reading the wrong shape')
  // Walk to the matching close, then take top-level `key:` tokens.
  let i = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = j; break } }
  }
  assert.ok(end > i, 'unbalanced Schema.object literal')
  const body = src.slice(i, end)
  const keys = new Set<string>()
  for (const m of body.matchAll(/(?:^|\n)\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:/g)) keys.add(m[1]!)
  return [...keys].sort()
}

function hostInterfaceKeys(): string[] {
  const src = read('src/index.ts')
  const start = src.indexOf('export interface Config {')
  assert.ok(start >= 0, 'could not locate the exported Config interface')
  const end = src.indexOf('\n}', start)
  const body = src.slice(start, end)
  const keys = new Set<string>()
  for (const m of body.matchAll(/(?:^|\n)\s{2}([A-Za-z][A-Za-z0-9_]*)[?]?\s*:/g)) keys.add(m[1]!)
  return [...keys].sort()
}

test('#354: every host Schema key is either readable on the host plane or declared INERT, documented and inert', () => {
  const schema = hostSchemaKeys()
  const iface = new Set(hostInterfaceKeys())
  const undeclaredInert = schema.filter((k) => !iface.has(k) && !DECLARED_INERT.includes(k))
  assert.deepEqual(undeclaredInert, [],
    `host config keys the host plane cannot read and this file does not know about: ${undeclaredInert.join(', ')} — either read them on this plane, or add them to DECLARED_INERT AND mark them inert in cordis.patch.yml and the site reference`)
  // The inert list must be genuinely inert, not a place to hide readable keys.
  for (const k of DECLARED_INERT) {
    assert.equal(iface.has(k), false, `${k} is now in the Config interface — remove it from DECLARED_INERT (it is no longer inert)`)
    assert.ok(schema.includes(k), `${k} left the host Schema.object — a profile patch that sets it would now FAIL to parse; that is a breaking change to decide, not drift to notice`)
  }
  assert.ok(schema.length >= 40, `the Schema scan found ${String(schema.length)} keys — the parser is broken, not clean`)
})

test('#354: every key marked inert in the patch and the site really is, and both surfaces agree', () => {
  const patch = read('cordis.patch.yml')
  const site = read('site/src/content/docs/reference/configuration.md')
  // The patch carries one consolidated "accepts and IGNORES" block naming all four.
  const patchBlock = /Keys the HOST config: block accepts and IGNORES \(#354\)([\s\S]{0,600})/.exec(patch)
  assert.ok(patchBlock !== null, 'the patch must carry the #354 inert-keys block — that is where an operator reads it')
  for (const k of DECLARED_INERT) {
    assert.ok(patchBlock![1]!.includes(k), `cordis.patch.yml does not list ${k} as inert`)
  }
  // And the one key the user-facing table presents as a knob says so on its own row.
  const row = site.split('\n').find((l) => l.includes('`noticeIndexCap`'))
  assert.ok(row !== undefined && /INERT in the host/.test(row),
    'the site table must not describe noticeIndexCap as a working host knob — #354 found it documented as one while nothing read it')
})

test('#354: the engine row declares every key its own constructor destructures', () => {
  const src = read('src/engine.ts')
  const m = /const \{([\s\S]*?)\} = config\b/.exec(src)
  assert.ok(m !== null, 'could not find the constructor destructure — the shape this gate depends on moved')
  const destructured = [...new Set(
    m[1]!.split(',').map((t) => t.trim().replace(/:.*$/, '').trim()).filter((t) => /^[A-Za-z][A-Za-z0-9_]*$/.test(t)),
  )].sort()
  const declared = new Set(declaredRowKeys())
  const missing = destructured.filter((k) => !declared.has(k))
  assert.deepEqual(missing, [],
    `keys the engine reads but its row zod does not declare: ${missing.join(', ')} — they only arrive because schemastery preserves unknown keys (no default, no validation, invisible in the config editor). Declare them. (#354)`)
  assert.ok(destructured.length >= 30, `destructure scan found ${String(destructured.length)} keys — the parser is broken, not clean`)
})

test('#354: the patch prints defaults that match the code', () => {
  const src = read('src/index.ts')
  const patch = read('cordis.patch.yml')


  // The two the audit found stale, read from the host Schema literal rather than hardcoded here.
  for (const [key, expected] of [['promptContextChars', 32000], ['promptMaxChars', 4096]] as const) {
    const decl = new RegExp(`\\n\\s{2}${key}: Schema\\.number\\(\\)\\.default\\((\\d+)\\)`).exec(src)
    assert.ok(decl !== null, `${key} default not found in the host Schema literal`)
    assert.equal(Number(decl[1]), expected, `${key} code default moved off ${String(expected)} — update cordis.patch.yml in the same change`)
    const printed = new RegExp(`#\\s+${key}: (\\d+)`).exec(patch)
    assert.ok(printed !== null, `${key} is not documented in the patch`)
    assert.equal(Number(printed[1]), expected,
      `cordis.patch.yml documents ${key} as ${printed[1]} while the code default is ${String(expected)} — a stale documented default is a lie an operator will act on`)
  }
  // The row keys #354 added must carry the defaults the constructor used to apply by `??`.
  for (const [key, dflt] of [['noticeIndexCap', 6], ['planInlineChars', 900], ['callArgArtifactTokens', 0],
    ['plansInCheckpoint', true], ['planCheckpointChars', 1600]] as const) {
    assert.ok(key in rowDefaults(), `${key} is not declared on the engine row`)
    assert.deepEqual(rowDefaults()[key], dflt, `${key} row default drifted from ${String(dflt)}`)
  }
})

test('#354: childAutoArchive is a realm-row key, and the patch says so rather than implying otherwise', () => {
  const src = read('src/index.ts')
  const schema = hostSchemaKeys()
  assert.equal(schema.includes('childAutoArchive'), false,
    'the host Schema gained childAutoArchive — then the patch note must stop calling it INERT on the host plane')
  const patch = read('cordis.patch.yml')
  const line = patch.split('\n').find((l) => l.includes('#   childAutoArchive:'))
  assert.ok(line !== undefined && /INERT HERE/.test(line),
    'the patch lists childAutoArchive in its host config block; it must be labelled as a realm-row key (#354)')
  assert.ok('childAutoArchive' in rowDefaults(), 'and it really is declared on the engine row')
})
