/**
 * dev/install compose-platform gate (#19).
 *
 * The bug this pins: vllm.Dockerfile shipped an exec-form CMD —
 *   CMD [ "python3", "-m", ..., "--max-model-len", "${MAX_MODEL_LEN}", ... ]
 * Docker performs NO shell interpolation inside a JSON-array command, so the
 * literal string `${MAX_MODEL_LEN}` reached vLLM's argparse and every boot
 * died with `invalid human_readable_int_or_auto value: '${MAX_MODEL_LEN}'`.
 * Because dsh-web/dsh-test gate on `vllm: condition: service_healthy`, one
 * bad image definition took down the whole containerized platform — and CI
 * never saw it because no test read these files.
 *
 * Rows, outside-in:
 *   1. acceptance — `docker compose config` renders the stack without error;
 *      skipped cleanly when docker is absent (e.g. hosted CI runners);
 *   2. regression — no vLLM argument in the CMD is an unexpanded `${...}`
 *      literal (the exact failure text from #19), either via shell-form or
 *      via an entrypoint that expands at runtime;
 *   3. contract — compose.yml passes env into vllm with defaults matching
 *      .env.example, so overrides actually reach the server args.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const DIR = join(import.meta.dirname!, '../../dev/install')
const read = (f: string) => readFileSync(join(DIR, f), 'utf8')

const dockerAvailable = (() => {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('acceptance: docker compose config renders the dev/install stack without error', { skip: !dockerAvailable && 'docker not available on this machine' }, () => {
  const out = execFileSync('docker', ['compose', '-f', join(DIR, 'compose.yml'), 'config'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  // the rendered vllm command must not contain a literal ${VAR} token
  assert.doesNotMatch(out, /\$\{[A-Z_]+\}/, 'rendered compose output still carries an unexpanded ${VAR} literal')
})

test('regression: no vLLM CLI argument is passed as an unexpanded ${...} literal (#19)', () => {
  const dockerfile = read('vllm.Dockerfile')
  // strip comments so the header docs ("Build: docker build …") can't mask anything
  const body = dockerfile.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

  // Find every instruction line that carries flags (--model, --max-model-len, ...)
  const flagLines = body.split('\\\n').filter((chunk) => /--(model|max-model-len|gpu-memory-utilization|tensor-parallel-size|served-model-name)\b/.test(chunk))
  assert.ok(flagLines.length > 0, 'no vLLM launch flags found — did the CMD move to another file?')
  for (const line of flagLines) {
    // '"${MAX_MODEL_LEN}"' as a JSON array element = the #19 failure verbatim
    assert.doesNotMatch(line, /"\$\{[A-Z_]+\}"/, `exec-form literal env var would reach argv unexpanded: ${line.trim()}`)
  }

  // Whatever form it takes, expansion must be real: either a shell-form
  // CMD/ENTRYPOINT (Docker runs it through /bin/sh -c) or a script that
  // expands at runtime.
  const hasShellForm = /^[ \t]*(CMD|ENTRYPOINT)[ \t]+(?!["[])/m.test(body)
  const expandsInScript = /docker-entrypoint\.sh/.test(body) && /\$\{?[A-Z_]+\}?/.test(read('docker-entrypoint.sh'))
  assert.ok(hasShellForm || expandsInScript, 'vLLM args are not expanded anywhere — literal ${VAR} strings will reach argv')

  // vLLM ≥ 0.31 hard-fails boot on `--enable-auto-tool-choice` without a named
  // parser ("requires --tool-call-parser"). Qwen3's chat template emits the
  // hermes-style <tool_call>{"name":...} format, so hermes is the
  // correct parser — and it must be spelled exactly as vLLM registers it.
  if (/--enable-auto-tool-choice/.test(body)) {
    const parsers = [...body.matchAll(/--tool-call-parser\s+(\S+)/g)].map((m) => m[1]!)
    assert.ok(parsers.length > 0, '--enable-auto-tool-choice without --tool-call-parser kills every boot')
    assert.deepEqual(parsers, ['hermes'], `unexpected tool-call parser(s): ${parsers}`)
  }

  // `--served-model-name` is VARIADIC (nargs="+"), NOT append. Measured against
  // vLLM 0.31's real parser: repeated flags make argparse keep only the LAST
  // value (one alias served, the other 404s); a single "a,b" value registers
  // one alias literally named "a,b" (both bare names 404). The only correct
  // form is ONE flag with space-separated values expanding unquoted into argv.
  assert.match(body, /--served-model-name \$SERVED_NAMES/, 'exactly one --served-model-name flag with an unquoted, space-separated $SERVED_NAMES')
  assert.doesNotMatch(body, /for n in .*SERVED_NAMES/, 'repeated --served-model-name flags: argparse keeps only the last value')
  const servedEnv = body.match(/^ENV\s+SERVED_NAMES=(.*)$/m)?.[1] ?? ''
  assert.ok(!servedEnv.includes(','), `ENV SERVED_NAMES must be space-separated, got: ${servedEnv}`)

  // The base image ships ENTRYPOINT ["vllm","serve"]; an exec-form ENTRYPOINT
  // here would swallow the shell-form CMD entirely (the python module never
  // runs). Overriding it empty is the contract.
  const entrypoints = [...body.matchAll(/^ENTRYPOINT(.*)$/gm)].map((m) => m[1]!.trim())
  assert.deepEqual(entrypoints, ['[]'], 'vllm.Dockerfile must carry exactly `ENTRYPOINT []` to clear the base image launcher')
})

test('contract: compose.yml feeds vllm env with defaults matching .env.example', () => {
  const compose = read('compose.yml')
  const example = read('.env.example')

  const composeEnv = Object.fromEntries(
    [...compose.matchAll(/^\s{6}(MODEL_ID|SERVED_NAMES|MAX_MODEL_LEN|GPU_MEMORY_UTILIZATION|TENSOR_PARALLEL_SIZE):\s*\$\{([A-Z_]+)(?::-([^}]*))?\}/gm)]
      .map((m) => [m[1]!, { hostVar: m[2]!, fallback: m[3] }]),
  )
  assert.deepEqual(Object.keys(composeEnv).sort(), ['GPU_MEMORY_UTILIZATION', 'MAX_MODEL_LEN', 'MODEL_ID', 'SERVED_NAMES', 'TENSOR_PARALLEL_SIZE'])

  for (const [containerVar, { hostVar, fallback }] of Object.entries(composeEnv)) {
    const declared = example.match(new RegExp(`^${hostVar}=(.*)$`, 'm'))
    if (declared && fallback !== undefined) {
      assert.equal(fallback, declared[1], `compose default for ${containerVar} drifted from .env.example ${hostVar}`)
    }
  }
  // the two knobs the #19 crash turned on must have numeric fallbacks, not empty ones
  assert.equal(composeEnv.MAX_MODEL_LEN!.fallback, '32768')
  assert.equal(composeEnv.GPU_MEMORY_UTILIZATION!.fallback, '0.75')
})

test('contract: every variable the CMD expands has an ENV default (docker run alone works)', () => {
  const dockerfile = read('vllm.Dockerfile')
  // ignore prose inside comments — only instructions can expand at runtime
  const body = dockerfile.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  const shellVars = new Set([...body.matchAll(/\$(?:\{([A-Z_]+)\}|([A-Z_]{3,})\b)/g)].map((m) => m[1] ?? m[2]!))
  // $@ is the loop accumulator; OLDIFS/IFS are shell internals, not config —
  // only variables that must come from ENV/compose need defaults.
  const used = new Set([...shellVars].filter((v) => !['@', 'IFS', 'OLDIFS'].includes(v)))
  assert.ok(used.size >= 4, 'expected the launch args to read at least four env vars')

  // ENV keys may be quoted (ENV X="a,b"); a bare `${VAR}` in argv with no ENV
  // default expands to empty and argparse dies again.
  const setByEnv = new Set([...body.matchAll(/^ENV\s+([A-Z_]+)=/gm)].map((m) => m[1]!))
  for (const v of used) {
    assert.ok(setByEnv.has(v), `$${v} is expanded by the CMD but no ENV line gives it a build-time default`)
  }

  // compose must ALSO feed each of these with a :-fallback so host overrides win
  const compose = read('compose.yml')
  for (const v of used) {
    assert.ok(new RegExp(`\\b${v}:\\s*\\$\\{[A-Z_]+:-[^}]+\\}`).test(compose), `compose.yml does not pass ${v} with a :-default`)
  }
})

test('regression: dsh-web launches with the 0.2.x launcher form and a loopback bind (#19)', () => {
  const entry = read('docker-entrypoint.sh')
  // Host 0.2.x boots a profile as `dsh web …`; the old `dsh --profile web web`
  // form dies at exec with "too many arguments ... web" — a restart loop that
  // kept dsh-web from ever serving.
  assert.doesNotMatch(entry, /dsh --profile web web/, 'the 0.2.x launcher rejects "--profile web web" (too many arguments)')
  assert.match(entry, /exec dsh web \\/, 'entrypoint must boot the web profile with `exec dsh web \\`')

  // 0.2.x refuses --host 0.0.0.0 for RCE safety (dsh-web-app startup.js); the
  // published port mapping is what makes the UI reachable from the host.
  assert.match(entry, /DSH_HOST="\$\{DSH_HOST:-127\.0\.0\.1\}"/, 'default DSH_HOST must be loopback; 0.0.0.0 aborts the boot')
  const compose = read('compose.yml')
  assert.doesNotMatch(compose, /DSH_HOST:\s*"?0\.0\.0\.0/, 'compose must not set DSH_HOST to 0.0.0.0 — the host refuses it')

  // A bind-mounted or wiped $DSH_HOME may lack profiles/web; the composed
  // cordis.patch.yml is written by redirect and dies on ENOENT without the
  // mkdir (#25 moved config delivery from settings.yaml to the patch — a
  // profile-dir settings.yaml is read by NOTHING on 0.2.x).
  assert.match(entry, /mkdir -p "\$profile_dir"|generate_profile_patch/, 'entrypoint must create the profile dir before writing its patch')
})

test('regression: web healthcheck probes something that can go green on host 0.2.x (#19)', () => {
  // Measured: /api/health returns 404 even authenticated on 0.2.0-rc.2, and the
  // SPA index answers 401 until a browser completes the token exchange — an
  // HTTP-status probe from inside the container can never go green. The fix is
  // a TCP connect probe (node ships in this image).
  const dockerfile = read('Dockerfile')
  const compose = read('compose.yml')
  for (const [name, text] of [['Dockerfile', dockerfile], ['compose.yml', compose]] as const) {
    assert.doesNotMatch(text, /curl[^\n]*\/api\/health/, `${name} still probes /api/health, which 404s on host 0.2.x`)
    assert.doesNotMatch(text, /curl -fsS[^\n]*localhost:3080\//, `${name} still probes the SPA index over HTTP, which 401s pre-auth`)
  }
  // The probe lives inside a shell-form CMD whose node -e string is
  // double-quoted, so its inner quotes are backslash-escaped on disk.
  assert.match(dockerfile, /HEALTHCHECK[\s\S]{0,600}require\(\\"net\\"\)[\s\S]*connect\(3080,\\"127\.0\.0\.1\\"/, 'Dockerfile HEALTHCHECK must keep a TCP connect probe to 3080 for the web role (#25 made it role-aware; the gateway branch may not replace this one)')
  assert.match(compose, /test: \["CMD", "node", "-e"[^\n]*\\"net\\"[^\n]*connect\(3080,\\"127\.0\.0\.1\\"/, 'compose healthcheck must be a TCP connect probe to 3080')
})

test('regression: profile package.json survives the legacy builder (#19)', () => {
  // The classic (non-BuildKit) builder joins multi-line RUN continuations with
  // " && \\\n", so a trailing `<<EOF` heredoc never receives its body: the
  // manifest landed ZERO BYTES and every boot died at JSON.parse in a restart
  // loop. printf is one logical line and works under both builders.
  const dockerfile = read('Dockerfile')
  assert.doesNotMatch(dockerfile, /RUN cat > .*package\.json <</, 'heredoc in a continued RUN writes an empty file on the legacy builder')
  assert.match(dockerfile, /RUN printf .* > "\$\{PROFILE_DIR\}\/package\.json"/, 'profile manifest must be written with single-line printf')

  // Belt and braces: the entrypoint repairs a zero-byte manifest (never a real
  // one) so already-built bad images recover instead of crash-looping. #25
  // generalized the repair to every profile dir (web + sdk) — a loop over
  // profiles/*/package.json satisfies the same contract for both.
  const entry = read('docker-entrypoint.sh')
  assert.match(
    entry,
    /\[ ! -s "\$PROFILE_DIR\/package\.json" \][\s\S]*rm -f|\$DSH_HOME\/profiles"\/\*\/package\.json[\s\S]*\[ ! -s "\$p" \][\s\S]*rm -f/,
    'entrypoint must delete a zero-byte manifest so app-boot re-initializes it',
  )

  // A named volume mounted at a FILE path is created as an empty mode-755
  // directory when the image has no file there; credentials-local refuses any
  // world-readable document → permanent restart loop. No volume may sit on
  // .credentials.yaml; the entrypoint seeds it with mode 600 instead.
  const compose = read('compose.yml')
  assert.doesNotMatch(compose, /volumes:[\s\S]{0,400}\.credentials\.yaml/, 'compose must not mount a volume at the credentials FILE path')
  assert.match(entry, /umask 077[\s\S]*chmod 600 "\$CREDENTIALS_FILE"/, 'entrypoint must seed .credentials.yaml owner-only (600)')
})
