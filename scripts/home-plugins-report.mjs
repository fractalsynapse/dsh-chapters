#!/usr/bin/env node
// Report the ids present in a booted home's profile patch AFTER the journey ran.                      #56
//
// Why this exists alongside the boot's own report: the boot reads the file the moment the URL appears, and if
// the host expands or rewrites `profiles/web/cordis.patch.yml` later, the report at boot is not the input the
// session was assembled from. That distinction matters because the runner registers 7 tools while this host
// registers 34 for the SAME project, with `config` and `adapterDefaults` byte-identical in the host's own
// `request/header` event — so either the patches differ at assembly time, or mounting fails silently at
// runtime. Two reports from the same artifact (boot-time and post-run) is the cheapest way to tell.
//
// Usage: node scripts/home-plugins-report.mjs <port> [suffix]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const port = process.argv[2]
if (port === undefined) { console.error('usage: home-plugins-report.mjs <port> [suffix]'); process.exit(2) }
const suffix = process.argv[3] ?? 'late'
const root = process.cwd()
const home = path.join(os.tmpdir(), 'dsh-e2e', `e2e-home-${port}`)
const patchFile = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
const webNm = path.join(home, 'profiles', 'web', 'node_modules')

const list = (d) => { try { return fs.readdirSync(d) } catch { return [] } }
let idsLine = 'unreadable'
try {
  const text = fs.readFileSync(patchFile, 'utf8')
  const ids = [...text.matchAll(/^\s*-?\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1])
  idsLine = `count=${String(ids.length)}:${ids.join(',')}`
} catch { /* the home may already be gone; the absence is itself the answer */ }

const line = `phase=${suffix}\nnode_modules=${String(list(webNm).length)}:${list(webNm).slice(0, 12).join(',')}\npatchPluginIds=${idsLine}\n`
fs.mkdirSync(path.join(root, 'var'), { recursive: true })
fs.writeFileSync(path.join(root, 'var', `e2e-home-plugins-${port}-${suffix}.log`), line)
console.log(`[home-plugins] ${suffix} port=${port} ${idsLine.slice(0, 60)}`)
