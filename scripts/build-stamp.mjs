#!/usr/bin/env node
/**
 * One build per corpus (#90) — the machine step that should have existed all week.
 *
 * A tape records what the PLUGIN sends, so a corpus is only meaningful if every leg was distilled
 * against one `lib/`. I violated that by re-recording single legs as each fix landed, and the failure
 * was invisible: a replay missed on a post-compaction surface because record's build could not fire the
 * last-resort deferral while replay's could. Rules written in prose did not stop me; a refusal will.
 *
 * `stamp` (after a build + full re-record) records the git sha and the built tree's identity.
 * `check` (called by the replay boot) refuses, LOUDLY, when the checkout's plugin bytes no longer match
 * the stamp — i.e. the corpus is stale relative to the code, which is not a test failure but a
 * measurement that would prove nothing.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = path.resolve(import.meta.dirname, '..')
const STAMP = path.join(ROOT, 'tests', 'fixtures', 'model-tape', 'BUILD_STAMP.json')

/**
 * A digest over BOTH halves of a measurement: the built plugin the boots load, and the e2e rig that
 * decides what counts as a match. The rig belongs in it because a normalizer change alters which
 * requests match which tapes — I edited test code while a replay was in flight today, which is the same
 * mixed-build hazard wearing a different hat. Sorted paths are folded in, so a rename is visible too.
 */
function libDigest () {
  const h = crypto.createHash('sha256')
  const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) } catch { return [] } }
  for (const rootDir of ['lib', path.join('tests', 'e2e')]) {
    for (const f of walk(path.join(ROOT, rootDir)).filter((x) => /\.(js|mjs|cjs|ts|tsx)$/.test(x)).sort()) {
      h.update(path.relative(ROOT, f)).update(fs.readFileSync(f))
    }
  }
  return h.digest('hex').slice(0, 16)
}

const gitSha = (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return 'unknown' } })()
const mode = process.argv[2] ?? 'stamp'
const built = { lib: libDigest(), gitSha, at: new Date().toISOString() }

if (mode === 'stamp') {
  fs.writeFileSync(STAMP, JSON.stringify({ ...built, note: 'written by `npm run corpus:stamp`; a replay refuses when lib/ no longer matches' }, null, 2) + '\n')
  console.log(`stamped corpus: lib=${built.lib} git=${built.gitSha.slice(0, 8)}`)
  process.exit(0)
}

let prev
try { prev = JSON.parse(fs.readFileSync(STAMP, 'utf8')) } catch {
  console.error('BUILD_STAMP.json is missing — the corpus predates the one-build rule. Re-record the nine legs (`npm run corpus:rebuild`) and stamp it.')
  process.exit(1)
}
if (prev.lib !== built.lib) {
  console.error(`REFUSED: the plugin changed since this corpus was recorded.\n  stamped: lib=${prev.lib} git=${String(prev.gitSha).slice(0, 8)} (${prev.at})\n  now:     lib=${built.lib} git=${built.gitSha.slice(0, 8)}\nA replay here measures nothing: the recorded requests were produced by different code. Re-record all nine legs under the current build.`)
  process.exit(1)
}
console.log(`corpus matches the current build (lib=${built.lib})`)
