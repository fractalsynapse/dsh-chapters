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
try {
  console.log(`installed-top-level=${String(fs.readdirSync(installRoot).length)}`)
  console.log(`deepseek-ai-packages=${String(fs.readdirSync(path.join(installRoot, '@deepseek-ai')).length)}`)
} catch { console.log('installed-top-level=0') }
