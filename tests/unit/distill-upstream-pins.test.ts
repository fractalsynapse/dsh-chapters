/**
 * The distill runner must not be able to record a stub-pinned journey from a live model (#56).
 *
 * `plans` and `prompt` carry `PROVENANCE.md` statements that their tapes come from the SCRIPTED
 * upstream (`tests/e2e/stub-model.ts`) — for plans because a tape must not freeze one model's
 * decision to plan, for prompt because the assertion compares a constant only the stub's
 * `suggest` arm mints. Tonight nothing pinned or started that upstream: the endpoint resolver fell
 * through to the hosted model, `prompt` failed an unsatisfiable line, and `plans` recorded a real
 * model's improvisation while its provenance file went on claiming otherwise. Prose in a header
 * comment is not a guard. This is.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const script = fs.readFileSync(path.join(ROOT, 'scripts', 'distill-tapes.sh'), 'utf8')

test('plans and prompt are declared stub-pinned, and the stub is started for them', () => {
  assert.match(script, /STUB_PROJECTS="plans prompt"/, 'the two journeys are named, not implied')
  assert.match(script, /start_stub/, 'and something starts the scripted upstream')
  assert.match(script, /E2E_UPSTREAM=http:\/\/127\.0\.0\.1:\$\{STUB_PORT\}/,
    'the leg env pins the stub — the endpoint resolver must not get to decide this')
  assert.match(script, /stop_stub\b/, 'and stops it, so a leaked :8081 cannot mis-pin the next leg')
})

test('a stub that will not answer is a FAILED leg, never a silent hosted recording', () => {
  assert.match(script, /failed\+=\("\$\{proj\}:stub-down"\)/,
    'the refusal must land in the same verdict list the summary reads')
  assert.match(script, /refusing to record/, 'with words that say which journey and why')
})

test('the stub upstream is not pinned for the model-driven journeys', () => {
  // suite/heavy/arrival/enrich/fanout/rules/fork legitimately record from a real model; if a
  // blanket pin ever lands on them, their tapes stop representing model behavior at all.
  const extra = /declare -A EXTRA=\(([^\n]*)\)/.exec(script)?.[1] ?? ''
  assert.doesNotMatch(extra, /E2E_UPSTREAM=http:\/\/127\.0\.0\.1:8081/,
    `only STUB_PROJECTS may point at the stub; EXTRA carries: ${extra.slice(0, 160)}`)
})

test('every leg pins its upstream resolution in the log line it prints', () => {
  // a runner that hides which endpoint produced a tape makes provenance un-auditable afterwards
  assert.match(script, /echo "=== distill \$\{proj\} — port[^\n]*\$\{leg_extra\}/,
    'the per-leg header must echo the effective extra env, including the upstream')
})

/**
 * The replay proxy CAN say which entry served each request (`model-proxy.ts` appends `HIT …
 * served=<file>` when `E2E_TAPE_HITS` is set) — but no runner ever set it, so the #90 stall was
 * unanswerable from disk: the instrument existed and was switched off, which is #61a in the rig.
 */
test('the replay runner turns on the hit journal (#90)', () => {
  // The choke point is globalSetup, not a shell script — `npm run test:e2e:replay`, the CI job and my
  // own runner all go through it, and there is no `scripts/chain-replay.sh` (I asserted a file that
  // does not exist, which is how a row becomes folklore).
  const setup = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'globalSetup.ts'), 'utf8')
  assert.match(setup, /E2E_TAPE_HITS/, 'every replay must enable the journal the proxy already supports')
  assert.match(setup, /tape-hits[^'"\n]*\$\{?|tape-hits-/, 'one file per invocation, so projects cannot overwrite each other')
  const proxy = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'model-proxy.ts'), 'utf8')
  assert.match(proxy, /process\.env\.E2E_TAPE_HITS/, 'the proxy side of the pair stays wired')
})
