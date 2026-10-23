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
test('the boot writes the tracked seeds and throws if they are missing (#89)', () => {
  const boot = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'boot.ts'), 'utf8')
  assert.match(boot, /fs\.copyFileSync\(SETTING_SEED/, 'the tracked settings seed is what lands in the home')
  assert.match(boot, /the tracked profile seed is missing/, 'a missing seed throws — no silent fallback to a developer file')
})
test('the profile patch the boot seeds is tracked too, and its rows are the ones that matter (#89)', () => {
  const rel = path.join('tests', 'e2e', 'fixtures', 'dev-profile-cordis.patch.yml')
  assert.equal(execFileSync('git', ['ls-files', rel], { cwd: ROOT, encoding: 'utf8' }).trim(), rel,
    'this file, not a laptop copy, defines what a boot composes')
  const body = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  // The rows whose absence made CI send a 2-message first request against a 6-message tape.
  for (const row of ['agent-default-model', 'agent-presets', 'llm-gate', 'fetch-timeouts']) {
    assert.ok(body.includes(`id: ${row}`), `the seed must carry the "${row}" row — the corpus was recorded under it`)
  }
  const boot = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'boot.ts'), 'utf8')
  assert.match(boot, /fs\.copyFileSync\(PROFILE_SEED/, 'the tracked profile patch is what lands in the home')
  assert.match(boot, /the tracked profile patch seed is missing/, 'and its absence throws rather than falling back')
})
test('the profile base is built by the shared script, never copied from a laptop (#89)', () => {
  const boot = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'boot.ts'), 'utf8')
  // The exclusion filters this branch first asserted are gone: nothing from `.dshdev-local` is copied
  // at all now, so a filter would be vacuous. The closure row below is the structural guard.
  assert.match(boot, /bootstrap-dev-profile\.sh/, 'the profile base is built with the SAME script CI runs')
  assert.match(boot, /'--home', path\.relative\(ROOT, base\)/, 'into a repo-local base directory')
  assert.match(boot, /no fallback/, 'and a failed base build throws — booting a different profile is the bug class')
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'bootstrap-dev-profile.sh')), 'the bootstrap script is part of the rig contract')
})

test('the ignored dev home is copied through a filter that provably drops every composing file (#89)', () => {
  // What enumeration actually produced, stated about the code that exists. `.dshdev-local/` is
  // gitignored, and four layers of #89 were files copied out of it: `settings.yaml` (provider routes,
  // 32K window), its `profiles/web/cordis.patch.yml` (the `agent-presets` / `llm-gate` /
  // `fetch-timeouts` rows), and the whole `profiles/` tree — 18 MB of installed plugins, which
  // decides what the system header composes (7,276 recorded chars vs 2,783 on CI, diverging at
  // char 141). Each is excluded by name and replaced by a tracked seed or a base built with the same
  // script CI runs. The one remaining carry is `storages/workspace.json`, whose SHAPE the host owns
  // (a hand-written substitute made the app never set `dsh.sessions.current`) and whose sessionIds
  // are scrubbed below it. This row is the teeth: delete any filter line and it reddens.
  const boot = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'boot.ts'), 'utf8')
  assert.match(boot, /if \(rel === 'settings\.yaml'\) return false/, 'settings.yaml is excluded')
  assert.match(boot, /rel === path\.join\('profiles', 'web', 'cordis\.patch\.yml'\)\) return false/, 'the profile patch is excluded')
  assert.match(boot, /rel\.startsWith\('profiles'\)\) return false/, 'and the installed profile tree is excluded')
  assert.match(boot, /fs\.copyFileSync\(SETTING_SEED/, 'settings comes from the tracked fixture')
  assert.match(boot, /fs\.copyFileSync\(PROFILE_SEED/, 'the profile patch comes from the tracked fixture')
  assert.match(boot, /bootstrap-dev-profile\.sh[\s\S]{0,400}'--home'/, 'the profile tree is BUILT by the shared script, into a repo-local base')
  assert.match(boot, /e2e-profile-base/, 'that base is named, not improvised')
  assert.match(boot, /dsh-host-lock/, 'and the host binary resolves from the pinned hermetic install')
})
