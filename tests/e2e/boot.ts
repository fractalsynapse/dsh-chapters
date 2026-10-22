import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { startModelProxy, type ProxyHandle } from './model-proxy.ts'

/**
 * The provenance reader lives in `scripts/corpus-anchor.mjs` so CI and the rig ask the SAME
 * question the same way (two parsers drift). Loaded lazily and typed loosely: it is plain JS
 * outside the tsconfig project, and a provenance check must never be the reason a boot
 * fails to compile.
 */
async function importedCorpusAnchor(): Promise<{ anchored?: boolean, reason?: string, tracking?: string } | null> {
  try {
    const mod = await import('../../scripts/corpus-anchor.mjs') as unknown as { corpusAnchor?: () => { anchored: boolean, reason: string, tracking: string | null } }
    return typeof mod.corpusAnchor === 'function' ? mod.corpusAnchor() : null
  } catch { return null }
}

/**
 * Shared e2e boot harness. One server per playwright PROJECT (the main suite
 * and the arrival-artifact suite pin different engine rows — the arrival floor
 * must not change the compaction-crossing scenarios' regime), against one
 * throwaway home rebuilt every boot. The home is copied from .dshdev-local
 * minus all mutable state (sessions, the chapters domain, stored tokens) —
 * the ONLY file kept from storages/ is workspace.json, because workspace
 * ATTACHMENT is setup state: a pristine home shows 'No sessions yet' and
 * never mints a draft session (measured). The plugin is link-installed, so
 * every boot runs the CURRENT build in lib/.
 */
export const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** The `@deepseek-ai/dsh` version the e2e closure pins (dev/dsh-host-lock/package.json). */
export function pinnedHostVersion(): string {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'dsh-host-lock', 'package.json'), 'utf8')) as
      { dependencies?: Record<string, string> }
    return lock.dependencies?.['@deepseek-ai/dsh'] ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Does the pinned host compose presets from declaration rows (>= 0.2.0)?
 *  A version TEST, not a capability probe, because this runs before any host is booted —
 *  the product code probes the service's shape instead (src/index.ts § Preset delivery).
 *  Minor-version arithmetic is deliberately absent: 0.2.x is the floor, and a prerelease
 *  of it (0.2.0-rc.1) is in range. */
export function hostSupportsPresetRows(): boolean {
  const match = /^(\d+)\.(\d+)/.exec(pinnedHostVersion())
  if (match === null) return false
  return Number(match[1]) > 0 || (Number(match[1]) === 0 && Number(match[2]) >= 2)
}

/** port-keyed home: two boots running at once (even accidentally) can never
 * wipe or corrupt each other's state — a same-home collision was measured
 * destroying an in-flight capture (2026-09-19). */
export const e2eHome = (port: number): string => path.join(ROOT, 'var', `e2e-home-${port}`)

/**
 * The rig's OWN plugin config row, written into the profile patch per boot (#61 item 8).
 *
 * Measured cost of not having it: **29 of 47 rows in the developer's live registry are e2e-shaped, and
 * 42 test trees sit in this repo's production `.dsh-chapters/`** — invisible to the live app yet read by
 * `buildLocalCorpus`, and read as DAMAGE by #60's auditor (441 `test-litter` findings). An audit whose
 * residue is mostly someone else's test data teaches the operator to distrust the real findings.
 *
 * Pure and exported so a deterministic row can pin it: whether the host honours this row can only be
 * observed by booting a browser, but WHERE the rig writes it — and that an existing row is replaced
 * rather than duplicated, which would leave the last row winning by accident — is testable here and now.
 */
export const rigStoreRoot = (port: number): string => path.join(e2eHome(port), 'chapters')

export function applyRigPluginPatch(existing: string, opts: { storeRoot: string; promptModel?: string | undefined }): string {
  const row = `- id: '@treeseed/dsh-chapters'
  config:
    # per-boot absolute store root (#61): the acceptance chain must never write
    # into the project's real .dsh-chapters/ tree. The host merges a patch row by id.
    artifactStoreRoot: ${opts.storeRoot}
${opts.promptModel !== undefined ? `    # #71: the ghost journey boots WITH a defining model —
    # setting one IS the enable (site §28). Absent otherwise: the feature must not exist.
    promptModel: ${opts.promptModel}
` : ''}`
  // Drop OUR previous row, indentation and all, so reruns replace rather than duplicate — a second
  // row for the same id would leave "which one wins" up to the host's merge order. Line-scanned
  // rather than regex-matched across newlines: the readable version of this rule is the one that
  // does not span four lines of a character class.
  const out: string[] = []
  let skipping = false
  for (const line of existing.split('\n')) {
    if (/^- id: '@treeseed\/dsh-chapters'/.test(line)) { skipping = true; continue }
    if (skipping && !/^\s/.test(line) && line !== '') skipping = false
    if (!skipping) out.push(line)
  }
  return row + out.join('\n')
}


export interface Pins {
  thresholdRatio: string
  /**
   * Turn the engine's MODEL-INVOLVING machinery off for this boot. A journey whose
   * tape depends on whether pressure compaction happens to fire is a journey that
   * passes on one machine and misses on another (measured: the 0.1.9/0.1.10 plans
   * runs on hosted CI issued a plot-elicitation request no local tape had ever seen).
   * `noAuxModel: true` disables automatic compaction AND plot elicitation, so the
   * request sequence the tape carries is the whole story regardless of how large a
   * runner's header happens to be.
   */
  noAuxModel?: boolean
  enrichment?: boolean
  toolResultArtifactTokens?: string
  /** #71: boot WITH the prompt ghost enabled — the rig writes the defining
   *  model into the plugin's config row. Absent ⇒ the row is absent ⇒ the
   *  feature does not exist on that boot (which is itself the OFF-state test). */
  promptModel?: string
}

export interface BootHandle {
  url: string
  port: number
  stop: () => Promise<void>
}

export async function bootE2eServer(port: number, pins: Pins): Promise<BootHandle> {
  // proxy port derived from the boot port (+1000): per-project and per-rerun
  // collision-free (a hard-coded proxy port turned one killed run's orphan
  // into EADDRINUSE for every later boot — measured 2026-09-22)
  process.env.E2E_PROXY_PORT = String(port + 1000)
  // Probe bundle must never shadow the product (idempotent; run on the SOURCE
  // home before the copy so the copy is clean too). npm-based, not `dsh plugin
  // remove`: that forwards to pnpm, which this repo never uses — and which
  // failed noisily (ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS) on every boot when
  // the probe was absent, which is every boot.
  {
    const pkgPath = path.join(ROOT, '.dshdev-local', 'profiles', 'web', 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: string[] } }
      }
      if (pkg.dependencies?.['dsh-chapters-probe'] !== undefined || (pkg.dsh?.profile?.bundles ?? []).includes('dsh-chapters-probe')) {
        delete pkg.dependencies?.['dsh-chapters-probe']
        if (pkg.dsh?.profile?.bundles) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== 'dsh-chapters-probe')
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
        spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: path.dirname(pkgPath), env: process.env, timeout: 90_000 })
        console.warn('e2e: removed probe bundle from the dev profile')
      }
    } catch { /* no profile yet — nothing to remove */ }
  }

  const E2E_HOME = e2eHome(port)
  fs.rmSync(E2E_HOME, { recursive: true, force: true })
  fs.cpSync(path.join(ROOT, '.dshdev-local'), E2E_HOME, { recursive: true, filter: (src) => {
    const rel = path.relative(path.join(ROOT, '.dshdev-local'), src)
    return rel === ''
      || rel === 'storages' || rel === 'storages/workspace.json'
      || (!rel.startsWith('sessions') && !rel.startsWith('storages' + path.sep) && !rel.startsWith('dsh-chapters') && !rel.startsWith('.dsh-chapters'))
  } })

  // DETERMINISTIC PRISTINE WORKSPACE (measured 2026-09-24, the last local-vs-CI
  // divergence): the dev home's storages/workspace.json accumulates real
  // sessionIds across runs, and the web app restores the workspace's newest
  // session on load — locally specs silently asked their questions inside
  // leftover fork children (that's why the suite tape once carried TOC-prefixed
  // first turns), while CI's clean seed (sessionIds: []) always lands on a
  // pristine draft. Same home, one line, machines converge.
  {
    const wsFile = path.join(E2E_HOME, 'storages', 'workspace.json')
    if (fs.existsSync(wsFile)) {
      const ws = JSON.parse(fs.readFileSync(wsFile, 'utf8')) as { tables?: { workspaces?: Record<string, { sessionIds?: unknown[] }> } }
      for (const w of Object.values(ws.tables?.workspaces ?? {})) w.sessionIds = []
      fs.writeFileSync(wsFile, JSON.stringify(ws, null, 2))
    }
  }

  // The chapters preset is a registered DECLARATION ROW now (src/preset.ts); the
  // `$DSH_HOME/.agent-presets/` directory this chain used to copy into is read by no host
  // from 0.1.7-alpha.1, and the pinned host predates `agentPresets.register()` entirely.
  // So the refusal is a real check on the pinned version rather than a thrown constant:
  // it lifts itself the moment `dev/dsh-host-lock` moves to >= 0.2.0, which is exactly
  // the re-anchor the backlog asks for (and the tapes must be re-distilled with it —
  // the persona suffix is prompt bytes). A silently skipped pin would be worse than red:
  // every segment would pass a run that never exercised the preset.
  if (!hostSupportsPresetRows()) {
    throw new Error(
      `e2e: the pinned host (@deepseek-ai/dsh ${pinnedHostVersion()}) cannot register preset declaration rows; `
      + 'this plugin supports >= 0.2.0. Move dev/dsh-host-lock to a 0.2.x host and re-distill the tapes '
      + '(docs/backlog.md). The deterministic suite (npm test / coverage:ci) is unaffected and is what gates a release.')
  }
  // Per-boot row pins (thresholdRatio / enrichmentEnabled / auto / elicitedPlot /
  // toolResultArtifactTokens, and the `[e2e] boot pins:` line that made them observable)
  // patched the YAML this mechanism used to install. They come back re-expressed as CONFIG
  // on the registered row with the host re-anchor — until then this chain must not run.

  // STRESS REGIME pin (user directive 2026-09-19): 32K window / 15K response.
  // E2E_MODEL=record|replay inserts the tape proxy (same directive's second
  // half: the GPU model distills tapes; acceptance replays them in seconds).
  const modelMode = process.env.E2E_MODEL ?? 'live'
  // REPLAY asserts against recorded prompt prefixes, which carry the host's prompt
  // composition. If the corpus was distilled against a different host than we pin, the
  // chain cannot pass for reasons belonging to an earlier change — so refuse BY NAME,
  // with the tracking issue, exactly as hostSupportsPresetRows() does for a host that
  // cannot register preset rows. RECORD is exempt: re-distilling is the way out, and
  // blocking it would strand the gate (#56).
  if (modelMode === 'replay') {
    const anchor = await importedCorpusAnchor()
    if (anchor !== null && anchor.anchored !== true) {
      throw new Error(`e2e: the tape corpus is NOT anchored to this host — ${String(anchor.reason)}. `
        + `Re-distill the nine projects (scripts/distill-tapes.sh) and update tests/fixtures/model-tape/CORPUS_HOST; `
        + `tracked by ${String(anchor.tracking ?? 'docs/backlog.md')}. Recording is allowed (E2E_MODEL=record); replay is not.`)
    }
  }
  const upstreamBase = process.env.E2E_UPSTREAM ?? 'http://localhost:8080'
  // A remote upstream without a key is a guaranteed 401 on every request, eight
  // projects long. Fail here, in one line, with the fix in the message.
  if (modelMode === 'record' && !/^https?:\/\/(localhost|127\.|\[::1\])/.test(upstreamBase)
    && (process.env.E2E_UPSTREAM_KEY === undefined || process.env.E2E_UPSTREAM_KEY === '')) {
    throw new Error(`e2e: E2E_UPSTREAM=${upstreamBase} is remote but E2E_UPSTREAM_KEY is unset — the tape proxy would forward the profile's dummy credential and every distill request would 401. Set E2E_UPSTREAM_KEY (and E2E_UPSTREAM_MODEL if the endpoint serves a different id).`)
  }
  let proxy: ProxyHandle | null = null
  if (modelMode === 'record' || modelMode === 'replay') {
    proxy = await startModelProxy({
      mode: modelMode,
      // per-project tapes: a failed capture's entries must never resurrect as
      // another pin's replay continuation (prefix collisions across pins are
      // otherwise invisible and land the session in someone else's transcript)
      tapeDir: path.join(ROOT, 'tests', 'fixtures', 'model-tape', process.env.E2E_TAPE ?? 'default'),
      journalPath: path.join(ROOT, 'var', 'e2e-tape-misses.log'),
      // E2E_TAPE_FALLBACK=1: tape hits stay, misses go live and are
      // recorded — a self-healing pass instead of a full re-record
      ...(process.env.E2E_TAPE_FALLBACK === '1' ? { liveFallback: true } : {}),
      upstream: upstreamBase,
      // #54: a REMOTE distill target. The profile pins the local fixture's model id
      // and its key env; a hosted endpoint knows neither. The proxy translates both
      // on the way out, and the tape still records the fixture's name — so a
      // re-distill needs no per-machine profile edit (the drift the hermetic host
      // lock exists to prevent).
      ...(process.env.E2E_UPSTREAM_KEY !== undefined && process.env.E2E_UPSTREAM_KEY !== ''
        ? { upstreamKey: process.env.E2E_UPSTREAM_KEY }
        : {}),
      ...(process.env.E2E_UPSTREAM_MODEL !== undefined && process.env.E2E_UPSTREAM_MODEL !== ''
        ? { upstreamModel: process.env.E2E_UPSTREAM_MODEL }
        : {}),
    })
  }
  // #54: the profile's provider block, guaranteed present and pointed at the rig.
  // 0.2.x reads provider config ONLY from cordis.patch.yml, and the home this boot
  // copies may predate that file's llm-pi-ai entry (or be a CI-built profile), so
  // append it when absent and rewrite the baseURL when a tape proxy is in front.
  {
    const patchPath = path.join(E2E_HOME, 'profiles', 'web', 'cordis.patch.yml')
    if (fs.existsSync(patchPath)) {
      let p = fs.readFileSync(patchPath, 'utf8')
      if (!/^[-\s]*id: llm-pi-ai\s*$/m.test(p)) {
        p = `- id: llm-pi-ai\n  config:\n    providers:\n      local:\n        displayName: Local\n        api: openai-completions\n        baseURL: http://localhost:8080/v1\n        models:\n          - id: qwen3.8-flash-next\n            name: qwen3.8-flash-next (dev, 32K stress)\n            contextWindow: 32000\n            maxTokens: 15000\n        apiKeyEnv: LOCAL_API_KEY\n        streamIdleTimeoutMs: 3600000\n        timeoutMs: 3600000\n        reasoning: medium\n        retryPolicy:\n          mode: normal\n          maxRetries: 0\n` + p
      }
      p = p.replace(/contextWindow: \d+/g, 'contextWindow: 32000').replace(/maxTokens: \d+/g, 'maxTokens: 15000')
      if (proxy !== null) p = p.replace(/baseURL: \S+\/v1/, `baseURL: ${proxy.url}`)
      // #61 item 8: THIS boot's chapters go to this port's home, never to the repo's store root.
      p = applyRigPluginPatch(p, { storeRoot: rigStoreRoot(port), ...(pins.promptModel !== undefined ? { promptModel: pins.promptModel } : {}) })
      fs.writeFileSync(patchPath, p)
    }
  }
  // WHICH BUILD IS THIS BOOT RUNNING? Assert it, do not assume it (the #54 lesson, earned
  // over hours): the home is copied from `.dshdev-local`, and that directory's plugin entry
  // had silently become a COPIED tree from Oct 16 — so every browser probe, every
  // "0.2.x refuses our seed" conclusion, and two re-distill attempts were measuring a build
  // that predated the feature under test. The docs said "the plugin is link-installed, so
  // every boot runs the CURRENT build in lib/" and nothing checked it. A copy is not a link.
  {
    const mounted = path.join(E2E_HOME, 'profiles', 'web', 'node_modules', '@treeseed', 'dsh-chapters')
    let resolved: string | null = null
    try { resolved = fs.realpathSync(mounted) } catch { resolved = null }
    if (resolved === null) {
      throw new Error(`e2e boot: no @treeseed/dsh-chapters in the dev home profile (${mounted}). `
        + 'Install the CURRENT build: DSH_HOME=$PWD/.dshdev-local dsh plugin --profile web add "link:" + process.cwd()')
    }
    if (path.resolve(resolved) !== ROOT) {
      throw new Error(`e2e boot: the dev home mounts a COPIED plugin tree (${resolved}), not this working copy (${ROOT}). `
        + 'A copy silently ages: assertions would be measuring an old build. Re-link: '
        + 'rm -rf .dshdev-local/profiles/web/node_modules/@treeseed/dsh-chapters && '
        + 'DSH_HOME=$PWD/.dshdev-local dsh plugin --profile web add "link:" + process.cwd()')
    }
  }
  const liveSettings = path.join(E2E_HOME, 'settings.yaml')
  if (fs.existsSync(liveSettings)) {
    const s = fs.readFileSync(liveSettings, 'utf8')
    let y = s
      .replace(/contextWindow: \d+/g, 'contextWindow: 32000')
      .replace(/maxTokens: \d+/g, 'maxTokens: 15000')
    if (proxy !== null) y = y.replace(/baseURL: \S+\/v1/, `baseURL: ${proxy.url}`)
    fs.writeFileSync(liveSettings, y)
  }

  // Port-conflict guard (measured 2026-09-22): an orphaned boot holding the
  // port turned this wait into a 60s blind deadline with an opaque tail-log.
  // Fail fast, name the port, say what to do.
  const busy = await new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => { s.destroy(); resolve(false) })
  })
  if (busy) {
    throw new Error(`e2e boot: port ${port} is already in use — an earlier run's server survived teardown; kill it (pkill -f "dsh web --port ${port}") or pick another E2E_PORT`)
  }

  // E2E_COVERAGE=1 makes the boot write V8 coverage (var/e2e-cov/<port>) on
  // its clean exit — the answer to the coverage audit's §4A: tools.ts /
  // engine.ts / index.ts run inside every boot but were coverage-INVISIBLE to
  // the deterministic report. Aggregate with scripts/e2e-coverage.mjs.
  const covDir = path.join(ROOT, 'var', 'e2e-cov', String(port))
  if (process.env.E2E_COVERAGE === '1') { fs.rmSync(covDir, { recursive: true, force: true }); fs.mkdirSync(covDir, { recursive: true }) }
  const child: ChildProcessWithoutNullStreams = spawn('dsh', ['web', '--port', String(port), '--no-open'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_HOME: E2E_HOME,
      // Port-keyed like everything else about a boot: one shared file made a red
      // chain ambiguous — the tail belonged to whichever project wrote last.
      DSH_CHAPTERS_ENGINE_ERRORS: path.join(ROOT, 'var', `e2e-engine-errors-${port}.log`),
      ...(process.env.E2E_COVERAGE === '1' ? { NODE_V8_COVERAGE: covDir } : {}),
      // dev/settings.yaml pins the local provider's key via apiKeyEnv, and a
      // CI box has no ~/.dsh credentials to fall back on (measured 2026-09-23:
      // a credential-less .dshdev-local boots, but every session then dies
      // composing the provider). Tape replay ignores auth entirely (the proxy
      // answers), so the dummy fills only when neither the environment NOR
      // the home's .credentials.yaml carries a real key — a machine distilling
      // tapes against a key-guarded llama must keep using its real one.
      // #54: forward the diagnostics sink. The boot hands the server an EXPLICIT env
      // object, so a variable set in the invoking shell never reached the process that
      // actually refused the child — which is how a browser-path refusal with a full
      // stack in hand still produced an empty log file. Traceability that stops at the
      // process boundary is not traceability.
      ...(process.env.DSH_CHAPTERS_ENGINE_ERRORS !== undefined && process.env.DSH_CHAPTERS_ENGINE_ERRORS !== ''
        ? { DSH_CHAPTERS_ENGINE_ERRORS: process.env.DSH_CHAPTERS_ENGINE_ERRORS }
        : {}),
      ...(proxy !== null && process.env.LOCAL_API_KEY === undefined
        && !fs.existsSync(path.join(E2E_HOME, '.credentials.yaml'))
        ? { LOCAL_API_KEY: 'e2e-tape-proxy-dummy' }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  // persist the server's stdout/stderr for failure artifacts — a 7-minute
  // spec timeout with NO proxy traffic is invisible without the host's own
  // log (CI 2026-09-24), and var/e2e-boot.json alone cannot tell the story
  const serverLog = path.join(ROOT, 'var', `e2e-server-${port}.log`)
  fs.writeFileSync(serverLog, '')
  child.stdout.on('data', (d) => { log += d; fs.appendFileSync(serverLog, d) })
  child.stderr.on('data', (d) => { log += d; fs.appendFileSync(serverLog, d) })
  const deadline = Date.now() + 60_000
  while (!/http:\/\/127\.0\.0\.1:[0-9]+\/\?token=\S+/.test(log) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
  }
  const m = /http:\/\/127\.0\.0\.1:[0-9]+\/\?token=\S+/.exec(log)
  if (m === null) {
    child.kill('SIGKILL')
    throw new Error(`e2e boot failed within 60s (port ${port})\n${log.slice(-1500)}`)
  }
  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-boot.json'), JSON.stringify({ url: m[0], port }))
  return {
    url: m[0],
    port,
    stop: async () => {
      if (proxy !== null) await proxy.close().catch(() => undefined)
      if (child.exitCode === null) child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          // SIGTERM proved unreliable once the server had live clients — the
          // orphans that held 41731/41741 were born this way. Escalate.
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          resolve()
        }, 5000)
        child.once('exit', () => { clearTimeout(t); resolve() })
      })
    },
  }
}
