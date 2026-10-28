/**
 * The repo must compile against the host it actually boots (#128).
 *
 * Why this row exists: the e2e rig spawns `dsh web` from `dev/dsh-host-lock` (a hermetic install pinned to ONE exact
 * host version, chosen by witness — the lock's own description says caret ranges float and a floating host changes the
 * system-prompt bytes every tape depends on). Meanwhile the packages this repo TYPE-CHECKS against drifted: sixteen
 * `@deepseek-ai/*` devDependencies sat at `^0.1.5-rc.2` while the runtime was `0.2.0-rc.2`. Two minors of API skew
 * means the compiler was vouching for a host we do not run — the same class as measuring a build that was not the one
 * under test (#54), and the reason retired shapes (a bare `source.kind: 'plugin'`, refused by session format v4 since
 * #43) could survive in source while every gate stayed green.
 *
 * The row asserts the cheap invariant: every `@deepseek-ai/dsh-*` devDependency is pinned EXACTLY to the host version
 * the lock declares, with no caret. `@deepseek-ai/cordis*` and `schemastery` are separate series and excluded
 * explicitly — an exclusion named in code, never one inferred from a pass.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SEPARATE_SERIES = new Set(['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader'])

test('every host devDependency is pinned exactly to the version the e2e lock boots', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'dsh-host-lock', 'package.json'), 'utf8')) as
    { dependencies?: Record<string, string> }
  const pin = lock.dependencies?.['@deepseek-ai/dsh']
  assert.ok(typeof pin === 'string' && pin.length > 0, 'the lock must declare the host pin')
  assert.ok(!/[\^~]/.test(pin), `the host pin must be exact, got ${String(pin)}`)

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as
    { devDependencies?: Record<string, string> }
  const deps = pkg.devDependencies ?? {}
  const hostDeps = Object.keys(deps).filter((k) => k.startsWith('@deepseek-ai/dsh-') && !SEPARATE_SERIES.has(k))
  assert.ok(hostDeps.length >= 10, `expected the host series in devDependencies, found ${String(hostDeps.length)}`)

  const wrong = hostDeps.filter((k) => deps[k] !== pin).map((k) => `${k}: ${String(deps[k])} (want ${pin})`)
  assert.deepEqual(wrong, [], `compiling against a different host than the rig boots:\n  ${wrong.join('\n  ')}`)

  const floated = hostDeps.filter((k) => /[\^~]/.test(String(deps[k])))
  assert.deepEqual(floated, [], `caret/tilde ranges float the host under the corpus: ${floated.join(', ')}`)
})

test('the installed host types match the pin, not merely the manifest', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'dsh-host-lock', 'package.json'), 'utf8')) as
    { dependencies?: Record<string, string> }
  const pin = lock.dependencies?.['@deepseek-ai/dsh']
  const probe = '@deepseek-ai/dsh-compaction'
  let installed: string | undefined
  try {
    installed = (JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', probe, 'package.json'), 'utf8')) as
      { version?: string }).version
  } catch { /* absent is a failure, asserted below */ }
  assert.equal(installed, pin, `installed ${probe} is ${String(installed)}, pin is ${String(pin)}`)
})
