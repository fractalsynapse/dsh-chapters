/**
 * dev/install SDK API service gate (#25).
 *
 * Pins the contract of `compose.sdk.yml`, the sdk profile generation in
 * `docker-entrypoint.sh` / `Dockerfile`, and the WebSocket↔stdio gateway.
 * Outside-in, mirroring dev-install-compose.test.ts discipline:
 *
 *   1. acceptance — `docker compose config` renders the sdk stack without an
 *      unexpanded `${VAR}` literal (the #19 failure class), skipped only when
 *      docker is absent;
 *   2. regression — no exec-form JSON-array argument carries a `${...}` token
 *      anywhere in the new files (same family as #19);
 *   3. contract — the sdk profile bundle list carries base + sdk-app + ALL dev
 *      plugins (chapters/codegraph/tinyfish): "keep the Web UI configuration"
 *      is a load-bearing requirement, so a dropped plugin must go red here;
 *   4. contract — settings delivery rides cordis.patch.yml, NOT profile-dir
 *      settings.yaml: measured on host 0.2.x that nothing reads a profile's
 *      settings.yaml (only $DSH_HOME/settings.yaml gets a ONE-TIME legacy
 *      import at packages/settings/settings/src/index.ts:243) — the live
 *      container proved its generated local-vLLM provider never took effect;
 *   5. contract — .env.example declares every variable compose.sdk.yml reads,
 *      with matching defaults;
 *   6. unit — the gateway relay logic over a fake runtime child: auth refuses
 *      before spawn, frames relay verbatim both directions, child death closes
 *      the peer, idle TTL reaps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const DIR = join(import.meta.dirname!, '../../dev/install')
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8')
const stripComments = (text: string): string =>
  text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

const dockerAvailable = (() => {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// ── 1. acceptance ────────────────────────────────────────────────────────────

test('acceptance: docker compose config renders the sdk stack without error', { skip: !dockerAvailable && 'docker not available on this machine' }, () => {
  const out = execFileSync('docker', ['compose', '-f', join(DIR, 'compose.sdk.yml'), 'config'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.doesNotMatch(out, /\$\{[A-Z_]+\}/, 'rendered compose output still carries an unexpanded ${VAR} literal')
})

// ── 2. regression: the #19 interpolation family ─────────────────────────────

test('regression: no exec-form instruction passes a ${VAR} literal into argv (#19 family)', () => {
  for (const file of ['compose.sdk.yml', 'Dockerfile']) {
    const body = stripComments(read(file))
    // JSON-array form: ["x", "${VAR}", ...] — Docker performs NO shell
    // expansion inside exec form; the literal reaches argv.
    const execArrays = [...body.matchAll(/\[(?:[^\][\n]*"[^"\n]*"[^\][\n]*)\]/g)].map((m) => m[0])
    for (const arr of execArrays) {
      assert.doesNotMatch(arr, /"\$\{[A-Z_]+\}"/, `${file}: exec-form element holds an unexpanded \${VAR}: ${arr.slice(0, 120)}`)
    }
  }
})

// ── 3. contract: the sdk profile carries the full dev plugin set ────────────

test('contract: sdk profile bundles include base + sdk-app + all three dev plugins', () => {
  const dockerfile = read('Dockerfile')
  // find the printf that writes profiles/sdk/package.json
  const sdkManifest = /printf '[^']*dsh-profile-sdk[^']*'/.exec(dockerfile)
  assert.ok(sdkManifest !== null, 'Dockerfile must write a profiles/sdk/package.json manifest (name dsh-profile-sdk)')
  const decoded = decodePrintf(sdkManifest![0]!)
  const manifest = JSON.parse(decoded) as { dsh?: { profile?: { bundles?: string[] } } }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  for (const required of [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-sdk-app',
    '@treeseed/dsh-chapters',
    '@jiangzhenguo/dsh-codegraph',
    'dsh-tinyfish-search',
  ]) {
    assert.ok(bundles.includes(required), `sdk profile drops ${required} — hosted agents would lose its tools (bundles: ${bundles.join(', ')})`)
  }
})

test('contract: sdk profile installs the same npm deps as the web profile', () => {
  const dockerfile = read('Dockerfile')
  const sdkSection = dockerfile.slice(dockerfile.indexOf('dsh-profile-sdk'))
  assert.ok(sdkSection.length > 0, 'no sdk profile section found in Dockerfile')
  // chapters via file:/app, codegraph via github:, tinyfish pinned — same trio
  assert.match(sdkSection, /@treeseed\/dsh-chapters\\?": "file:\/app/, 'sdk profile must resolve dsh-chapters from the built /app')
  assert.match(sdkSection, /npm install .*--legacy-peer-deps/, 'sdk profile install needs --legacy-peer-deps (#19: silent skips swallowed the conflict)')
})

// ── 4. contract: settings ride the patch, not a dead settings.yaml ──────────

test('contract: entrypoint generates cordis.patch.yml rows carrying the local vLLM provider', () => {
  const entry = read('docker-entrypoint.sh')
  // The measured fact: profiles/<p>/settings.yaml is read by NOTHING on 0.2.x.
  // Delivery must be patch rows whose llm-pi-ai config includes BOTH routes.
  assert.match(entry, /cordis\.patch\.yml/, 'entrypoint must generate the profile patch file')
  const gen = entry.slice(entry.indexOf('generate_profile_patch'))
  assert.ok(gen.length > entry.length / 2 || gen.length > 0, 'expected a generate_profile_patch function')
  assert.match(gen, /baseURL: \$\{LLM_BASE_URL/, 'generated patch must carry the local vLLM baseURL (env-expanded at write time)')
  assert.match(gen, /apiKeyEnv: LOCAL_API_KEY/, 'local route must reference the env key')
  assert.match(gen, /qwen-token-plan:/, 'generated patch must keep the Alibaba marketplace route')
  assert.match(gen, /provider: \$\{LLM_PROVIDER:-local\}|provider: local/, 'agent-default-model must select the local route by default (small-model stance)')
})

test('regression: entrypoint no longer relies on profile-dir settings.yaml (#25 finding)', () => {
  const entry = read('docker-entrypoint.sh')
  // Writing it is tolerated ONLY if the patch also carries the providers; the
  // dead-path alone was the latent bug: agent-default-model pointed at `local`
  // while no adapter registered that route, because nothing read the document.
  const writesSettings = /cat > "\$PROFILE_DIR\/settings\.yaml"|profiles\/[a-z]+\/settings\.yaml/.test(stripHeredocs(entry))
  const writesPatchProviders = /generate_profile_patch|cordis\.patch\.yml.*llm-pi-ai/s.test(entry) || /llm-pi-ai/.test(entry.slice(entry.indexOf('generate_profile_patch')))
  if (writesSettings) {
    assert.ok(writesPatchProviders, 'if a settings.yaml is still written, the patch generator must ALSO carry llm-pi-ai — profile settings.yaml is dead on 0.2.x')
  } else {
    assert.ok(writesPatchProviders, 'with settings.yaml gone, the patch generator must carry llm-pi-ai')
  }
})

// ── 5. contract: env surface declared in .env.example ───────────────────────

test('contract: compose.sdk.yml variables all appear in .env.example with matching defaults', () => {
  const compose = read('compose.sdk.yml')
  const example = read('.env.example')
  const vars = new Map<string, string | undefined>()
  for (const m of compose.matchAll(/\$\{([A-Z_]+)(?::-([^}]*))?\}/g)) vars.set(m[1]!, m[2])
  // the gateway knobs must exist and be documented
  for (const name of ['GATEWAY_PORT', 'GATEWAY_TOKEN', 'GATEWAY_IDLE_MS', 'DSH_ROLE']) {
    assert.ok(vars.has(name), `compose.sdk.yml does not reference ${name}`)
    const declared = new RegExp(`^${name}=(.*)$`, 'm').exec(example)
    assert.ok(declared !== null, `.env.example must declare ${name}`)
    const fallback = vars.get(name)
    if (fallback !== undefined && fallback !== '') {
      assert.equal(declared![1], fallback, `compose default for ${name} drifted from .env.example`)
    }
  }
})

test('contract: compose.sdk.yml keeps the loopback-bind rule and never sets DSH_HOST 0.0.0.0', () => {
  const compose = stripComments(read('compose.sdk.yml'))
  assert.doesNotMatch(compose, /DSH_HOST:\s*"?0\.0\.0\.0/, 'host 0.2.x refuses wildcard binds (RCU safety) — published ports are the exposure path')
  // gateway binds loopback INSIDE the container; the port mapping publishes it
  assert.match(compose, /127\.0\.0\.1|DSH_GATEWAY_BIND/, 'gateway bind must be loopback-in-container')
})

test('contract: compose.sdk.yml runs the same image, shares the sessions volume, and owns NO vllm (#27)', () => {
  const compose = read('compose.sdk.yml')
  assert.match(compose, /dockerfile: dev\/install\/Dockerfile/, 'sdk stack must reuse the one service image')
  assert.match(compose, /dsh-agent-api:/, 'service named dsh-agent-api must exist')
  assert.match(compose, /DSH_ROLE:\s*(?:"?gateway"|\$\{DSH_ROLE:-gateway\})/, 'the sdk service must select the gateway role')
  // #27: the model server is an EXTERNAL dependency — another project may
  // already run vLLM on this host. The SDK stack consumes LLM_BASE_URL; it
  // must not build, gate on, or own a vllm service.
  assert.doesNotMatch(compose, /^ {2}vllm:/m, 'compose.sdk.yml must not define a vllm service (it lives in compose.vllm.yml)')
  assert.doesNotMatch(compose, /condition: service_healthy/, 'no owned service may gate the api container — external model servers have no compose health to wait on')
  assert.match(compose, /LLM_BASE_URL: \$\{LLM_BASE_URL:-/, 'the model server arrives through LLM_BASE_URL (env-configurable for external servers)')
})

test('contract: compose.vllm.yml boots the model server standalone (#27)', () => {
  const compose = read('compose.vllm.yml')
  assert.match(compose, /^ {2}vllm:/m, 'standalone file must carry the vllm service')
  assert.match(compose, /dockerfile: vllm\.Dockerfile/, 'same vllm.Dockerfile as the web stack (one argv contract, pinned by dev-install-compose.test.ts)')
  assert.match(compose, /healthcheck[\s\S]{0,200}\/health/, 'vllm keeps its /health probe so `up -d` waits honestly')
  // the GPU-reservation trap from #21: defaults must stay desktop-shareable
  assert.match(compose, /GPU_MEMORY_UTILIZATION: \$\{VLLM_GPU_MEM:-0\.75\}/, 'default GPU memory utilization stays 0.75 (#21)')
})

// ── 6. unit: the gateway relay ───────────────────────────────────────────────

test('unit: gateway module exists and exports the pure relay core', async () => {
  const mod = await import('../../dev/install/sdk-gateway/gateway.ts')
  assert.equal(typeof mod.relayLine, 'function', 'relayLine(socket-line → child-stdin) must be exported')
  assert.equal(typeof mod.childLineToSocket, 'function', 'childLineToSocket must be exported')
  assert.equal(typeof mod.authorizeProtocol, 'function', 'Sec-WebSocket-Protocol auth check must be exported')
  assert.equal(typeof mod.createRuntimeLink, 'function', 'per-connection runtime link factory must be exported')
})

test('unit: authorizeProtocol accepts dsh-auth.<token> and rejects everything else', async () => {
  const { authorizeProtocol } = await import('../../dev/install/sdk-gateway/gateway.ts')
  assert.equal(authorizeProtocol('dsh-auth.s3cret', 's3cret'), true)
  assert.equal(authorizeProtocol('dsh-auth.wrong', 's3cret'), false)
  assert.equal(authorizeProtocol(undefined, 's3cret'), false, 'missing protocol header must refuse')
  assert.equal(authorizeProtocol('chat, dsh-auth.s3cret', 's3cret'), true, 'browser-style multi-protocol lists carry ours second')
  assert.equal(authorizeProtocol('dsh-auth.s3cret', ''), false, 'empty server token must refuse every client (fail closed)')
})

test('unit: relayLine forwards verbatim (framing is the protocol, not ours to touch)', async () => {
  const { relayLine } = await import('../../dev/install/sdk-gateway/gateway.ts')
  const frame = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"cwd":"/w","provider":"local","model":"m"}}'
  assert.equal(relayLine(frame), frame, 'relay must not rewrite frames')
  assert.equal(relayLine(''), null, 'blank lines are not frames — drop, never forward')
  assert.equal(relayLine('  '), null)
})

test('unit: childLineToSocket wraps a raw line into a single socket message', async () => {
  const { childLineToSocket } = await import('../../dev/install/sdk-gateway/gateway.ts')
  assert.equal(childLineToSocket('{"a":1}\n'), '{"a":1}')
  assert.equal(childLineToSocket('{"a":1}'), '{"a":1}', 'unterminated final chunk stays whole')
  assert.equal(childLineToSocket(''), null, 'empty chunk emits nothing')
})

test('unit: createRuntimeLink spawns once, relays both directions, reaps on close', async () => {
  const { createRuntimeLink } = await import('../../dev/install/sdk-gateway/gateway.ts')
  const events: string[] = []
  let spawns = 0
  // fake runtime: echo every request back as a result, then stay open
  const fakeSpawn = () => {
    spawns += 1
    return {
      writeStdin(line: string) { events.push(`to-child:${line}`) },
      onChildLine(handler: (line: string) => void) { this._emit = handler },
      close() { events.push('closed') },
      _emit: undefined as ((line: string) => void) | undefined,
    }
  }
  const link = createRuntimeLink({ spawnRuntime: fakeSpawn, onSocketLine: (l) => events.push(`to-socket:${l}`) })
  link.handleSocketLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
  assert.equal(spawns, 1, 'first socket line spawns the runtime child')
  assert.match(events[0]!, /^to-child:\{"jsonrpc/)
  link.handleSocketLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
  assert.equal(spawns, 1, 'later lines reuse the same child (one connection = one runtime)')
  // child → socket direction relays verbatim
  const child = (link as unknown as { child: ReturnType<typeof fakeSpawn> }).child
  child._emit!('{"jsonrpc":"2.0","id":1,"result":{}}')
  assert.ok(events.some((e) => e === 'to-socket:{"jsonrpc":"2.0","id":1,"result":{}}'), `child frames must reach the socket sink, got: ${events.join(' | ')}`)
  link.close()
  assert.ok(events.includes('closed'), 'close() reaps the child')
})

test('unit: createRuntimeLink reports child death to the socket sink exactly once', async () => {
  const { createRuntimeLink } = await import('../../dev/install/sdk-gateway/gateway.ts')
  let deaths = 0
  const link = createRuntimeLink({
    spawnRuntime: () => ({
      writeStdin() {},
      onChildLine(h: (l: string) => void) { this._emit = h },
      onChildDeath(h: () => void) { this._death = h },
      close() {},
      _emit: undefined as ((l: string) => void) | undefined,
      _death: undefined as (() => void) | undefined,
    }),
    onSocketLine() {},
    onRuntimeGone() { deaths += 1 },
  })
  // lazy spawn: wire the death hook by sending one line first
  link.handleSocketLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
  const child = (link as unknown as { child: { _death?: () => void } }).child
  child._death!()
  child._death!()
  assert.equal(deaths, 1, 'runtime death is one edge, not a stream')
})

test('unit: idle TTL reaps a quiet link and disarms on activity', async () => {
  const { createIdleTimer } = await import('../../dev/install/sdk-gateway/gateway.ts')
  let fired = 0
  const timer = createIdleTimer(50, () => { fired += 1 })
  timer.touch()   // activity at t≈0 must push the deadline to t≈50
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(fired, 0, 'touch() within the window must postpone the reap')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(fired, 1, 'silence past the window reaps once')
  timer.dispose()
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(fired, 1, 'dispose stops the timer entirely')
})

// ── helpers ──────────────────────────────────────────────────────────────────

/** Decode a Dockerfile printf format string ('...' quoted, \n escapes) to text. */
function decodePrintf(instruction: string): string {
  const m = /printf '([^']*)'/.exec(instruction)
  assert.ok(m !== null, 'printf format not found')
  return m[1]!.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/%%/g, '%')
}

/** Remove heredoc bodies (between <<MARKER and MARKER) so redirect detection
 * doesn't match prose inside generated content. */
function stripHeredocs(script: string): string {
  const out: string[] = []
  let marker: string | null = null
  for (const line of script.split('\n')) {
    if (marker !== null) {
      if (line.trim() === marker) marker = null
      continue
    }
    const hd = /<<-?\s*['"]?([A-Z_]+)['"]?/.exec(line)
    if (hd !== null) marker = hd[1]
    out.push(line)
  }
  return out.join('\n')
}
