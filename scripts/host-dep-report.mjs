#!/usr/bin/env node
// Report whether the pinned host's own @deepseek-ai dependencies exist on disk.                        #56
//
// Why: the acceptance runner's session mounts ONLY our seven plugin tools, while a local boot mounts 34, and the
// composed system header (message 0, the tape key) is therefore a strict SUBSET — 2,893 chars / 26 sentences on
// the runner against 7,396 / 64 locally, with zero runner-only sentences. Before reasoning further about why,
// ask the machine which tool-providing packages are actually installed and which were skipped.
//
// Prints no values that matter to a secret; package names and counts only.
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ?? process.cwd()
// Computed from the install root, NOT climbed from the package directory: my first two versions did the climb
// and reported all 79 declared deps as missing (once by using the package dir, once by a string-repeat that
// produced '......'). One anchor, one join.
const installRoot = path.join(root, 'dev', 'dsh-host-lock', 'node_modules')
const hostPkg = path.join(installRoot, '@deepseek-ai', 'dsh', 'package.json')

let declared
try {
  const j = JSON.parse(fs.readFileSync(hostPkg, 'utf8'))
  declared = Object.keys({ ...(j.dependencies ?? {}), ...(j.optionalDependencies ?? {}) })
    .filter((k) => k.startsWith('@deepseek-ai/'))
} catch (e) {
  console.log(`could not read host package.json: ${String((e && e.message) ? e.message : e)}`)
  process.exit(0)
}

let missing = 0
for (const name of declared) {
  if (!fs.existsSync(path.join(installRoot, name))) { missing += 1; console.log(`MISSING ${name}`) }
}
console.log(`declared=${String(declared.length)} missing=${String(missing)}`)

// The lock install being identical does NOT settle it: the dev profile links plugins from the REPOSITORY's own
// node_modules, so extra packages I installed there (not in package-lock) would mount tools a runner cannot
// mount. Measure that level too — it is the last place the 34-vs-7 gap can hide.
try {
  const repoNm = path.join(root, 'node_modules', '@deepseek-ai')
  const names = fs.readdirSync(repoNm)
  console.log(`repo-root-deepseek-ai=${String(names.length)}`)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const wanted = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })
    .filter((k) => k.startsWith('@deepseek-ai/'))
  const extra = names.filter((n) => !wanted.includes(`@deepseek-ai/${n}`))
  console.log(`declared-in-package.json=${String(wanted.length)} extra-on-disk=${String(extra.length)}`)
  if (extra.length > 0) console.log(`EXTRA ${extra.slice(0, 40).join(',')}`)
try {
  // The level that decides mounted tools: what the dev profile's plugin tree actually contains. The boot builds
  // this with the SAME script CI runs, so a difference here is a real environment fact, not a stale-cache story.
  const base = path.join(root, 'var', 'e2e-profile-base', 'profiles', 'web', 'node_modules')
  const treeseed = path.join(base, '@treeseed')
  const ds = path.join(base, '@deepseek-ai')
  const list = (d) => { try { return fs.readdirSync(d).length } catch { return 0 } }
  console.log(`profile-base-node_modules=${String(list(base))} profile-base-deepseek-ai=${String(list(ds))} profile-base-treeseed=${String(list(treeseed))}`)
  const home = path.join(root, '.dshdev-local', 'profiles', 'web', 'node_modules')
  console.log(`devhome-node_modules=${String(list(home))} devhome-deepseek-ai=${String(list(path.join(home, '@deepseek-ai')))}`)
} catch (e) {
  console.log(`profile-base scan failed: ${String((e && e.message) ? e.message : e)}`)
}

} catch (e) {
  console.log(`repo-root scan failed: ${String((e && e.message) ? e.message : e)}`)
}
try {
  console.log(`installed-top-level=${String(fs.readdirSync(installRoot).length)}`)
  console.log(`deepseek-ai-packages=${String(fs.readdirSync(path.join(installRoot, '@deepseek-ai')).length)}`)
} catch { console.log('installed-top-level=0') }
