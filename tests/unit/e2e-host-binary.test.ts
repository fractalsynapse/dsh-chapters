/**
 * The rig boots the PINNED host, and says so (#89).
 *
 * The failure this closes is the quietest kind: `spawn('dsh')` took whatever was on PATH. On the
 * machine that distilled the corpus that was a LINKED DEV BUILD of the harness — `version:
 * "0.2.0-rc.2"`, `repository: git+https://github.com/deepseek-ai/deepseek-harness.git`, no
 * `gitHead` — while CI installs the published tarball from `dev/dsh-host-lock`. Same version string,
 * different host, and the corpus could not replay there. Every mismatch was then argued about as a
 * matcher or product problem, including two real ones (#85, #88) that the confound made harder to see.
 *
 * A version string is not identity. The boot resolves the pinned binary first, falls back loudly,
 * and writes both into `var/e2e-boot-<port>.json`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolveHostBinary } from '../../tests/e2e/boot.ts'

const ROOT = '/tmp/fake-repo'

test('the pinned hermetic install wins over PATH (#89)', () => {
  const pinned = path.join(ROOT, 'dev', 'dsh-host-lock', 'node_modules', '.bin', 'dsh')
  const seen = new Set<string>([pinned])
  const got = resolveHostBinary(ROOT, (p) => seen.has(p))
  assert.equal(got.binary, pinned, 'a boot must use the host the repo pins, not the host a laptop happens to have')
  assert.equal(got.pinned, true)
})

test('a PATH fallback is reported, never presented as the pin (#89)', () => {
  const got = resolveHostBinary(ROOT, () => false)
  assert.equal(got.binary, 'dsh', 'the fallback stays functional…')
  assert.equal(got.pinned, false, '…and announces itself, so a tape distilled this way is suspect by construction')
})

test('the boot records which binary it used (#89)', () => {
  const boot = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'tests', 'e2e', 'boot.ts'), 'utf8')
  assert.match(boot, /hostBinary: host\.binary, hostPinned: host\.pinned/,
    'the per-boot record carries the identity a later reader needs')
  assert.match(boot, /e2e-boot-\$\{String\(port\)\}\.json/,
    'per-port copy, so provenance cannot be whichever boot wrote last')
  // and the SHARED file stays, because it is the handoff protocol to openApp()/discovery —
  // renaming it is how every leg in one run connected to another project's port (measured the
  // same day: ERR_CONNECTION_REFUSED on 41731 from a fanout boot). Two consumers, one file.
  assert.match(boot, /writeFileSync\(path\.join\(ROOT, 'var', 'e2e-boot\.json'\), bootRecord\)/,
    'the URL handoff protocol must keep existing — the specs read it by that name')
  const session = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'tests', 'e2e', 'session.ts'), 'utf8')
  assert.match(session, /'e2e-boot\.json'/, 'the consumer named above is real, so the protocol is load-bearing')
})

/**
 * The throwaway home is HERMETIC, by position (#89, proven before written).
 *
 * Node resolves `@deepseek-ai/*` bundles by walking UP from the profile directory. A home under
 * `var/` therefore reaches the repo's `node_modules` (0.1.5-rc.2) and then this user's
 * `~/node_modules` (a linked DEV BUILD whose version string equals the pin). Measured with nothing
 * changed but the home's location: the same pinned binary composed a 7,276-character system header
 * under `var/` and a CI-shaped shorter one under `/tmp` — and the suite replay flipped from
 * 4-passed to a `commonPrefix=1` MISS at msg1. That is the whole "green on my laptop, impossible on
 * CI" class in one experiment, and the reason homes now live outside the repository by default.
 */
test('the e2e home root is outside the repo, so no ancestor node_modules can leak in (#89)', async () => {
  const { e2eHome, e2eHomeRoot } = await import('../../tests/e2e/boot.ts')
  const root = e2eHomeRoot()
  assert.equal(root.startsWith(ROOT + path.sep), false,
    `the home root must not sit inside the repository tree (got ${root}) — that is how a developer's install joins a boot`)
  const home = e2eHome(41731)
  let dir = home
  const leaks: string[] = []
  for (;;) {
    const nm = path.join(dir, 'node_modules')
    if (fs.existsSync(nm) && fs.existsSync(path.join(nm, '@deepseek-ai'))) leaks.push(nm)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // /tmp itself is clean on this machine; if an ancestor ever grows a @deepseek-ai tree, the
  // hermeticity claim is false and the test says so with the path rather than silently agreeing.
  assert.deepEqual(leaks, [], `an ancestor of ${home} carries @deepseek-ai packages: ${leaks.join(' , ')}`)
})
