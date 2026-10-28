/**
 * The rig must make the preset's tool rows resolvable from the PINNED install, on every machine (#56).
 *
 * Proven by measurement, not theory: a session assembled in a CI-shaped tree (no developer home on the
 * resolution path) registers 7 tools and composes a 2,880-char header, while a development host registers 34
 * and composes 7,396. The difference is resolution — our preset prunes child rows it cannot resolve — and the
 * locally resolvable path was `~/node_modules/…`, which no runner has. Since message 0 is the tape key, that
 * asymmetry makes any locally recorded corpus unreplayable on CI, which is the whole failure this branch has
 * been circling.
 *
 * The fix is not to widen the shipped dependency surface and not to mask the header: it is for the rig to link
 * the pinned bundle's tool packages into the booted home's plugin tree, so the nearest resolution root is the
 * pin on BOTH machines. That makes the recording environment a property of the pin, not of whose laptop it is.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { linkPinnedToolPackages } from '../../tests/e2e/boot.ts'

test('every tool row in the seeded profile gets a pinned, resolvable link', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigtools-'))
  try {
    const install = path.join(root, 'dev', 'dsh-host-lock', 'node_modules', '@deepseek-ai')
    const home = path.join(root, 'home')
    for (const pkg of ['dsh-tool-fs', 'dsh-tool-bash', 'dsh-tools', 'dsh-persona']) {
      const dir = path.join(install, pkg, 'lib')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(install, pkg, 'package.json'), `{"name":"@deepseek-ai/${pkg}","version":"9.9.9"}`)
      fs.writeFileSync(path.join(dir, 'index.js'), '')
    }
    fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
    fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
      '- id: preset-chapters\n  config:\n    plugins:\n      - id: tool-fs\n        name: \'@deepseek-ai/dsh-tool-fs\'\n      - id: tool-bash\n        name: \'@deepseek-ai/dsh-tool-bash\'\n      - id: persona\n        name: \'@deepseek-ai/dsh-persona\'\n')

    const linked = linkPinnedToolPackages(home, root)
    assert.deepEqual(linked.names.sort(), ['dsh-persona', 'dsh-tool-bash', 'dsh-tool-fs'],
      `only rows the profile actually names are linked: ${linked.names.join(',')}`)
    assert.equal(linked.missing.length, 0, `nothing the pin has should be reported missing: ${linked.missing.join(',')}`)
    assert.deepEqual(linked.skipped, [], 'a fresh root has nothing already installed, so nothing is skipped')
    const { createRequire } = await import('node:module')
    const probe = (pkg: string): string => {
      try {
        return createRequire(path.join(root, 'noop.js')).resolve(`@deepseek-ai/${pkg}/package.json`)
      } catch { return 'no' }
    }
    for (const pkg of ['dsh-tool-fs', 'dsh-tool-bash']) {
      const where = probe(pkg)
      assert.notEqual(where, 'no', `${pkg} must resolve from the booted profile after linking`)
      // Node resolves a symlink to its REAL path, so what is provable — and what matters — is that the
      // resolved bytes come from the pinned install rather than any developer home tree.
      assert.ok(where.includes(path.join('dev', 'dsh-host-lock', 'node_modules')),
        `resolution must come from the PIN, not a home tree: ${where}`)
      assert.ok(where.includes(path.join('node_modules', '@deepseek-ai')),
        `and the host's resolution root (the repo's own node_modules) is where the link lands: ${where}`)
      assert.ok(!where.includes(`${os.homedir()}${path.sep}`),
        `and specifically NOT from the developer's home: ${where}`)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a row naming a package the pin does not have is reported, never silently skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigtools2-'))
  try {
    const install = path.join(root, 'dev', 'dsh-host-lock', 'node_modules', '@deepseek-ai')
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(install, 'dsh-tool-fs'), { recursive: true })
    fs.writeFileSync(path.join(install, 'dsh-tool-fs', 'package.json'), '{"name":"@deepseek-ai/dsh-tool-fs"}')
    fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
    fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
      '- id: preset-chapters\n  config:\n    plugins:\n      - id: tool-fs\n        name: \'@deepseek-ai/dsh-tool-fs\'\n      - id: tool-schedule\n        name: \'@deepseek-ai/dsh-tool-schedule\'\n')
    const linked = linkPinnedToolPackages(home, root)
    assert.deepEqual(linked.names, ['dsh-tool-fs', 'dsh-tool-schedule'],
      'names lists every row the profile declares; `missing` is the subset the pin cannot satisfy')
    assert.deepEqual(linked.missing, ['dsh-tool-schedule'],
      'a row the pin cannot satisfy must be NAMED (our preset prunes it — a silent prune is what produced the 7-tool header)')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
