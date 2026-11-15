/**
 * #339 — the preset-row health witness must be able to FAIL.
 *
 * `unusableRows()` compared `fiberState` to the STRING `'active'` while the host sends a NUMBER
 * (`FiberState`, a numeric const enum). Every shape — including `FAILED` — returned `[]`, so
 * `describeMountedRows` always read "N mounted rows all active" and the `presetUnusableRows`
 * witness stayed empty. The failure was invisible in CI for the same reason it was invisible in
 * the field: the fixtures in `preset-declaration.test.ts` hand-wrote `fiberState: 'failed'`, a
 * shape the host does not emit.
 *
 * So this row does NOT hand-write the enum. It READS the installed cordis declaration and derives
 * the values from it — the AGENTS.md rule ("use fixtures of the real shape", "prefer primary
 * sources and measured payloads from the actual pinned version") made mechanical. If cordis
 * renumbers a state, this file notices; if it renames one, the parse fails loudly rather than
 * quietly testing nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fiberStateName, unusableRows, type InventoryRow } from '../../src/preset.ts'

/** The installed cordis `FiberState` enum, parsed out of the shipped .d.ts. */
function installedFiberStates(): Record<string, number> {
  const require_ = createRequire(import.meta.url)
  let file: string
  try {
    // Resolve the PACKAGE, then reach the declaration: cordis' `exports` map does not list
    // ./lib/types/*.d.ts, so resolving the subpath directly throws ERR_PACKAGE_PATH_NOT_EXPORTED
    // and this row would report SKIP while proving nothing.
    const pkg = require_.resolve('@deepseek-ai/cordis/package.json')
    file = join(dirname(pkg), 'lib', 'types', 'fiber.d.ts')
    if (!existsSync(file)) return {}
  } catch {
    return {}
  }
  const src = readFileSync(file, 'utf8')
  const block = /const enum FiberState\s*\{([^}]*)\}/.exec(src) ?? /enum FiberState\s*\{([^}]*)\}/.exec(src)
  assert.ok(block !== null, `the installed cordis no longer declares FiberState in ${file} — re-derive the real shape, do not delete this row`)
  const out: Record<string, number> = {}
  for (const m of block[1]!.matchAll(/([A-Z_]+)\s*=\s*(\d+)/g)) out[m[1]!] = Number(m[2])
  assert.ok(Object.keys(out).length >= 3, `suspiciously few FiberState members parsed from ${file}`)
  return out
}

const STATES = installedFiberStates()
const skip = Object.keys(STATES).length === 0 ? '@deepseek-ai/cordis declaration not resolvable' : false
const row = (entryId: string, fiberState: number | string | undefined, enabled = true): InventoryRow =>
  ({ entryId, moduleName: `@x/${entryId}`, enabled, fiberState })
const entry = (...rows: InventoryRow[]) => ({ id: 'chapters', rows })

test(`${skip ? 'SKIP' : 'RUN'} — a FAILED row, sent as the host sends it, is reported`, { skip }, () => {
  assert.ok(STATES.FAILED !== undefined && STATES.ACTIVE !== undefined, `FiberState members found: ${Object.keys(STATES).join(',')}`)
  const found = unusableRows(entry(row('chapters-tools', STATES.ACTIVE), row('chapters-engine', STATES.FAILED)))
  assert.equal(found.length, 1, `exactly the failed row must be reported, got: ${JSON.stringify(found)}`)
  assert.match(found[0]!, /chapters-engine/)
  assert.match(found[0]!, /failed/, 'and the report names the state in words an operator can read')
})

test(`${skip ? 'SKIP' : 'RUN'} — every non-active state in the installed enum is a finding`, { skip }, () => {
  // The generic form of the row above: it cannot pass because one value happens to work.
  for (const [name, value] of Object.entries(STATES)) {
    const found = unusableRows(entry(row('r1', value)))
    if (name === 'ACTIVE') assert.deepEqual(found, [], 'ACTIVE is the only usable state')
    else assert.equal(found.length, 1, `${name} (${String(value)}) must be reported as unusable — this is the #339 class of bug`)
  }
})

test(`${skip ? 'SKIP' : 'RUN'} — a row that never activated (PENDING) is still reported, not mistaken for healthy`, { skip }, () => {
  assert.ok(STATES.PENDING !== undefined)
  const found = unusableRows(entry(row('chapters-tools', STATES.PENDING)))
  assert.equal(found.length, 1, 'a pending row cannot serve a session yet; the witness says so (and callers keep it apart from `broken`)')
  assert.match(found[0]!, /pending/)
})

test('a disabled row is not a finding, whatever its state', () => {
  const value = STATES.DISPOSED ?? 4
  assert.deepEqual(unusableRows(entry(row('off', value, false))), [], 'disabled is an operator choice, not a failure')
})

test('an unrecognised numeric state is REPORTED as unknown, never read as active', () => {
  const found = unusableRows(entry(row('future-row', 99)))
  assert.equal(found.length, 1, 'a state this file has never seen is exactly what must surface')
  assert.match(found[0]!, /unknown-state-99/)
})

test('a host that sends state NAMES still works (the string arm is kept on purpose)', () => {
  assert.deepEqual(unusableRows(entry(row('ok', 'active'))), [], 'named active is fine')
  const found = unusableRows(entry(row('bad', 'failed')))
  assert.equal(found.length, 1, 'named failed is still reported')
  assert.equal(fiberStateName('active'), 'active')
})

test('no fiberState at all is not a finding — nothing was claimed about the row', () => {
  assert.deepEqual(unusableRows(entry(row('mystery', undefined))), [])
  assert.deepEqual(unusableRows(undefined), [], 'a missing entry is not a row failure')
})
