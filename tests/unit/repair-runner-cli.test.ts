/**
 * The repair runner is an operator tool that must be runnable at any time (#56/#60 follow-up, asked for
 * on 2026-10-24 right after installing 0.2.0). These rows pin the CLI's contract — the safety defaults
 * and the fixed-point loop — because a runner whose "safe to re-run" property lives in a comment is a
 * property that quietly stops being true.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'chapters-repair.mjs'), 'utf8')

test('the repair CLI is dry-run by default, needs --yes to write, and can reach a fixed point in one command', () => {
  assert.match(cli, /const DRY = flag\('dry-run'\) \|\| APPLY === undefined/, 'no --apply means nothing is written')
  assert.match(cli, /--apply needs --yes/, 'a write requires the explicit second flag')
  assert.match(cli, /registry backed up to/, 'the registry is copied beside itself before any mutation')
  assert.match(cli, /--until-clean/, 'one command repeats passes to the fixed point (measured: 3 passes on SAIP)')
  assert.match(cli, /while \(applied > 0 && pass < 6\)/, 'it stops when a pass applies 0, and is bounded anyway')
  assert.match(cli, /refused: \$\{totals\.refused/, 'and it counts what it will NOT touch, instead of looking clean')
  assert.doesNotMatch(cli, /rmSync|unlinkSync/, 'the runner never deletes — quarantine is a copy (invariant: append-only)')
})
