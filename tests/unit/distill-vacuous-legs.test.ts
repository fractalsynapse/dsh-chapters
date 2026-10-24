/**
 * A leg whose journey never ran is not a pass (#89-class, measured tonight).
 *
 * `--- suite: exit=0 tapeEntries=0` looked green in the summary and in my own reasoning for a full
 * round. It happened because `a-knowledge-loop` guards itself with `test.skip(...)` (model
 * reachability, git http-backend availability) and Playwright reports a skipped suite as success — the
 * exact hazard the spec file's own comment names: "a `1 skipped` reads like a pass to anyone scanning
 * a log". The runner is where that gets caught: a model-driven project that records ZERO tape entries
 * cannot have talked to a model, so its verdict is refused regardless of exit code.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const script = fs.readFileSync(path.join(ROOT, 'scripts', 'distill-tapes.sh'), 'utf8')

test('distill refuses a model-driven leg that recorded no tape entries', () => {
  assert.match(script, /VACUOUS|vacuous/,
    'the runner must name the failure mode — a silent `failed+=` would be re-summarized as a green line by someone else')
  assert.match(script, /"\$n" -eq 0/, 'it keys on the entry count it already measures')
  // No exemption for the stub-driven projects either: a stub leg that records zero entries also
  // never ran (its separate `refusing to record` guard covers the WRONG upstream, not silence), so
  // `n -eq 0` applies to every project. Assert the guard is unconditional, and that the stub check
  // still exists independently.
  assert.match(script, /if \[\[ "\$rc" -eq 0 && "\$n" -eq 0 \]\]; then/,
    'the refusal must be unconditional across projects — an exemption list is where a fake green re-hides')
  assert.match(script, /refusing to record/, 'the stub-upstream guard stays as its own separate check')
  // the ordering matters: the refusal has to be able to override a 0 exit code
  const at = script.search(/VACUOUS|vacuous/)
  const verdict = script.indexOf('echo "--- $proj: exit=$rc tapeEntries=$n"')
  assert.ok(at > 0 && verdict > 0 && at < verdict, 'the check runs BEFORE the verdict line is printed')
})
