/**
 * The boot's profile settings are TRACKED, or a tape is a recording of one laptop (#89).
 *
 * `.dshdev-local/` is gitignored. Until now the e2e boot copied `settings.yaml` straight out of it,
 * so provider routes, model windows and reasoning effort came from whatever this machine had — and
 * the corpus inherited that. CI, whose profile is built by the bootstrap script, sent a 2-message
 * first request against a tape recorded with 6: the journey hung on the fork door for 25 minutes and
 * every diagnosis so far (matcher, mask, host binary) was downstream of this.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

test('the seed exists in git, not only on disk', () => {
  const rel = path.join('tests', 'e2e', 'fixtures', 'dev-settings.yaml')
  const tracked = execFileSync('git', ['ls-files', rel], { cwd: ROOT, encoding: 'utf8' }).trim()
  assert.equal(tracked, rel, 'a boot seed that is not committed is a machine-local file with a nice name')
  const body = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  assert.match(body, /contextWindow: \d+/, 'it carries the provider/model facts a boot needs')
})

test('the boot refuses to fall back to the untracked settings', () => {
  const boot = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'boot.ts'), 'utf8')
  assert.match(boot, /if \(rel === 'settings\.yaml'\) return false/,
    'the untracked copy is excluded from the home seed')
  assert.match(boot, /fs\.copyFileSync\(SETTING_SEED/, 'and the tracked seed is what lands in the home')
  assert.match(boot, /missing[\s\S]{0,200}\.dshdev-local\/settings\.yaml|the tracked profile seed is missing/,
    'a boot with no seed must THROW, not quietly use the developer’s file')
})

test('the profile patch the boot seeds is tracked too, and its rows are the ones that matter (#89)', () => {
  const rel = path.join('tests', 'e2e', 'fixtures', 'dev-profile-cordis.patch.yml')
  assert.equal(execFileSync('git', ['ls-files', rel], { cwd: ROOT, encoding: 'utf8' }).trim(), rel,
    'this file, not a laptop copy, defines what a boot composes')
  const body = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  // The specific rows whose absence made CI send a 2-message first request against a 6-message tape.
  for (const row of ['agent-default-model', 'agent-presets', 'llm-gate', 'fetch-timeouts']) {
    assert.ok(body.includes(`id: ${row}`), `the seed must carry the "${row}" row — this is the composition the corpus was recorded under`)
  }
  const boot = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'boot.ts'), 'utf8')
  assert.match(boot, /profiles', 'web', 'cordis\.patch\.yml'\)\) return false/, 'the untracked copy is excluded')
  assert.match(boot, /fs\.copyFileSync\(PROFILE_SEED/, 'and the tracked seed is what lands in the home')
})

/**
 * Layer four (#89), found by ENUMERATING what a boot reads instead of waiting for the next tape diff:
 * the copy also brought `.dshdev-local/profiles/**` — 18 MB of `node_modules` installed by whoever last
 * used the dev profile. Which plugins a profile mounts changes which instruction paragraphs the host
 * composes, so the system header itself differed: 7,276 chars recorded vs 2,783 on CI, diverging at
 * char 141 mid-sentence.
 */
test('no profile tree is copied from the developer home; it is built by the shared script (#89)', () => {
  const boot = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'boot.ts'), 'utf8')
  assert.match(boot, /if \(rel\.startsWith\('profiles'\)\) return false/,
    'the untracked profile tree must be excluded from the home copy')
  assert.match(boot, /bootstrap-dev-profile\.sh[\s\S]{0,200}--home/,
    'the profile base is built with the SAME script CI runs')
  assert.match(boot, /no fallback/, 'and a failure to build it must throw — silently booting a different profile is the whole bug class')
  // and the script must exist and be executable-by-path (it is the contract, not a convenience)
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'bootstrap-dev-profile.sh')), 'the bootstrap script is part of the rig contract')
})
