#!/usr/bin/env node
/**
 * #228 — environment parity, as a standing check instead of a discovery mid-incident.
 *
 * The maintainer's box runs TWO harnesses (their GUI: a root-owned `dsh web` long-lived since
 * Oct 20; this dev session: adrian's, restarted at each plugin change). Fixes verified in one
 * environment "did not work" in the other because the npm plugin copy the first server loads was
 * ~ten releases stale. Their standing order: test and development environments must ALWAYS match
 * the local one. This script makes that a fact you can run, not a hope you remember.
 *
 * Reports: live host version, rig pin, every installed plugin copy vs the repo's own version.
 * Exit code: 0 when all plugin copies match the repo version; 1 on any drift (CI gate).
 * Host-vs-rig-pin is REPORTED but not fatal — the rig bump to the maintainer's host is tracked
 * separately; what burned us was the PLUGIN copy, so that is what gates.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(import.meta.dirname, '..')
const readVersion = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? null } catch { return null }
}

const repoV = readVersion(path.join(ROOT, 'package.json'))
const rigPin = (() => {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'dsh-host-lock', 'package.json'), 'utf8'))
    return p.dependencies?.['@deepseek-ai/dsh'] ?? p.devDependencies?.['@deepseek-ai/dsh'] ?? null
  } catch { return null }
})()
// Every dsh install we know about: the user-level tree this workspace runs against, plus any
// global locations. Missing ones are reported absent, never guessed.
const hostTrees = [
  path.join(os.homedir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
  '/usr/lib/node_modules/@deepseek-ai/dsh/package.json',
]
const hosts = hostTrees.map((p) => ({ p, v: readVersion(p) })).filter((h) => h.v !== null)

// Installed plugin copies under every profile of every DSH home we can see.
const homes = [process.env.DSH_HOME, path.join(os.homedir(), '.dsh')].filter((x) => x !== undefined && x !== '')
const copies = []
for (const home of homes) {
  const profRoot = path.join(home, 'profiles')
  let profiles = []
  try { profiles = fs.readdirSync(profRoot) } catch { continue }
  for (const prof of profiles) {
    const pkg = path.join(profRoot, prof, 'node_modules', '@treeseed', 'dsh-chapters', 'package.json')
    const v = readVersion(pkg)
    // Dedupe: a symlinked profile tree can surface the same file twice.
    if (v !== null && !copies.some((c) => c.pkg === pkg)) copies.push({ pkg, v, profile: prof })
  }
}

console.log(`repo package version:      ${String(repoV)}`)
console.log(`rig host pin:              ${String(rigPin)}`)
for (const h of hosts) console.log(`live host:               ${h.v}  (${h.p})`)
if (hosts.length === 0) console.log('live host:               none found at the known trees')
for (const c of copies) console.log(`installed plugin copy:   ${c.v}  [profile ${c.profile}] — ${c.pkg}`)
if (copies.length === 0) console.log('installed plugin copy:   NONE under any profile — the plugin is not installed where these homes look')

let drift = false
for (const c of copies) {
  if (c.v !== repoV) { console.log(`DRIFT: installed copy ${c.v} != repo ${repoV} — restart the servers using it after publishing/installing`); drift = true }
}
if (!drift && copies.length === 0) { console.log('NOTE: no installed copies to compare'); }
// host-vs-pin advisory
if (hosts.length > 0 && rigPin !== null && !hosts.some((h) => h.v === rigPin)) {
  console.log(`ADVISORY: live host(s) ${hosts.map((h) => h.v).join(', ')} differ from the rig pin ${rigPin} — acceptance replays the pinned shape, not the live one (#221 class of gap)`)
}
process.exit(drift ? 1 : 0)
