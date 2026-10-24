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
  // STRENGTHENED, not relaxed (#89): this row used to assert the two files contained the SAME
  // expression — which is exactly the arrangement that broke the day `boot.ts` moved homes under
  // `E2E_HOME_ROOT`. Two derivations of one fact need a watchdog; one derivation needs none. The
  // specs now import boot's function, so the row asserts the import and forbids any re-derivation.
  assert.match(session, /import \{ e2eHome, rigMirrorRoot, rigStoreRoot \} from '\.\/boot\.ts'/,
    'session.ts must import boot\u2019s derivation rather than reproduce it')
  assert.match(session, /export const E2E_STORE_ROOT = rigStoreRoot\(bootPort\(\)\)/,
    'the store root is one function call, so it cannot drift from the patch that writes it')
  const sessionCode = session.split('\n').filter((l) => !/^\s*(\/\/|\*|#)/.test(l))
  assert.deepEqual(sessionCode.filter((l) => /e2e-home-/.test(l)), [],
    'a re-derived boot path in the spec layer is the #89 stall, one step from happening again')
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

/**
 * #85 — the pool mirror is per-boot too.
 *
 * `heavy`'s recorded compaction notice carried a `## CORE RULES` block naming `[dev2/001]`; the
 * replayed notice carried none. Both texts were byte-identical for 346 characters and diverged
 * there, because the rules read that builds model-visible text came from a fixed path inside this
 * repository (`cwd/.dsh-knowledge` / the store default) — development state of the project the rig
 * runs in, not test state. A tape is a claim about ONE world; a boot that reads the developer's
 * repo is a second world nobody recorded.
 */
test('boot.ts derives a mirror root per port and hands it to the realm pin writer', () => {
  const boot = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'boot.ts'), 'utf8')
  assert.match(boot, /export const rigMirrorRoot = \(port: number\): string => path\.join\(e2eHome\(port\), 'knowledge'\)/,
    "the mirror root is derived from the SAME per-boot home as the chapters store")
  assert.match(boot, /realmPinsOf\(pins, rigStoreRoot\(port\), rigMirrorRoot\(port\)\)/,
    'and it is passed on every boot — not left to the engine default')
  const pins = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'rig-preset-pin.ts'), 'utf8')
  assert.match(pins, /knowledgeMirrorDir: '\$\{pins\.knowledgeMirrorDir\}'/,
    'the realm row writer emits the key it is given')
})

test('the notice builder reads the configured mirror, never a workspace constant', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'engine.ts'), 'utf8')
  const line = src.split('\n').find((l) => l.includes('mirrorDir:'))
  assert.ok(line !== undefined, 'the rules block must still compose from a mirrorDir')
  assert.match(line, /resolveStoreRoot\(cwd, this\.chaptersConfig\.knowledgeMirrorDir/,
    `the mirror root must come from config: ${line?.trim()}`)
  assert.doesNotMatch(line, /path\.join\(cwd, DEFAULT_CLONE_DIR\)/,
    'a bare workspace constant here is the contamination this row exists to keep out')
})

test('the plugin Config declares the key with the historical default', () => {
  // Default unchanged for real installs: only an e2e boot moves it. A key the engine reads but no
  // schema declares is stripped by the loader — the 2026-09-18 lesson this repo already records.
  const idx = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(idx, /knowledgeMirrorDir: Schema\.string\(\)\.default\('\.dsh-knowledge'\)/,
    'declared on the plugin row with the pre-existing default')
})
