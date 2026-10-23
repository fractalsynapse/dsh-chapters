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
