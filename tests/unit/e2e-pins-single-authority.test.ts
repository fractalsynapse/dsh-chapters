/**
 * The rig's regime has ONE table (#56).
 *
 * Measured failure it closes: `npm run test:e2e` (and therefore replay) booted `suite`, `rules` and
 * `fork` with NO threshold while distill had recorded them at 0.75 / 0.9 / 0.75 — three copies of
 * the pins (distill's tables, the chain script's inline env, boot defaults) and a config comment
 * claiming they "mirror exactly". A replay that boots a different realm than the tape was
 * distilled under does not fail as a wrong answer; it fails as MISSes that look like prompt drift
 * (observed: replay requests carrying `[dsh:artifact …]` stubs the recorded tapes contain none of).
 *
 * The second, subtler half: Playwright project `env` reaches WORKERS, and the object handed to
 * `globalSetup` has an unfiltered `projects` list whose entries carry no `env`. So "just put it in
 * the config" was not enough — the boot still used defaults. Both consumers now read
 * `tests/e2e/rig-pins.ts`, and the rows below fail if either drifts back.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { RIG_PINS, rigEnv, projectFromArgv, applyRigEnv } from '../../tests/e2e/rig-pins.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

const EXPECTED: Record<string, Record<string, string>> = {
  suite: { E2E_PORT: '41731', E2E_THRESHOLD: '0.75' },
  heavy: { E2E_PORT: '41733', E2E_THRESHOLD: '0.5', E2E_FLOOR: '1000000' },
  arrival: { E2E_PORT: '41732', E2E_THRESHOLD: '0.9', E2E_FLOOR: '500' },
  enrich: { E2E_PORT: '41734', E2E_THRESHOLD: '0.9', E2E_ENRICH: '1' },
  fanout: { E2E_PORT: '41736', E2E_THRESHOLD: '0.75' },
  rules: { E2E_PORT: '41735', E2E_THRESHOLD: '0.9' },
  fork: { E2E_PORT: '41737', E2E_THRESHOLD: '0.75' },
  plans: { E2E_PORT: '41738', E2E_THRESHOLD: '0.99', E2E_NO_AUX_MODEL: '1' },
  prompt: { E2E_PORT: '41739', E2E_THRESHOLD: '0.99', E2E_NO_AUX_MODEL: '1', E2E_PROMPT: '1' },
}

test('the table carries each project regime, and rigEnv derives it without copying', () => {
  assert.deepEqual(Object.keys(RIG_PINS).sort(), Object.keys(EXPECTED).sort(),
    'the nine tape projects and nothing else (dev projects are not pinned here)')
  for (const [proj, pins] of Object.entries(EXPECTED)) {
    const env = rigEnv(proj)
    assert.equal(env.E2E_TAPE, proj, `${proj}: the tape dir is part of the regime, not a runner flag`)
    for (const [k, v] of Object.entries(pins)) assert.equal(env[k], v, `${proj}: ${k}`)
  }
  assert.deepEqual(rigEnv('explore-dev'), {}, 'an unknown project derives NOTHING rather than inventing defaults')
})

test('the boot selects the project from argv and applies the table (the half the config cannot do)', () => {
  assert.equal(projectFromArgv(['x', '--project=heavy']), 'heavy')
  assert.equal(projectFromArgv(['x', '--project', 'arrival']), 'arrival')
  assert.equal(projectFromArgv(['x']), null, 'no selection is not a guess')
  const saved = { ...process.env }
  try {
    for (const k of ['E2E_TAPE', 'E2E_PORT', 'E2E_THRESHOLD', 'E2E_FLOOR']) delete process.env[k]
    process.env.E2E_THRESHOLD = '0.1'
    const pin = applyRigEnv('heavy')
    assert.equal(pin?.threshold, '0.5', 'the table knows heavy')
    assert.equal(process.env.E2E_THRESHOLD, '0.1',
      'an explicit command-line pin must win — re-tuning one leg cannot require editing the table')
    assert.equal(process.env.E2E_PORT, '41733', 'and everything unset still comes from the table')
    assert.equal(applyRigEnv('nonsense'), null, 'an unknown project leaves the environment alone')
  } finally {
    for (const k of ['E2E_TAPE', 'E2E_PORT', 'E2E_THRESHOLD', 'E2E_FLOOR']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    }
  }
})

test('the config and the setup both read the table — neither holds a literal copy', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'playwright.config.ts'), 'utf8')
  assert.match(cfg, /import \{ rigEnv \} from '.\/rig-pins\.ts'/, 'the config must derive its per-project env')
  for (const proj of Object.keys(EXPECTED)) {
    assert.match(cfg, new RegExp(`env: rigEnv\\('${proj}'\\)`), `${proj}: env must come from the table`)
  }
  assert.doesNotMatch(cfg, /env: \{ 'E2E_TAPE'/, 'a literal env block is a second copy waiting to drift')
  const gs = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'globalSetup.ts'), 'utf8')
  // the claim is that BOTH halves happen, not the spelling — insisting on one line is how a
  // shape row becomes a typo generator
  assert.match(gs, /projectFromArgv\(/, 'the boot must resolve the selected project from argv')
  assert.match(gs, /applyRigEnv\(/, 'and must apply the table before booting')
  // the "explicit wins" guard lives in the table module now — it is ONE rule, not per-callsite,
  // so the row reads it where it is implemented (and the behavioral row above exercises it)
  const pins = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'rig-pins.ts'), 'utf8')
  assert.match(pins, /if \(process\.env\[key\] === undefined\)/, 'explicit env still wins, in the one place that sets it')
})

test('the runners carry no second copy of the pins', () => {
  const d = fs.readFileSync(path.join(ROOT, 'scripts', 'distill-tapes.sh'), 'utf8')
  assert.doesNotMatch(d, /E2E_THRESHOLD=|E2E_PORT="\$\{PORTS/, 'distill must not pass a threshold or port')
  assert.match(d, /env E2E_MODEL=record \$\{leg_extra:-\}/,
    'the stub upstream must still reach plans/prompt — dropping it here would silently record them against the hosted endpoint')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  for (const script of ['test:e2e', 'test:e2e:replay', 'coverage:e2e']) {
    assert.doesNotMatch(pkg.scripts[script] ?? '', /E2E_THRESHOLD=|E2E_FLOOR=|E2E_PORT=|E2E_ENRICH=|E2E_NO_AUX_MODEL=/,
      `${script}: inline pins are the drift this closes`)
  }
})

/**
 * The ratchet (#83): the browser plane can't be gated on a cleanup that has never happened on its
 * own, so it is gated on not getting WORSE. This exists because a `ReferenceError: rotated is not
 * defined` in `tests/e2e/session.ts` — a real bug that cost a nine-leg re-record — was invisible to
 * every gate: `tsconfig.json` excludes the directory, Playwright transpiles without checking.
 */
test('the e2e typecheck ratchet exists, is wired, and only ratchets down', () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'typecheck-baseline.json'), 'utf8')) as { errors: number }
  assert.equal(typeof base.errors, 'number', 'the baseline is a number, not a TODO')
  assert.ok(base.errors >= 0)
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'e2e-typecheck-ratchet.sh'), 'utf8')
  assert.match(script, /if \[ "\$OUT" -le "\$BASE" \]; then/, 'growth fails; equal passes')
  assert.match(script, /a ratchet only counts if someone tightens it/, 'and shrink is prompted, not silently accepted')
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /e2e-typecheck-ratchet\.sh/, 'the ratchet runs in CI, next to the other typechecks')
})

/**
 * A gate may be weakened by decision, never by accident (#92). The row asserts the SHAPE of the
 * decision: exactly one job is advisory, it names the issue that authorized it, and the plane that
 * actually proves the code (typecheck/build/unit/integration, the drift gates) stays blocking. Without
 * this, `continue-on-error: true` would be a silent permanent condition — the same drift that let a
 * skipped journey look like a pass in the first place.
 */
test('the advisory acceptance gate is scoped, sourced, and reversible (#92)', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const advisory = ci.split('\n').filter((l) => /continue-on-error:\s*true/.test(l))
  assert.equal(advisory.length, 1, `exactly one job may be advisory, found ${String(advisory.length)}: ${JSON.stringify(advisiveTrim(advisory))}`)
  assert.match(ci, /issues\/92/, 'the weakening must cite the decision that authorized it')
  const acceptance = /acceptance[^\n]*\n[\s\S]{0,4000}?continue-on-error: true/.test(ci)
  assert.ok(acceptance, 'and the advisory line must belong to the acceptance job, not to another')
  const deterministic = ci.slice(ci.indexOf('typecheck · build · unit + integration'), ci.indexOf('acceptance'))
  assert.doesNotMatch(deterministic, /continue-on-error/, 'the deterministic plane is never advisory')
})

const advisiveTrim = (lines) => lines.map((l) => l.trim().slice(0, 40))
