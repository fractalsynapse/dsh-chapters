/**
 * The rig's store root has ONE source of truth (#56, following #70).
 *
 * #70 pinned `artifactStoreRoot` per port so acceptance stops writing test trees into the
 * project's own production `.dsh-chapters/`. The specs kept reading the workspace path, so a
 * leg whose archive worked perfectly timed out reporting "no chapters" — the same false
 * conclusion the v3/v4 log name produced, one layer over. These rows make the two derivations
 * impossible to drift apart, and forbid the retired dialect from creeping back into a spec.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const E2E_DIR = path.join(ROOT, 'tests', 'e2e')

const readSource = (f: string): string => fs.readFileSync(path.join(E2E_DIR, f), 'utf8')

test('session.ts derives the store root from the SAME formula boot.ts writes the patch with', () => {
  const boot = readSource('boot.ts')
  const session = readSource('session.ts')
  // the WHOLE line, not a paren-limited capture: `path.join(e2eHome(port), 'chapters')` has a
  // nested call, and a `[^)]*` capture silently stops inside it — which is how this row first
  // "failed" for a reason that had nothing to do with drift.
  assert.match(boot, /export const rigStoreRoot = \(port: number\): string => path\.join\(e2eHome\(port\), 'chapters'\)/,
    'boot.ts must keep rigStoreRoot(port) = <port home>/chapters as the single definition')
  assert.match(session, /export const E2E_STORE_ROOT = path\.join\(ROOT, 'var', `e2e-home-\$\{bootPort\(\)\}`, 'chapters'\)/,
    'session.ts must derive the identical path (var/e2e-home-<port>/chapters), not a lookalike')
})

test('no spec reads chapters out of the workspace tree any more', () => {
  const offenders: string[] = []
  for (const f of fs.readdirSync(E2E_DIR).filter((x) => x.endsWith('.spec.ts'))) {
    const src = readSource(f)
    // comments are allowed to name the retired dialect — they are where the WHY lives
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    if (/path\.join\(\s*ROOT\s*,\s*'\.dsh-chapters'/.test(code)) offenders.push(f)
  }
  assert.deepEqual(offenders, [],
    `these specs still read the retired workspace store root while the rig writes a per-port one: ${offenders.join(', ')}`)
})

test('every spec that touches the store imports the shared constant', () => {
  const users = fs.readdirSync(E2E_DIR).filter((x) => x.endsWith('.spec.ts'))
    .filter((f) => /\bstoreRoot\b|\bstatusPath\b|E2E_STORE_ROOT/.test(readSource(f)))
  assert.ok(users.length >= 3, `expected the store-touching journeys to be found, got: ${users.join(', ')}`)
  for (const f of users) {
    const src = readSource(f)
    if (/const (storeRoot|statusPath) = E2E_STORE_ROOT/.test(src)) {
      assert.match(src, /import \{[^}]*E2E_STORE_ROOT[^}]*\} from '\.\/session\.ts'/, `${f} must import the constant, not re-derive it`)
    }
  }
})
