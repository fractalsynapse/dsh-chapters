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
import { promptAnchorFor, PROMPT_SURFACE } from './prompt-anchor.mjs'
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
export function verdictFor(prev, built) {
  // #156: two quantities, two verdicts. `promptAnchor` is the bytes a model reads; `lib` is everything we ship. Only the
  // first makes a corpus STALE. Conflating them demanded a 45-minute re-record for #152/#153 (diagnostic fields no model
  // ever sees) while the job that could have caught the real drift is `continue-on-error: true` by decision (#92) — so a
  // gate in the wrong job enforces nothing, and a gate measuring the wrong bytes trains people to route around it.
  // Returns `{ stale, advisories, note }`: `stale` is the refuse condition; advisories pass.
  const advisories = []
  const stale = typeof prev?.promptAnchor === 'string' && prev.promptAnchor !== built.promptAnchor
  if (typeof prev?.promptAnchor !== 'string') {
    advisories.push('the stamp predates the prompt-byte anchor (no promptAnchor field) — run `npm run corpus:stamp` on a green replay; the gate cannot protect a corpus it has no anchor for')
  }
  if (typeof prev?.lib === 'string' && prev.lib !== built.lib) {
    advisories.push(stale
      ? `the build also changed (lib ${prev.lib} -> ${built.lib})`
      : `the build changed (lib ${prev.lib} -> ${built.lib}) while every model-facing byte is identical — the tapes still match this build; run \`npm run corpus:stamp\` on a green replay to keep the record honest`)
  }
  return { stale, advisories, note: `lib=${built.lib}, promptAnchor=${built.promptAnchor}` }
}

const isCli = process.argv[1] !== undefined && process.argv[1].endsWith('build-stamp.mjs')
const mode = process.argv[2] ?? 'stamp'
const anchor = promptAnchorFor('.', PROMPT_SURFACE)
// #156: two quantities, two verdicts. `promptAnchor` is the bytes a model sees; `lib` is everything we ship.
// Only the first one makes a corpus stale — a diagnostics-only change moves `lib` and must NOT demand a re-record.
const built = { lib: libDigest(), promptAnchor: anchor.anchor, gitSha, at: new Date().toISOString() }

if (!isCli) {
  // Imported for `verdictFor`/`libDigest` by tests: never touch the corpus from an import (#156).
} else if (mode === 'stamp') {
  fs.writeFileSync(STAMP, JSON.stringify({ ...built, note: 'written by `npm run corpus:stamp`; a replay refuses when lib/ no longer matches' }, null, 2) + '\n')
  console.log(`stamped corpus: lib=${built.lib} git=${built.gitSha.slice(0, 8)}`)
  process.exit(0)
}

if (!isCli) {
  // Imported (by tests) for `verdictFor`/`promptAnchorFor` only. The CLI below reads the corpus and can call
  // `process.exit`, which would kill a test runner that merely wanted a pure function (#156).
} else {
  let prev
  try { prev = JSON.parse(fs.readFileSync(STAMP, 'utf8')) } catch {
    console.error('BUILD_STAMP.json is missing — the corpus predates the one-build rule. Re-record the nine legs (`npm run corpus:rebuild`) and stamp it.')
    process.exit(1)
  }

  const verdict = verdictFor(prev, built)
  if (verdict.stale) {
    console.error(`REFUSED: model-facing bytes moved since this corpus was recorded (promptAnchor ${prev.promptAnchor} -> ${built.promptAnchor}). The recorded requests cannot be served by this build: re-record the affected projects, then stamp.`)
    for (const a of verdict.advisories) console.error(`  also: ${a}`)
    process.exit(1)
  }
  for (const a of verdict.advisories) console.error(`ADVISORY: ${a}`)
  console.log(`corpus matches the current build (${verdict.note})`)
}
