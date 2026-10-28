/**
 * `scripts/e2e-one.sh` resolves its own arguments, in a row, without booting anything.
 *
 * Why this exists: the maintainer ran `npm run corpus:heal -- --project=suite`, got
 * `line 11: LEG: set LEG=…`, and burned another round on me. The cause was two-layered — their local
 * `staging` had no upstream and sat one merge behind, so the pre-fix script ran — but the reason I could not
 * SEE that from here is that answering "does the flag parse?" used to require a full harness boot. A check
 * that costs a boot is a check that does not get run, so `DRY=1` resolves and prints, and these rows pin it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const SCRIPT = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'e2e-one.sh')
const run = (env: Record<string, string>): { out: string; code: number } => {
  try {
    return { out: execFileSync('bash', [SCRIPT], { env: { ...process.env, DRY: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string }
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? -1 }
  }
}

test('no leg named is a usage line and exit 2, never a bash expansion error', () => {
  const r = run({ MODE: 'heal', E2E_PROVIDER: 'harness' })
  assert.equal(r.code, 2, 'refusing to guess is an exit, not a warning')
  assert.match(r.out, /usage: LEG=<suite\|heavy/, `a human-readable usage line: ${r.out.slice(0, 130)}`)
  assert.match(r.out, /corpus:heal -- --project=suite/, 'and the form the maintainer already reaches for is shown back to them')
  assert.ok(!r.out.includes('line 30: LEG'), 'the parameter-expansion error that read like a broken script is gone')
})

test('no mode named is also a usage line — the mode decides whether a tape gets written', () => {
  const r = run({ LEG: 'suite' })
  assert.equal(r.code, 2)
  assert.match(r.out, /usage: LEG=… MODE=<live\|replay\|record\|heal>/)
})

test('DRY=1 resolves a real invocation without booting (suite, heal, harness route)', () => {
  const r = execFileSync('bash', ['-c', `MODE=heal E2E_PROVIDER=harness DRY=1 bash ${SCRIPT} --project=suite`], { encoding: 'utf8' })
  assert.match(r, /\[e2e-one\] leg=suite mode=heal provider=harness/, `the leg came from --project: ${r.split('\n')[0]}`)
  assert.match(r, /window=pinned-32K/, 'heal keeps the tape regime — window 0 here would corrupt the corpus (#78)')
  assert.match(r, /--project=suite/, 'and the resolved playwright invocation names it once')
  assert.match(r, /no boot, no browser, no model call, no tape written/)
})

test('live is the only mode allowed to drop the pinned window', () => {
  const live = execFileSync('bash', ['-c', `MODE=live DRY=1 bash ${SCRIPT} --project=fork`], { encoding: 'utf8' })
  assert.match(live, /window=0/, 'live runs against the endpoint it is pointed at')
  const replay = execFileSync('bash', ['-c', `MODE=replay E2E_PROVIDER=harness DRY=1 bash ${SCRIPT} --project=fork`], { encoding: 'utf8' })
  assert.match(replay, /window=pinned-32K/, 'replay/heal must match the recorded regime, always')
})

test('a conflicting LEG and --project is refused rather than guessed', () => {
  try {
    execFileSync('bash', ['-c', `MODE=heal LEG=fork DRY=1 bash ${SCRIPT} --project=suite`], { encoding: 'utf8', stdio: 'pipe' })
    assert.fail('expected exit 2')
  } catch (e) {
    const err = e as { status?: number; stderr?: string }
    assert.equal(err.status, 2)
    assert.match(`${err.stderr}`, /conflicts with --project=suite/, 'naming the leg twice, differently, is never resolved silently')
  }
})

/**
 * The dry-run line and the exec share one argv array, so the diagnostic cannot disagree with the action.
 *
 * Why this is a row and not a comment: my first cut assembled the two separately, so `LEG=fork` printed a
 * correct-looking leg and then exec'd **without any `--project` filter** — running all 13 specs across every
 * project. The maintainer watched 25 minutes go by on work he had not asked for while my own output looked
 * right. A check that can lie is worse than no check, so both spellings and the no-duplication rule are
 * pinned here.
 */
test('both spellings produce one --project, and extra args survive', () => {
  // Plain string assertions, not regex: my first cut of this row died on `/x/` followed by a template
  // literal, which parses as a tagged template — "is not a function". Checking a shell line for substrings
  // needs no pattern language.
  const inv = (out: string): string => out.split('\n').find((l) => l.includes('would exec')) ?? ''
  const count = (hay: string, needle: string): number => hay.split(needle).length - 1

  const viaLeg = inv(execFileSync('bash', ['-c', `MODE=live LEG=fork DRY=1 bash ${SCRIPT}`], { encoding: 'utf8' }))
  assert.ok(viaLeg.includes('--project=fork'), `LEG= must reach the invocation: ${viaLeg}`)
  assert.equal(count(viaLeg, '--project='), 1, 'exactly one project flag')

  const viaFlag = inv(execFileSync('bash', ['-c', `MODE=heal DRY=1 bash ${SCRIPT} --project=suite`], { encoding: 'utf8' }))
  assert.equal(count(viaFlag, '--project=suite'), 1, `the translated flag is not passed twice: ${viaFlag}`)

  const extra = inv(execFileSync('bash', ['-c', `MODE=replay LEG=rules DRY=1 bash ${SCRIPT} --grep=door`], { encoding: 'utf8' }))
  assert.ok(extra.includes('--project=rules'), 'the leg is still filtered')
  assert.ok(extra.includes('--grep=door'), 'and the caller extra argument is forwarded')
})
