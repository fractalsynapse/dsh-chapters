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

// Version and dist integrity per hoisted @deepseek-ai package, plus the LOCKFILE entry that decided it.
// Why: the pinned host declares 79 deps, both trees install 289 of them, the booted profile mounts exactly one
// plugin (`@treeseed/dsh-chapters`), and yet the host's own `request/header` event reports 34 tools here against
// 7 on the runner with `config` and `adapterDefaults` byte-identical. So the difference must be in WHICH host
// code is actually running. `dsh`'s own integrity matching the registry proves only the top package; the
// transitive tool-providers need their own number. npm computes `dist.integrity` at pack time for every
// tarball — including git/hosted deps — so an installed package always has one to compare.
try {
  const scopeDir = path.join(installRoot, '@deepseek-ai')
  const names = fs.readdirSync(scopeDir)
  const topPkg = JSON.parse(fs.readFileSync(path.join(scopeDir, 'dsh', 'package.json'), 'utf8'))
  console.log(`topVersion=${String(topPkg.version)} topTarball=${String(topPkg._resolved ?? 'unknown')}`)

  const lock = JSON.parse(fs.readFileSync(path.join(root, 'dev', 'dsh-host-lock', 'package-lock.json'), 'utf8'))
  // npm v7+ keys are paths with the package name as the last segment, but nothing in the format guarantees
  // that; locate the entry by its final segment and verify the recorded name, rather than slicing on a guess.
  const lockEntry = (name) => {
    const suffix = `node_modules/${name}`
    for (const [k, v] of Object.entries(lock.packages ?? {})) {
      if (k === suffix || k.endsWith(`/${suffix}`)) {
        if (v?.name !== undefined && v.name !== name) continue
        return { key: k, integrity: v?.integrity, resolved: v?.resolved }
      }
    }
    return { key: null, integrity: undefined, resolved: undefined }
  }

  let mismatches = 0
  for (const n of names) {
    const full = `@deepseek-ai/${n}`
    let cur
    try { cur = JSON.parse(fs.readFileSync(path.join(scopeDir, n, 'package.json'), 'utf8')) } catch { continue }
    const lk = lockEntry(full)
    const curHead = String(cur.dist?.integrity ?? '').slice(0, 22)
    const lockHead = String(lk.integrity ?? '').slice(0, 22)
    if (lk.key === null) { console.log(`NOLOCKENTRY ${full} version=${String(cur.version)}`); continue }
    if (lockHead !== '' && curHead !== '' && curHead !== lockHead) {
      mismatches += 1
      console.log(`MISMATCH ${full} installed=${curHead || 'none'} lock=${lockHead || 'none'} version=${String(cur.version)}`)
    }
  }
  console.log(`checked=${String(names.length)} mismatched=${String(mismatches)} allIntegrityMatch=${String(mismatches === 0)}`)
} catch (e) {
  console.log(`integrity scan failed: ${String((e && e.message) ? e.message : e)}`)
}

// Earlier I attributed the tool gap to undeclared packages at the repo root. That was wrong and is corrected
// here: both trees show `repo-root-deepseek-ai=34` with 18 undeclared by package.json, and those are hoisted
// transitive deps of the pinned host, not things I installed. The profile-base count printed by the pre-boot
// report was likewise a measurement-order artifact, which is why the boot now reports its own mounted tree.
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

// Sandbox capability probe. The bash/fs/pwsh tool plugins arrive through `dsh-*-sandbox` packages, so a runner
// where bwrap exists but cannot create a user namespace could drop those tool plugins silently — which is the
// shape of "34 tools on this host, 7 on CI" while every installed byte is provably identical (integrity
// matched, profile ids matched, config and adapterDefaults identical). Exit codes and short messages only.
try {
  const { execFileSync } = await import('node:child_process')
  let ver = 'not-installed'
  try { ver = execFileSync('bwrap', ['--version'], { encoding: 'utf8' }).trim() } catch { /* absent */ }
  let run = 'unknown'
  try { execFileSync('bwrap', ['--ro-bind', '/', '/', '/bin/true'], { encoding: 'utf8', stdio: 'pipe' }); run = 'ok' }
  catch (e) { run = `failed: ${String((e && e.message) ? e.message : e).replace(/\s+/g, ' ').slice(0, 90)}` }
  console.log(`bwrap version=${ver} userNamespaceTest=${run}`)
} catch (e) {
  console.log(`bwrap probe error: ${String((e && e.message) ? e.message : e)}`)
}
