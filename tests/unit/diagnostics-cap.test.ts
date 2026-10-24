/**
 * The diagnostics sink defaults ON (#61a) and every fix this week made it chattier — a line per enrichment
 * no-op, per abstention, per decline. Nothing capped the file: `diagnostic()` was `appendFileSync` with no
 * size check, so a busy store root grows one path per session forever. Loudness that costs unbounded disk
 * is a bug the operator finds later, in production, on someone else's machine.
 *
 * The cap is CONFIG (AGENTS: no hardcoded tunables) and rotation preserves the previous generation as
 * `<sink>.1`. This is a LOG policy, not an archive policy: nothing under `chapters/` is ever moved or
 * truncated by this path — the append-only invariant stays where it lives.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { sinkAction } from '../../src/diag.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

test('sinkAction rotates at the cap and appends below it', () => {
  assert.equal(sinkAction(0, 8_388_608), 'append', 'a new file appends')
  assert.equal(sinkAction(8_388_607, 8_388_608), 'append', 'one byte under the cap still appends')
  assert.equal(sinkAction(8_388_608, 8_388_608), 'rotate', 'at the cap, rotate — the write itself is never dropped')
  assert.equal(sinkAction(10, 0), 'append', 'cap 0 means uncapped (operator choice, not a silent default)')
  assert.equal(sinkAction(10, Number.NaN), 'append', 'an unmeasured cap never blocks a diagnostic: loudness wins')
})

test('the cap is declared in config and enforced on the append path', () => {
  const diag = fs.readFileSync(path.join(ROOT, 'src', 'diag.ts'), 'utf8')
  assert.match(diag, /fs\.appendFileSync\(sink, line/, 'the append stays (writes are never skipped)')
  assert.match(diag, /sinkAction\(/, 'but it is preceded by the size decision')
  assert.match(diag, /renameSync\(sink, sink \+ '\.1'\)|renameSync\(sink,/, 'rotation preserves the previous generation')
  const cfg = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(cfg, /diagnosticsMaxBytes: Schema\.number\(\)\.step\(1\)\.min\(0\)/,
    'the cap is a declared Config key with a schemastery spec, not a hardcoded number (AGENTS: if cordis can change it, it belongs in config)')
  const eng = fs.readFileSync(path.join(ROOT, 'src', 'engine.ts'), 'utf8')
  assert.match(eng, /configureDiagnosticsCap\(this\.chaptersConfig\.diagnosticsMaxBytes\)/,
    'the realm row\u2019s cap is applied, not just parsed')
  assert.match(eng, /diagnosticsMaxBytes/, 'and the value comes from the realm row, not a literal')
  const core = fs.readFileSync(path.join(ROOT, 'src', 'engine-core.ts'), 'utf8')
  assert.match(core, /diagnosticsMaxBytes/, 'the realm Config declares it too, or the loader strips it')
})
