/** The probe runner: provisions a home layout, copies (never symlinks — realpath resolution would
 *  defeat the walk-up measurement) the plugin into the profile, boots the probe host's own dsh,
 *  waits for the results file, prints it, kills the host. Usage: node run.mjs <homeDir> <port> */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const home = path.resolve(process.argv[2] ?? path.join(HERE, 'host', 'probe-home'))
const port = process.argv[3] ?? '4199'
const RESULTS = path.join(HERE, `results-${path.basename(home)}-${port}.json`)
const dsh = path.join(HERE, 'host', 'node_modules', '.bin', 'dsh')
if (!fs.existsSync(dsh)) { console.error(`no probe host at ${dsh} — npm install first`); process.exit(1) }

// Provisioning, the sanctioned way (our own cordis.patch.yml header documents it):
//   DSH_HOME=<home> dsh plugin --profile web add "link:<plugin>"
// The CLI's plugin-manager runs pnpm, updates the profile's package.json/bundles, and writes the
// mount rows. Hand-editing package.json + a raw copy loads NOTHING (measured twice, 2026-10-31).
import { spawnSync } from 'node:child_process'
const provisionBoot = !fs.existsSync(path.join(home, 'profiles', 'web', 'package.json'))
if (provisionBoot) {
  console.log('provisioning: first boot to let the host create the profile, then kill')
  const first = spawn(dsh, ['web', '--port', port, '--no-open'], { cwd: HERE, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve) => {
    let buf = ''
    const onData = (d) => { buf += String(d); if (buf.includes('dsh web: http')) { first.off('stdout', onData); first.off('stderr', onData); resolve() } }
    first.stdout.on('data', onData); first.stderr.on('data', onData)
    setTimeout(resolve, 45_000)
  })
  first.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 1_500))
}
const add = spawnSync(dsh, ['plugin', '--profile', 'web', 'add', `link:${path.join(HERE, 'plugin')}`], {
  cwd: HERE, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 240_000,
})
console.log(`plugin add: rc=${String(add.status)} ${(add.stdout ?? '').trim().split('\n').slice(-2).join(' | ')} ${(add.stderr ?? '').trim().split('\n').slice(-2).join(' | ')}`)
fs.rmSync(RESULTS, { force: true })

// Minimal provider + default-model rows: the bare home composes no agent factory
// ("no agent factory registered (load an agent-loop plugin)") until a default model exists.
// The route is deliberately dead (port 9) — the probe never turns; it only needs a Session.
{
  const profileDir = path.join(home, 'profiles', 'web')
  const patchPath2 = path.join(profileDir, 'cordis.patch.yml')
  let cur = fs.existsSync(patchPath2) ? fs.readFileSync(patchPath2, 'utf8') : '[]'
  if (!cur.includes('agent-default-model')) {
    const rows = `
- id: llm-pi-ai
  config:
    providers:
      probe:
        displayName: Probe
        api: openai-completions
        baseURL: http://127.0.0.1:9/v1
        models:
          - id: probe-model
            name: probe-model
            contextWindow: 32768
            maxTokens: 64
        apiKeyEnv: PROBE_KEY
- id: agent-default-model
  config:
    provider: probe
    model: probe-model
    reasoningEffort: medium
`
    // the provisioned file is comments + a bare `[]` empty-array line: drop THAT line (regex on its
    // own line, not a trim compare — the comments made 'cur === "[]"' false and produced invalid YAML)
    cur = cur.split('\n').filter((l) => l.trim() !== '[]').join('\n')
    fs.writeFileSync(patchPath2, cur + rows)
  }
}

const child = spawn(dsh, ['web', '--port', port, '--no-open'], {
  cwd: HERE,
  env: { ...process.env, DSH_HOME: home, PROBE_RESULTS: RESULTS, PROBE_KEY: 'probe-dummy-key' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let bootLog = ''
child.stdout.on('data', (d) => { bootLog += String(d) })
child.stderr.on('data', (d) => { bootLog += String(d) })

const t0 = Date.now()
const poll = setInterval(() => {
  if (fs.existsSync(RESULTS)) {
    const text = fs.readFileSync(RESULTS, 'utf8')
    let done = false
    try { done = JSON.parse(text).done === true } catch { done = false }
    if (done) {
      clearInterval(poll)
      console.log(text)
      child.kill('SIGTERM')
      process.exit(0)
    }
  }
  if (Date.now() - t0 > 90_000) {
    clearInterval(poll)
    console.log('TIMEOUT — no results file. Boot log tail:\n' + bootLog.slice(-2400))
    child.kill('SIGTERM')
    process.exit(1)
  }
}, 500)
