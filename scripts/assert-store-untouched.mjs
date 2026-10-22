#!/usr/bin/env node
/**
 * Assert the production store root is untouched by a test run (#61, item 8).
 *
 *   node scripts/assert-store-untouched.mjs snapshot          # before the suite
 *   node scripts/assert-store-untouched.mjs verify            # after
 *
 * WHY. The acceptance chain boots a real host against a throwaway HOME (`var/e2e-home-<port>`), but the
 * chapters STORE ROOT was never redirected, so every browser run wrote chapters into the project's real
 * `.dsh-chapters/` and rows into whatever registry the plugin resolved. Measured on this machine: 42 test
 * trees in the production store and 29 of 47 live registry rows with e2e-shaped ids — invisible to the
 * running app, visible to `buildLocalCorpus`, and reported as DAMAGE by #60's auditor (441 `test-litter`
 * findings). An audit whose residue is mostly test data trains the operator to ignore the real findings,
 * which is the failure mode this whole issue family is about.
 *
 * The boot now pins `artifactStoreRoot` per port (tests/e2e/boot.ts `applyRigPluginPatch`), and this is
 * the tripwire that says so OUT LOUD if the pin ever stops holding: a listing comparison, not a hope.
 * Snapshot/verify rather than cleanup: a suite that fails halfway must still be able to report what it
 * changed, and deleting the evidence is how contamination becomes invisible instead of fixed.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const STORE = path.join(ROOT, '.dsh-chapters')
const SNAP = path.join(ROOT, 'var', 'store-snapshot.json')

/** Stable, cheap identity: names + sizes + mtimes, sorted. Content hashes would be slower and no
 *  stronger here — a test that rewrote a chapter byte-for-byte would also have to break append-only. */
function listing(dir) {
  const out = []
  const walk = (d, depth) => {
    if (depth > 3) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { out.push(`${path.relative(dir, p)}/`); walk(p, depth + 1) }
      else {
        const st = fs.statSync(p)
        out.push(`${path.relative(dir, p)} ${st.size} ${Math.round(st.mtimeMs)}`)
      }
    }
  }
  walk(dir, 0)
  return out
}

const mode = process.argv[2]
if (mode !== 'snapshot' && mode !== 'verify') {
  console.error('usage: node scripts/assert-store-untouched.mjs snapshot|verify')
  process.exit(2)
}

if (!fs.existsSync(STORE)) {
  console.log(`no ${path.relative(ROOT, STORE)} — nothing to guard; ${mode} is a no-op`)
  if (mode === 'snapshot') fs.mkdirSync(path.dirname(SNAP), { recursive: true }), fs.writeFileSync(SNAP, JSON.stringify([]))
  process.exit(0)
}

const current = listing(STORE)

if (mode === 'snapshot') {
  fs.mkdirSync(path.dirname(SNAP), { recursive: true })
  fs.writeFileSync(SNAP, JSON.stringify(current, null, 1))
  console.log(`store snapshot taken: ${current.length} entr(ies) under ${path.relative(ROOT, STORE)}/`)
  process.exit(0)
}

if (!fs.existsSync(SNAP)) {
  console.error(`FAIL: no snapshot at ${path.relative(ROOT, SNAP)} — was \`snapshot\` run before the suite?`)
  console.error('      verifying against an unknown baseline would pass vacuously, which is worse than failing.')
  process.exit(1)
}
const before = JSON.parse(fs.readFileSync(SNAP, 'utf8'))
const added = current.filter((l) => !before.includes(l))
const removed = before.filter((l) => !current.includes(l))
if (added.length === 0 && removed.length === 0) {
  console.log(`store untouched across the run (${current.length} entries identical)`)
  process.exit(0)
}
console.error(`FAIL: the production store root CHANGED during the suite — the per-port store pin is not holding.`)
for (const a of added.slice(0, 12)) console.error(`  + ${a}`)
for (const r of removed.slice(0, 12)) console.error(`  - ${r}`)
if (added.length + removed.length > 24) console.error(`  …and ${added.length + removed.length - 24} more`)
console.error('  See #61 item 8: tests/e2e/boot.ts applyRigPluginPatch must set artifactStoreRoot per port.')
process.exit(1)
